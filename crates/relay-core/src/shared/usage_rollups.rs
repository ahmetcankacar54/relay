//! Port of `shared/usage-rollups.ts`: usage samples folded into hourly points, coverage,
//! five-hour windows and limit hits, kept for 90 days.

// `!(a < b)` is kept where the TS writes it: it is also true when either side is NaN.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

use serde::{Deserialize, Serialize};

use super::types::js::{JsMap, date_parse, iso, ser_num};
use super::types::{UsageWindow, literal_enum};
use super::usage_statistics::{MAX_USAGE_GAP_MS, UsageSample};

pub const ROLLUP_DAYS: f64 = 90.0;
const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
const FIVE_HOURS_MS: f64 = 5.0 * HOUR_MS;
/// Reported reset times jitter slightly between polls of the same window.
const RESET_TOLERANCE_MS: f64 = 120_000.0;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HourRollup {
    #[serde(serialize_with = "ser_num")]
    pub points: f64,
    #[serde(serialize_with = "ser_num")]
    pub windows: f64,
    #[serde(serialize_with = "ser_num")]
    pub covered_minutes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub reset_at: String,
    #[serde(serialize_with = "ser_num")]
    pub max_percent: f64,
}

literal_enum!(LimitHitKind { FiveHour = "five-hour", Weekly = "weekly" });

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitHit {
    pub identity: String,
    pub kind: LimitHitKind,
    pub at: String,
    /// Set when the hit is made; `until` is added later, so it is written after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<String>,
}

fn version_two() -> u32 {
    2
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRollups {
    /// 2: coverage counts every polled gap, split across the hours it spans.
    #[serde(default = "version_two")]
    pub version: u32,
    /// identity → UTC hour start ISO → rollup
    pub hours: JsMap<JsMap<HourRollup>>,
    /// identity → observed five-hour windows
    pub windows: JsMap<Vec<WindowRecord>>,
    pub hits: Vec<LimitHit>,
    /// identity → last folded sample, the baseline for the next increase
    pub last: JsMap<UsageSample>,
}

impl Default for UsageRollups {
    fn default() -> Self {
        empty_rollups()
    }
}

pub fn empty_rollups() -> UsageRollups {
    UsageRollups {
        version: 2,
        hours: JsMap::new(),
        windows: JsMap::new(),
        hits: Vec::new(),
        last: JsMap::new(),
    }
}

/// The UTC hour `time` falls in, as an ISO string.
pub fn hour_key(time: f64) -> String {
    iso((time / HOUR_MS).floor() * HOUR_MS)
}

/// A usable five-hour window resets in (checkedAt, checkedAt + 5h].
pub fn valid_window(sample: &UsageSample) -> bool {
    let Some(reset) = sample
        .five_hour
        .as_ref()
        .and_then(|w| w.resets_at.as_deref())
        .filter(|r| !r.is_empty())
    else {
        return false;
    };
    let checked_at = date_parse(&sample.checked_at);
    let reset_at = date_parse(reset);
    reset_at > checked_at && reset_at <= checked_at + FIVE_HOURS_MS
}

pub fn same_reset(a: &str, b: &str) -> bool {
    (date_parse(a) - date_parse(b)).abs() <= RESET_TOLERANCE_MS
}

fn round2(value: f64) -> f64 {
    super::types::js::round(value * 100.0) / 100.0
}

fn add_coverage(hours: &mut JsMap<HourRollup>, from: f64, to: f64) {
    let mut at = from;
    while at < to {
        let end = to.min(((at / HOUR_MS).floor() + 1.0) * HOUR_MS);
        let hour = hours.entry_or_insert_with(&hour_key(at), HourRollup::default);
        // A clamped last check can overlap covered minutes; an hour has only 60.
        hour.covered_minutes = 60f64.min(round2(hour.covered_minutes + (end - at) / 60_000.0));
        at = end;
    }
}

fn fold_hits(r: &mut UsageRollups, s: &UsageSample, t: f64) {
    let kinds: [(LimitHitKind, Option<&UsageWindow>); 2] = [
        (LimitHitKind::FiveHour, s.five_hour.as_ref()),
        (LimitHitKind::Weekly, s.seven_day.as_ref()),
    ];
    for (kind, window) in kinds {
        let open = r
            .hits
            .iter()
            .rposition(|hit| hit.identity == s.identity && hit.kind == kind);
        let mut is_open = open.is_some_and(|i| r.hits[i].until.is_none());
        if is_open {
            let hit = &mut r.hits[open.expect("open")];
            // Like its window record, an open hit follows a drifting reset.
            if let (Some(window_reset), Some(hit_reset)) = (
                window
                    .and_then(|w| w.resets_at.as_deref())
                    .filter(|x| !x.is_empty()),
                hit.reset_at.as_deref().filter(|x| !x.is_empty()),
            ) && same_reset(hit_reset, window_reset)
            {
                hit.reset_at = Some(window_reset.to_string());
            }
            let reset_at = match hit.reset_at.as_deref().filter(|x| !x.is_empty()) {
                Some(reset) => date_parse(reset),
                None => f64::INFINITY,
            };
            // A passed reset closes the hit even if this poll lacks that window.
            if window.is_some_and(|w| w.used_percent < 100.0) || t >= reset_at {
                // Never before it opened: after a clamp, a sample can precede the hit.
                let until = t.min(reset_at);
                hit.until = Some(if until < date_parse(&hit.at) {
                    hit.at.clone()
                } else {
                    iso(until)
                });
                is_open = false;
            }
        }
        let Some(window) = window else { continue };
        let pct = window.used_percent;
        // A window whose reset has already passed reports stale quota.
        let expired = window
            .resets_at
            .as_deref()
            .is_some_and(|r| date_parse(r) <= t);
        if !is_open && pct >= 100.0 && !expired {
            r.hits.push(LimitHit {
                identity: s.identity.clone(),
                kind,
                at: s.checked_at.clone(),
                until: None,
                reset_at: window.resets_at.clone().filter(|x| !x.is_empty()),
            });
        }
    }
}

/// `Date.parse(text) >= cutoff`, false for an unparsable time as JavaScript compares `NaN`.
fn not_before(text: &str, cutoff: f64) -> bool {
    date_parse(text) >= cutoff
}

fn prune(r: &mut UsageRollups, now: f64) {
    let cutoff = now - ROLLUP_DAYS * DAY_MS;
    let identities: Vec<String> = r.hours.keys().cloned().collect();
    for identity in identities {
        let hours = r.hours.get_mut(&identity).expect("listed");
        // `Date.parse(key) < cutoff` deletes; an unparsable key stays.
        hours.retain(|key, _| !(date_parse(key) < cutoff));
        if hours.is_empty() {
            r.hours.remove(&identity);
        }
    }
    let identities: Vec<String> = r.windows.keys().cloned().collect();
    for identity in identities {
        let kept: Vec<WindowRecord> = r
            .windows
            .get(&identity)
            .expect("listed")
            .iter()
            .filter(|w| not_before(&w.reset_at, cutoff))
            .cloned()
            .collect();
        if kept.is_empty() {
            r.windows.remove(&identity);
        } else {
            r.windows.insert(identity, kept);
        }
    }
    r.hits.retain(|hit| not_before(&hit.at, cutoff));
    r.last
        .retain(|_, sample| !(date_parse(&sample.checked_at) < cutoff));
}

/// Folds one sample into the rollups and returns the new rollups. Points are increases over the
/// window's high-water mark between consecutive samples of one identity in the same five-hour
/// window, at most `MAX_USAGE_GAP_MS` apart. Coverage credits each UTC hour the polled minutes
/// inside it, at most 60. Last samples stamped later than `now` are clamped to it first.
pub fn fold_sample(r: &UsageRollups, s: &UsageSample, now: f64) -> UsageRollups {
    let mut next = with_last_clamped(r, now);
    if !accepts(&next, s) {
        return next;
    }
    fold_into(&mut next, s);
    prune(&mut next, now);
    next
}

/// Moves the check time of last samples stamped later than `now` (the clock moved back) to `now`.
fn with_last_clamped(r: &UsageRollups, now: f64) -> UsageRollups {
    let mut next = r.clone();
    let checked_at = iso(now);
    for sample in next.last.values_mut() {
        if date_parse(&sample.checked_at) > now {
            sample.checked_at = checked_at.clone();
        }
    }
    next
}

/// Out-of-order and duplicate samples (per identity) are ignored.
fn accepts(r: &UsageRollups, s: &UsageSample) -> bool {
    let t = date_parse(&s.checked_at);
    let prev = r.last.get(&s.identity);
    t.is_finite() && !prev.is_some_and(|p| date_parse(&p.checked_at) >= t)
}

fn fold_into(next: &mut UsageRollups, s: &UsageSample) {
    let t = date_parse(&s.checked_at);
    let prev = next.last.get(&s.identity).cloned();
    let hours = next.hours.entry_or_insert_with(&s.identity, JsMap::new);
    let key = hour_key(t);
    hours.entry_or_insert_with(&key, HourRollup::default);
    let gap = prev
        .as_ref()
        .map_or(f64::INFINITY, |p| t - date_parse(&p.checked_at));
    if gap > 0.0 && gap <= MAX_USAGE_GAP_MS {
        add_coverage(
            hours,
            date_parse(&prev.as_ref().expect("gap is finite").checked_at),
            t,
        );
    }
    if valid_window(s) {
        let five = s.five_hour.as_ref().expect("valid window");
        let reset = five.resets_at.clone().expect("valid window");
        let pct = five.used_percent;
        let windows = next.windows.entry_or_insert_with(&s.identity, Vec::new);
        // Windows are appended in time order, so a match is almost always last.
        let found = windows
            .iter()
            .rposition(|w| same_reset(&w.reset_at, &reset));
        let hour = next
            .hours
            .get_mut(&s.identity)
            .and_then(|h| h.get_mut(&key))
            .expect("created above");
        let index = match found {
            Some(i) => i,
            None => {
                windows.push(WindowRecord {
                    reset_at: reset.clone(),
                    max_percent: pct,
                });
                hour.windows += 1.0;
                windows.len() - 1
            }
        };
        let record = &mut windows[index];
        // Follow the latest reported reset so monotonic drift stays one window.
        record.reset_at = reset.clone();
        let high = record.max_percent;
        if let Some(prev) = &prev
            && valid_window(prev)
            && same_reset(
                prev.five_hour
                    .as_ref()
                    .and_then(|w| w.resets_at.as_deref())
                    .unwrap_or(""),
                &reset,
            )
            && gap > 0.0
            && gap <= MAX_USAGE_GAP_MS
        {
            hour.points = round2(hour.points + 0f64.max(pct - high));
        }
        record.max_percent = high.max(pct);
    }
    fold_hits(next, s, t);
    next.last.insert(s.identity.clone(), s.clone());
}

/// Backfill: folds samples per identity in time order from empty rollups.
pub fn fold_samples(samples: &[UsageSample], now: f64) -> UsageRollups {
    catch_up(&empty_rollups(), samples, now)
}

/// Folds every sample newer than its identity's last folded sample, in identity and time order,
/// and prunes once. Last samples stamped later than `now` are clamped to it first.
pub fn catch_up(r: &UsageRollups, samples: &[UsageSample], now: f64) -> UsageRollups {
    let mut next = with_last_clamped(r, now);
    let mut pending: Vec<&UsageSample> = samples.iter().filter(|s| accepts(&next, s)).collect();
    super::types::js::sort_by(&mut pending, |a, b| {
        if a.identity == b.identity {
            date_parse(&a.checked_at) - date_parse(&b.checked_at)
        } else if super::types::js::compare_str(&a.identity, &b.identity) < 0.0 {
            -1.0
        } else {
            1.0
        }
    });
    if pending.is_empty() {
        return next;
    }
    for sample in pending {
        if accepts(&next, sample) {
            fold_into(&mut next, sample);
        }
    }
    prune(&mut next, now);
    next
}
