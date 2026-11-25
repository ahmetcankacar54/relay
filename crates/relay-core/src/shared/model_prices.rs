//! Port of `shared/model-prices.ts`: Anthropic API list prices, hand-maintained.

pub const PRICES_CHECKED: &str = "2026-11-11";
pub const PRICES_SOURCE: &str = "https://platform.claude.com/docs/en/about-claude/pricing";

/// USD per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rates {
    input: f64,
    write5m: f64,
    write1h: f64,
    read: f64,
    output: f64,
}

#[derive(Debug, Clone, Copy)]
struct ModelPrice {
    rates: Rates,
    /// Fast mode's input and output; the cache rates scale with input.
    fast: Option<(f64, f64)>,
    /// Higher rates for a prompt (input + cache write + cache read) above `.0` tokens.
    long_prompt: Option<(f64, Rates)>,
    /// US-only inference costs 1.1× (Claude 4.6 and later).
    us_geo: bool,
}

const fn rates(input: f64, write5m: f64, write1h: f64, read: f64, output: f64) -> Rates {
    Rates { input, write5m, write1h, read, output }
}

const fn price(rates: Rates, us_geo: bool) -> ModelPrice {
    ModelPrice { rates, fast: None, long_prompt: None, us_geo }
}

const FABLE_5_2: ModelPrice = ModelPrice { fast: Some((16.0, 80.0)), ..price(rates(8.0, 10.0, 16.0, 0.2, 40.0), true) };
const FABLE_5_1: ModelPrice = price(rates(10.0, 12.5, 20.0, 0.25, 50.0), true);
const FABLE_5: ModelPrice = price(rates(10.0, 12.5, 20.0, 1.0, 50.0), true);
const OPUS_5_5: ModelPrice = ModelPrice { fast: Some((8.0, 40.0)), ..price(rates(4.0, 5.0, 8.0, 0.2, 20.0), true) };
const OPUS_5: ModelPrice = ModelPrice { fast: Some((10.0, 50.0)), ..price(rates(5.0, 6.25, 10.0, 0.5, 25.0), true) };
const OPUS_4_6: ModelPrice = price(rates(5.0, 6.25, 10.0, 0.5, 25.0), true);
const OPUS_4_5: ModelPrice = price(rates(5.0, 6.25, 10.0, 0.5, 25.0), false);
const OPUS_4: ModelPrice = price(rates(15.0, 18.75, 30.0, 1.5, 75.0), false);
const SONNET_5_5: ModelPrice = price(rates(2.0, 2.5, 4.0, 0.1, 10.0), true);
const SONNET_5: ModelPrice = price(rates(2.0, 2.5, 4.0, 0.2, 10.0), true);
const SONNET_4_6: ModelPrice = price(rates(3.0, 3.75, 6.0, 0.3, 15.0), true);
const SONNET_4: ModelPrice = price(rates(3.0, 3.75, 6.0, 0.3, 15.0), false);
const HAIKU_5_5: ModelPrice = ModelPrice {
    long_prompt: Some((100_000.0, rates(0.5, 0.625, 1.0, 0.05, 2.5))),
    ..price(rates(0.1, 0.125, 0.2, 0.01, 0.5), true)
};
const HAIKU_4_5: ModelPrice = price(rates(1.0, 1.25, 2.0, 0.1, 5.0), false);
const HAIKU_3_5: ModelPrice = price(rates(0.8, 1.0, 1.6, 0.08, 4.0), false);

const PRICES: &[(&str, ModelPrice)] = &[
    ("claude-fable-5-2", FABLE_5_2),
    ("claude-mythos-5-2", FABLE_5_2),
    ("claude-fable-5-1", FABLE_5_1),
    ("claude-mythos-5-1", FABLE_5_1),
    ("claude-fable-5", FABLE_5),
    ("claude-mythos-5", FABLE_5),
    ("claude-opus-5-5", OPUS_5_5),
    ("claude-opus-5", OPUS_5),
    ("claude-opus-4-8", OPUS_5),
    ("claude-opus-4-7", OPUS_4_6),
    ("claude-opus-4-6", OPUS_4_6),
    ("claude-opus-4-5", OPUS_4_5),
    ("claude-opus-4-1", OPUS_4),
    ("claude-opus-4", OPUS_4),
    ("claude-sonnet-5-5", SONNET_5_5),
    ("claude-sonnet-5", SONNET_5),
    ("claude-sonnet-4-6", SONNET_4_6),
    ("claude-sonnet-4-5", SONNET_4),
    ("claude-sonnet-4", SONNET_4),
    ("claude-haiku-5-5", HAIKU_5_5),
    ("claude-haiku-4-5", HAIKU_4_5),
    ("claude-3-5-haiku", HAIKU_3_5),
];

fn lookup(key: &str) -> Option<&'static ModelPrice> {
    PRICES.iter().find(|(k, _)| *k == key).map(|(_, p)| p)
}

/// One response's usage, as its transcript row reports it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ResponseUsage {
    pub input: f64,
    pub output: f64,
    /// All cache writes, 5-minute and 1-hour.
    pub cache_write: f64,
    pub cache_read: f64,
    /// The 1-hour part of `cache_write`, when the row splits it; absent means all 5-minute.
    pub cache_write_1h: Option<f64>,
    /// `usage.speed`: "fast" is priced at fast mode's rates.
    pub speed: Option<String>,
    /// `usage.inference_geo`: "us" costs 1.1×.
    pub geo: Option<String>,
}

/// `model` without a trailing `[…]` suffix (`/\[[^\]]*\]$/`: from the first `[` after the
/// last inner `]`).
pub(crate) fn strip_bracket_suffix(model: &str) -> &str {
    let Some(inner) = model.strip_suffix(']') else {
        return model;
    };
    let from = inner.rfind(']').map_or(0, |i| i + 1);
    match inner[from..].find('[') {
        Some(open) => &model[..from + open],
        None => model,
    }
}

/// `model` without a trailing `-YYYYMMDD`.
fn strip_date_suffix(model: &str) -> &str {
    let bytes = model.as_bytes();
    if bytes.len() >= 9 {
        let tail = &bytes[bytes.len() - 9..];
        if tail[0] == b'-' && tail[1..].iter().all(u8::is_ascii_digit) {
            return &model[..model.len() - 9];
        }
    }
    model
}

/// The table's id for a model: a trailing date (`-20251001`) and a `[…]` suffix are dropped.
pub fn price_key(model: &str) -> Option<String> {
    let bare = js_trim(strip_date_suffix(strip_bracket_suffix(model)));
    lookup(bare).map(|_| bare.to_string())
}

/// JS `String.prototype.trim` (Unicode white space and line terminators).
pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn scaled(base: Rates, input: f64, output: f64) -> Rates {
    let factor = input / base.input;
    Rates {
        input,
        write5m: base.write5m * factor,
        write1h: base.write1h * factor,
        read: base.read * factor,
        output,
    }
}

/// What one response would cost on the API, in USD; `None` for a model with no price.
pub fn response_cost(model: &str, usage: &ResponseUsage) -> Option<f64> {
    let price = lookup(&price_key(model)?)?;
    let prompt = usage.input + usage.cache_write + usage.cache_read;
    let mut r = match price.long_prompt {
        Some((above, rates)) if prompt > above => rates,
        _ => price.rates,
    };
    if usage.speed.as_deref() == Some("fast")
        && let Some((input, output)) = price.fast
    {
        r = scaled(r, input, output);
    }
    let write1h = usage.cache_write_1h.unwrap_or(0.0).min(usage.cache_write);
    let write5m = usage.cache_write - write1h;
    let cost = (usage.input * r.input
        + write5m * r.write5m
        + write1h * r.write1h
        + usage.cache_read * r.read
        + usage.output * r.output)
        / 1_000_000.0;
    Some(if usage.geo.as_deref() == Some("us") && price.us_geo { cost * 1.1 } else { cost })
}

/// The sums `estimate_cost` prices.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct TokenCounts {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// A cost for tokens counted before responses were priced, from a bucket's sums: every cache
/// write as a 1-hour write, which is what current Claude Code writes, and Haiku 5.5 at its lower
/// tier.
pub fn estimate_cost(model: &str, counts: &TokenCounts) -> Option<f64> {
    let r = lookup(&price_key(model)?)?.rates;
    Some(
        (counts.input * r.input + counts.cache_write * r.write1h + counts.cache_read * r.read + counts.output * r.output)
            / 1_000_000.0,
    )
}
