//! Gateway overflow (`shared/overflow.ts`): when every subscription account is at a limit,
//! Claude Messages requests go to an API-key upstream instead of failing; a daily spending cap
//! bounds what it costs. Also the planning-day arithmetic it needs (`shared/planning.ts`).

use crate::model_prices::{ResponseUsage, response_cost};
use crate::types::{
    ApiUpstream, ApiUpstreamAuth, ApiUpstreamPreset, OverflowCost, OverflowModelMap, OverflowRates,
    TokenTally, UserPrices,
};
use chrono::{Datelike, NaiveDate, NaiveTime, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Tz;

/// The cap a new setup starts with: the page asks for one before overflow is turned on.
pub const DEFAULT_OVERFLOW_CAP_USD: f64 = 5.0;

/// One preset's defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct OverflowPreset {
    pub label: &'static str,
    pub base_url: &'static str,
    pub auth_style: ApiUpstreamAuth,
    pub model_map: OverflowModelMap,
}

fn map(opus: &str, sonnet: &str, haiku: &str, default: Option<&str>) -> OverflowModelMap {
    OverflowModelMap {
        opus: Some(opus.into()),
        sonnet: Some(sonnet.into()),
        haiku: Some(haiku.into()),
        default: default.map(Into::into),
    }
}

/// `OVERFLOW_PRESETS`: model ids and URLs from the providers' Claude Code guides (2026-11).
pub fn overflow_preset(preset: ApiUpstreamPreset) -> OverflowPreset {
    use ApiUpstreamAuth::*;
    use ApiUpstreamPreset::*;
    let (label, base_url, auth_style, model_map) = match preset {
        // The same ids as Claude Code asks for: nothing to rewrite.
        Anthropic => (
            "Anthropic API",
            "https://api.anthropic.com",
            XApiKey,
            OverflowModelMap::default(),
        ),
        OpenRouter => (
            "OpenRouter",
            "https://openrouter.ai/api",
            Bearer,
            map(
                "anthropic/claude-opus-5.5",
                "anthropic/claude-sonnet-5.5",
                "anthropic/claude-haiku-5.5",
                None,
            ),
        ),
        DeepSeek => (
            "DeepSeek",
            "https://api.deepseek.com/anthropic",
            XApiKey,
            map(
                "deepseek-v4-pro",
                "deepseek-flash",
                "deepseek-flash",
                Some("deepseek-flash"),
            ),
        ),
        // K2 closes to new users from 2026-10-31 and retires at the end of 2026.
        Kimi => (
            "Kimi",
            "https://api.moonshot.ai/anthropic",
            Bearer,
            map(
                "kimi-k3.1-pro",
                "kimi-k3.1-pro",
                "kimi-k3",
                Some("kimi-k3.1-pro"),
            ),
        ),
        KimiCn => (
            "Kimi (China)",
            "https://api.moonshot.cn/anthropic",
            Bearer,
            map(
                "kimi-k3.1-pro",
                "kimi-k3.1-pro",
                "kimi-k3",
                Some("kimi-k3.1-pro"),
            ),
        ),
        Glm => (
            "Z.ai GLM",
            "https://api.z.ai/api/anthropic",
            Bearer,
            map("glm-5.4", "glm-5.4", "glm-5.3-flash", Some("glm-5.4")),
        ),
        GlmCn => (
            "Zhipu GLM (China)",
            "https://open.bigmodel.cn/api/anthropic",
            Bearer,
            map("glm-5.4", "glm-5.4", "glm-5.3-flash", Some("glm-5.4")),
        ),
        Custom => ("Custom", "", XApiKey, OverflowModelMap::default()),
    };
    OverflowPreset {
        label,
        base_url,
        auth_style,
        model_map,
    }
}

/// The Claude model families a request is mapped by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverflowFamily {
    Opus,
    Sonnet,
    Haiku,
}

/// A model id without the `[1m]`-style suffix Claude Code adds for long context, lowercased.
fn bare(model: &str) -> String {
    crate::model_prices::SUFFIX
        .replace(model, "")
        .trim()
        .to_lowercase()
}

/// The Claude family a requested model belongs to, by name.
pub fn overflow_family(model: &str) -> Option<OverflowFamily> {
    let id = bare(model);
    if id.contains("opus") {
        Some(OverflowFamily::Opus)
    } else if id.contains("sonnet") {
        Some(OverflowFamily::Sonnet)
    } else if id.contains("haiku") {
        Some(OverflowFamily::Haiku)
    } else {
        None
    }
}

/// The model id the upstream is asked for: its family's mapping, else its default, else the
/// request's own.
pub fn overflow_model(model_map: &OverflowModelMap, requested: &str) -> String {
    let family = match overflow_family(requested) {
        Some(OverflowFamily::Opus) => model_map.opus.as_deref(),
        Some(OverflowFamily::Sonnet) => model_map.sonnet.as_deref(),
        Some(OverflowFamily::Haiku) => model_map.haiku.as_deref(),
        None => None,
    };
    // `(family && map[family]) || map.default`: an empty mapping falls through too.
    let mapped = family
        .filter(|m| !m.is_empty())
        .or(model_map.default.as_deref());
    match mapped.map(str::trim) {
        Some(m) if !m.is_empty() => m.to_string(),
        _ => bare(requested),
    }
}

const fn table(cache_read: f64, input: f64, output: f64) -> OverflowRates {
    OverflowRates {
        input,
        output,
        cache_read: Some(cache_read),
        cache_write: None,
    }
}

/// DeepSeek's off-peak prices; peak hours cost double.
fn deepseek_rates(id: &str) -> Option<OverflowRates> {
    match id {
        "deepseek-flash" => Some(table(0.003, 0.15, 0.6)),
        "deepseek-v4-pro" => Some(table(0.022, 0.66, 1.98)),
        _ => None,
    }
}

/// Z.ai's prices (GLM-5.4 is not on its page yet: enter its price by hand).
fn glm_rates(id: &str) -> Option<OverflowRates> {
    match id {
        "glm-5.3" => Some(table(0.26, 1.4, 4.4)),
        "glm-5.3-flash" => Some(table(0.03, 0.15, 0.5)),
        "glm-5.3-flashx" => Some(table(0.075, 0.37, 1.25)),
        _ => None,
    }
}

/// DeepSeek's peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday.
pub fn deepseek_peak(at: i64) -> bool {
    let Some(date) = Utc.timestamp_millis_opt(at).single() else {
        return false;
    };
    let weekday = date.weekday();
    let hour = date.hour();
    !matches!(weekday, Weekday::Sat | Weekday::Sun)
        && ((1..4).contains(&hour) || (6..10).contains(&hour))
}

/// The table price of an upstream model at a time, for presets Relay has a table for.
pub fn preset_rates(preset: ApiUpstreamPreset, model: &str, at: i64) -> Option<OverflowRates> {
    let id = bare(model);
    match preset {
        ApiUpstreamPreset::DeepSeek => {
            let base = deepseek_rates(&id)?;
            if !deepseek_peak(at) {
                return Some(base);
            }
            Some(OverflowRates {
                cache_read: base.cache_read.map(|r| r * 2.0),
                input: base.input * 2.0,
                output: base.output * 2.0,
                cache_write: None,
            })
        }
        ApiUpstreamPreset::Glm | ApiUpstreamPreset::GlmCn => glm_rates(&id),
        _ => None,
    }
}

/// What one overflow answer cost, in USD; `None` when no price is known. Anthropic's own keys
/// use its list prices; others the user's prices, then the preset's table, then OpenRouter's
/// published ones (`fetched`). Cache rates a source lacks are charged at its input rate.
pub fn overflow_cost(
    preset: ApiUpstreamPreset,
    prices: Option<UserPrices>,
    model: &str,
    tokens: &TokenTally,
    at: i64,
    fetched: Option<OverflowRates>,
) -> Option<f64> {
    let input = tokens.input.unwrap_or(0.0);
    let output = tokens.output.unwrap_or(0.0);
    let cache_read = tokens.cache_read.unwrap_or(0.0);
    let cache_write = tokens.cache_write.unwrap_or(0.0);
    if preset == ApiUpstreamPreset::Anthropic {
        let listed = response_cost(
            model,
            &ResponseUsage {
                input,
                output,
                cache_read,
                cache_write,
                cache_write_1h: tokens.cache_write_1h,
                ..Default::default()
            },
        );
        if listed.is_some() {
            return listed;
        }
    }
    let rates = prices
        .map(|p| OverflowRates {
            input: p.input,
            output: p.output,
            cache_read: None,
            cache_write: None,
        })
        .or_else(|| preset_rates(preset, model, at))
        .or(fetched)?;
    Some(
        (input * rates.input
            + output * rates.output
            + cache_read * rates.cache_read.unwrap_or(rates.input)
            + cache_write * rates.cache_write.unwrap_or(rates.input))
            / 1_000_000.0,
    )
}

/// `overflowCost` for an upstream.
pub fn upstream_cost(
    upstream: &ApiUpstream,
    model: &str,
    tokens: &TokenTally,
    at: i64,
    fetched: Option<OverflowRates>,
) -> Option<f64> {
    overflow_cost(upstream.preset, upstream.prices, model, tokens, at, fetched)
}

/// A masked key for the page: its first characters and last four, never the rest.
pub fn key_hint(key: &str) -> String {
    let trimmed = key.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if crate::js::units(trimmed) <= 8 {
        return "…".into();
    }
    // `^[a-z]{2,4}-` case-insensitively.
    let letters = chars
        .iter()
        .take(5)
        .take_while(|c| c.is_ascii_alphabetic())
        .count();
    let head: String = if (2..=4).contains(&letters) && chars.get(letters) == Some(&'-') {
        chars[..=letters].iter().collect()
    } else {
        String::new()
    };
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("{head}…{tail}")
}

/// A time zone by IANA name; `None` for one the tz database does not know.
pub fn time_zone(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

/// Whether a zone name is one Relay can plan in (`validTimeZone`).
pub fn valid_time_zone(zone: &str) -> bool {
    let shape = !zone.is_empty()
        && zone.len() <= 100
        && zone.starts_with(|c: char| c.is_ascii_alphabetic())
        && zone
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_+./-".contains(c));
    shape && time_zone(zone).is_some()
}

/// The system's time zone when it is one Relay can plan in, else UTC.
pub fn system_time_zone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|zone| valid_time_zone(zone))
        .unwrap_or_else(|| "UTC".into())
}

fn zone_or_utc(time_zone_name: &str) -> Tz {
    time_zone(time_zone_name).unwrap_or(Tz::UTC)
}

/// The local date (`YYYY-MM-DD`) of `time` in `time_zone`.
pub fn local_date(time: i64, time_zone_name: &str) -> String {
    let tz = zone_or_utc(time_zone_name);
    tz.timestamp_millis_opt(time)
        .single()
        .map(|at| at.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The instant of a wall clock time (`HH:MM`) on a date in a zone: a time a DST change skips
/// is `None`, a repeated one its first occurrence.
pub fn wall_time(date: &str, clock: &str, time_zone_name: &str) -> Option<i64> {
    let valid_clock = clock.len() == 5
        && clock.as_bytes()[2] == b':'
        && clock[..2].parse::<u32>().is_ok_and(|h| h < 24)
        && clock[3..].parse::<u32>().is_ok_and(|m| m < 60)
        && clock
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit());
    if !valid_clock || date.len() != 10 {
        return None;
    }
    let day = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let time = NaiveTime::parse_from_str(clock, "%H:%M").ok()?;
    let tz = zone_or_utc(time_zone_name);
    tz.from_local_datetime(&day.and_time(time))
        .earliest()
        .map(|at| at.timestamp_millis())
}

/// When the local day `at` falls on (in `time_zone`) started and ends, in ms.
pub fn local_day_bounds(at: i64, time_zone_name: &str) -> (i64, i64) {
    let today = local_date(at, time_zone_name);
    let start =
        wall_time(&today, "00:00", time_zone_name).unwrap_or(at - at.rem_euclid(86_400_000));
    // Noon tomorrow in UTC terms always lands on tomorrow's local date, whatever the offset.
    let tomorrow = local_date(start + 36 * 3_600_000, time_zone_name);
    let end = wall_time(&tomorrow, "00:00", time_zone_name).unwrap_or(start + 86_400_000);
    (start, end)
}

/// Overflow spend in the local day `now` falls on, from the priced answers' times and costs.
pub fn spent_today(costs: &[OverflowCost], now: i64, time_zone_name: &str) -> f64 {
    let (start, end) = local_day_bounds(now, time_zone_name);
    let sum: f64 = costs
        .iter()
        .filter(|c| c.at >= start && c.at < end)
        .map(|c| c.cost)
        .sum();
    crate::js::round(sum * 1e6) / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_and_bare_models() {
        assert_eq!(key_hint("short"), "…");
        assert_eq!(key_hint("sk-test-overflow-key-0000-alto"), "sk-…alto");
        assert_eq!(key_hint("abcdefghijk"), "…hijk");
        assert_eq!(bare("Claude-Sonnet-5-5[1m]"), "claude-sonnet-5-5");
    }
}
