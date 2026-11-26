//! Port of `shared/token-usage-view.ts`: the Usage page's token model, built from the ledger.

use std::collections::HashMap;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub use crate::token_ledger::{LedgerSnapshot, TokenCounts};

use super::model_prices::PRICES_CHECKED;
use super::planning::{local_date, local_slot, wall_time};
use super::types::js::{
    JsMap, compare_str, date_parse, iso, number_value, ser_num, ser_opt_num, sort_by,
};
use super::types::{Account, literal_enum};
use super::usage_statistics_view::FORMER_KEY;

const DAY_MS: f64 = 86_400_000.0;

literal_enum!(TokenRowKind { Account = "account", Former = "former", Terminal = "terminal", Unknown = "unknown" });

/// One row of the token table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRow {
    /// The account id, or "former", "terminal" or "unknown"; the key of `days[].byRow`.
    pub key: String,
    pub kind: TokenRowKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    /// The account's name; the other kinds show `token_row_label(kind)`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Some of its tokens in the range were estimated from limit samples.
    pub estimated: bool,
    pub totals: TokenCounts,
}

/// Today so far, for the Bugün card and the widget.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenToday {
    pub date: String,
    /// Today's tokens and cost from the day buckets.
    pub totals: TokenCounts,
    /// The API value of each quarter hour today, in USD; null after the current one.
    #[serde(serialize_with = "ser_opt_nums")]
    pub slots: Vec<Option<f64>>,
    #[serde(serialize_with = "ser_num")]
    pub current_slot: f64,
    /// Today's cost so far against yesterday's up to the same quarter hour; null without a whole yesterday.
    #[serde(serialize_with = "ser_opt_num")]
    pub change: Option<f64>,
    /// Yesterday's API value per quarter hour; null without a whole yesterday.
    #[serde(serialize_with = "ser_opt_num")]
    pub yesterday_average: Option<f64>,
    /// When slots began to be kept, if that was after today began.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_opt_num"
    )]
    pub slots_since: Option<f64>,
}

fn ser_opt_nums<S: serde::Serializer>(
    values: &[Option<f64>],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(values.iter().map(|v| v.map(super::types::js::Num)))
}

/// A day's counts for one row, with whether it was estimated. It is written as the TS builds it:
/// the counts, then `estimated`, then `costEstimated` (added later by `add`).
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct TokenCell {
    #[serde(flatten)]
    pub counts: TokenCounts,
    pub estimated: bool,
}

impl Serialize for TokenCell {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::{Error, SerializeMap};
        let serde_json::Value::Object(mut counts) =
            serde_json::to_value(&self.counts).map_err(S::Error::custom)?
        else {
            return Err(S::Error::custom("counts are an object"));
        };
        let cost_estimated = counts.shift_remove("costEstimated");
        let mut map = serializer.serialize_map(None)?;
        for (k, v) in &counts {
            map.serialize_entry(k, v)?;
        }
        map.serialize_entry("estimated", &self.estimated)?;
        if let Some(v) = cost_estimated {
            map.serialize_entry("costEstimated", &v)?;
        }
        map.end()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenDay {
    pub date: String,
    pub by_row: JsMap<TokenCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenModel {
    pub model: String,
    pub totals: TokenCounts,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TokenProgress {
    #[serde(serialize_with = "ser_num")]
    pub percent: f64,
    pub complete: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageView {
    /// 7, 30 or 90.
    pub range: u32,
    /// Every date of the range, oldest first, ending today in the planning zone.
    pub days: Vec<TokenDay>,
    /// Rows with tokens in the range: accounts and the former row by total, then unknown and terminal.
    pub rows: Vec<TokenRow>,
    pub totals: TokenCounts,
    /// Models by total, largest first.
    pub models: Vec<TokenModel>,
    pub progress: TokenProgress,
    /// The date, in the planning zone, from which Desktop accounts are matched exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exact_since: Option<String>,
    pub today: TokenToday,
    /// Models in the range whose tokens have no price.
    pub unpriced_models: Vec<String>,
    /// The date of the price list.
    pub prices_checked: String,
}

/// What `build_token_usage_view` reads.
#[derive(Debug, Clone, Copy)]
pub struct TokenUsageInput<'a> {
    pub ledger: &'a LedgerSnapshot,
    pub accounts: &'a [Account],
    pub range: u32,
    pub account_id: Option<&'a str>,
    pub zone: &'a str,
    pub now: f64,
    /// When the active-account timeline began to know, epoch milliseconds.
    pub exact_since: Option<f64>,
}

pub const TERMINAL_KEY: &str = "terminal";
pub const UNKNOWN_KEY: &str = "unknown";

/// `TOKEN_ROW_LABELS`: the message ids of the rows that are not a current account.
pub fn token_row_label(kind: TokenRowKind) -> Option<&'static str> {
    match kind {
        TokenRowKind::Former => Some("tokenUsageView.formerAccount"),
        TokenRowKind::Terminal => Some("tokenUsageView.terminalOutsideRelay"),
        TokenRowKind::Unknown => Some("tokenUsageView.unknownAccount"),
        TokenRowKind::Account => None,
    }
}

/// Where a row kind sorts: accounts and the former row by total, then unknown, then terminal.
fn tail(kind: TokenRowKind) -> f64 {
    match kind {
        TokenRowKind::Account | TokenRowKind::Former => 0.0,
        TokenRowKind::Unknown => 1.0,
        TokenRowKind::Terminal => 2.0,
    }
}

fn zero() -> TokenCounts {
    TokenCounts {
        cost: Some(0.0),
        unpriced: Some(0.0),
        ..TokenCounts::default()
    }
}

fn add(to: &mut TokenCounts, from: &TokenCounts) {
    to.input += from.input;
    to.output += from.output;
    to.cache_write += from.cache_write;
    to.cache_read += from.cache_read;
    to.responses += from.responses;
    to.cost = Some(to.cost.unwrap_or(0.0) + from.cost.unwrap_or(0.0));
    to.unpriced = Some(to.unpriced.unwrap_or(0.0) + from.unpriced.unwrap_or(0.0));
    if from.cost_estimated == Some(true) {
        to.cost_estimated = Some(true);
    }
}

fn total(c: &TokenCounts) -> f64 {
    c.input + c.output + c.cache_write + c.cache_read
}

fn is_empty(c: &TokenCounts) -> bool {
    total(c) == 0.0 && c.responses == 0.0
}

fn shift_date(date: &str, days: f64) -> String {
    let text = iso(date_parse(&format!("{date}T00:00:00Z")) + days * DAY_MS);
    text.get(..10).unwrap_or("").to_string()
}

/// The row a ledger `who` key counts toward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Who {
    pub key: String,
    pub kind: TokenRowKind,
    pub account_id: Option<String>,
    pub name: Option<String>,
    pub estimated: bool,
}

/// The row a ledger `who` key counts toward: one per account, one for all former ones.
pub fn classify(who: &str, accounts: &HashMap<&str, &Account>) -> Who {
    if who == TERMINAL_KEY {
        return Who {
            key: TERMINAL_KEY.into(),
            kind: TokenRowKind::Terminal,
            account_id: None,
            name: None,
            estimated: false,
        };
    }
    let (estimated, id) = match (who.strip_prefix("acct:"), who.strip_prefix("est:")) {
        (Some(id), _) if !id.is_empty() && !id.contains(['\n', '\r', '\u{2028}', '\u{2029}']) => {
            (false, id)
        }
        (_, Some(id)) if !id.is_empty() && !id.contains(['\n', '\r', '\u{2028}', '\u{2029}']) => {
            (true, id)
        }
        _ => {
            return Who {
                key: UNKNOWN_KEY.into(),
                kind: TokenRowKind::Unknown,
                account_id: None,
                name: None,
                estimated: false,
            };
        }
    };
    match accounts.get(id) {
        Some(account) => Who {
            key: account.id.clone(),
            kind: TokenRowKind::Account,
            account_id: Some(account.id.clone()),
            name: Some(account.name.clone()),
            estimated,
        },
        None => Who {
            key: FORMER_KEY.into(),
            kind: TokenRowKind::Former,
            account_id: None,
            name: None,
            estimated,
        },
    }
}

fn account_map(accounts: &[Account]) -> HashMap<&str, &Account> {
    let mut map = HashMap::new();
    for a in accounts {
        // `new Map(entries)` keeps the last of a repeated key.
        map.insert(a.id.as_str(), a);
    }
    map
}

/// Builds the Usage page's token model from the ledger. Days follow `zone`; the range is the last
/// `range` local days including today. With `account_id` only that account is kept.
pub fn build_token_usage_view(input: &TokenUsageInput<'_>) -> TokenUsageView {
    let (ledger, range, zone, now) = (input.ledger, input.range, input.zone, input.now);
    let today = local_date(now, zone);
    let mut days: Vec<TokenDay> = (0..range)
        .map(|i| TokenDay {
            date: shift_date(&today, f64::from(i) - f64::from(range) + 1.0),
            by_row: JsMap::new(),
        })
        .collect();
    let accounts = account_map(input.accounts);

    let mut rows: IndexMap<String, TokenRow> = IndexMap::new();
    let mut models: IndexMap<String, TokenCounts> = IndexMap::new();
    let mut totals = zero();
    for day in &mut days {
        let Some(bucket) = ledger.days.get(&day.date) else {
            continue;
        };
        for (who, by_model) in bucket {
            let target = classify(who, &accounts);
            if input.account_id.is_some_and(|id| target.key != id) {
                continue;
            }
            for (model, counts) in by_model {
                if is_empty(counts) {
                    continue;
                }
                let row = rows.entry(target.key.clone()).or_insert_with(|| TokenRow {
                    key: target.key.clone(),
                    kind: target.kind,
                    account_id: target.account_id.clone().filter(|s| !s.is_empty()),
                    name: target.name.clone().filter(|s| !s.is_empty()),
                    estimated: false,
                    totals: zero(),
                });
                let cell = day.by_row.entry_or_insert_with(&target.key, || TokenCell {
                    counts: zero(),
                    estimated: false,
                });
                add(&mut cell.counts, counts);
                add(&mut row.totals, counts);
                add(&mut totals, counts);
                if target.estimated {
                    row.estimated = true;
                    cell.estimated = true;
                }
                add(models.entry(model.clone()).or_insert_with(zero), counts);
            }
        }
    }

    let order: HashMap<String, usize> = rows
        .keys()
        .enumerate()
        .map(|(i, k)| (k.clone(), i))
        .collect();
    let mut sorted: Vec<TokenRow> = rows.into_values().collect();
    sort_by(&mut sorted, |a, b| {
        let by_tail = tail(a.kind) - tail(b.kind);
        if by_tail != 0.0 {
            return by_tail;
        }
        let by_total = total(&b.totals) - total(&a.totals);
        if by_total != 0.0 && !by_total.is_nan() {
            return by_total;
        }
        order[&a.key] as f64 - order[&b.key] as f64
    });
    let mut by_total: Vec<(String, TokenCounts)> = models.into_iter().collect();
    sort_by(&mut by_total, |(an, a), (bn, b)| {
        let d = total(b) - total(a);
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            compare_str(an, bn)
        }
    });

    let progress = &ledger.progress;
    // Never 100 until a full pass is done; after one it stays 100.
    let percent = if progress.complete {
        100.0
    } else if progress.total_bytes > 0.0 {
        99f64.min(0f64.max(((progress.scanned_bytes / progress.total_bytes) * 100.0).floor()))
    } else {
        0.0
    };
    let unpriced_models = by_total
        .iter()
        .filter(|(_, c)| c.unpriced.unwrap_or(0.0) > 0.0)
        .map(|(m, _)| m.clone())
        .collect();

    TokenUsageView {
        range,
        days,
        rows: sorted,
        totals,
        models: by_total
            .into_iter()
            .map(|(model, totals)| TokenModel { model, totals })
            .collect(),
        progress: TokenProgress {
            percent,
            complete: progress.complete,
            error: progress.error.filter(|e| *e),
        },
        exact_since: input.exact_since.map(|t| local_date(t, zone)),
        today: build_token_today(input.ledger, input.accounts, input.account_id, zone, now),
        unpriced_models,
        prices_checked: PRICES_CHECKED.to_string(),
    }
}

const SLOTS_PER_DAY: usize = 96;

/// Today so far: its tokens and cost from the day buckets, and its line from the quarter-hour
/// slots. The change compares today with yesterday up to the same quarter hour, and only when
/// slots were kept for all of yesterday.
pub fn build_token_today(
    ledger: &LedgerSnapshot,
    accounts: &[Account],
    account_id: Option<&str>,
    zone: &str,
    now: f64,
) -> TokenToday {
    let accounts = account_map(accounts);
    let keep = |who: &str| account_id.is_none_or(|id| classify(who, &accounts).key == id);
    let today = local_date(now, zone);
    let yesterday = shift_date(&today, -1.0);
    let current_slot = local_slot(now, zone);

    let mut totals = zero();
    if let Some(by_who) = ledger.days.get(&today) {
        for (who, by_model) in by_who {
            if keep(who) {
                for counts in by_model.values() {
                    add(&mut totals, counts);
                }
            }
        }
    }

    let costs = |date: &str| -> Vec<f64> {
        let mut out = vec![0.0; SLOTS_PER_DAY];
        if let Some(by_who) = ledger.slots.as_ref().and_then(|s| s.get(date)) {
            for (who, by_slot) in by_who {
                if !keep(who) {
                    continue;
                }
                for (slot, counts) in by_slot {
                    let index = number_value(slot);
                    if index < SLOTS_PER_DAY as f64 {
                        // `out[-1]`, `out[1.5]` or `out[NaN]` would be a property, not a slot.
                        if index >= 0.0 && index.fract() == 0.0 {
                            out[index as usize] += counts.cost;
                        }
                    }
                }
            }
        }
        out
    };
    let today_costs = costs(&today);
    let slots = today_costs
        .iter()
        .enumerate()
        .map(|(slot, cost)| {
            if (slot as f64) <= current_slot {
                Some(*cost)
            } else {
                None
            }
        })
        .collect();

    let since = ledger.slots_since;
    // A DST change can skip midnight: the day starts at its first hour.
    let start_of = |date: &str| {
        ["00:00", "01:00", "02:00"]
            .iter()
            .find_map(|clock| wall_time(date, clock, zone))
            .unwrap_or(f64::INFINITY)
    };
    // While a scan runs, yesterday and today may be only partly read.
    let whole_yesterday =
        ledger.progress.complete && since.is_some_and(|s| s <= start_of(&yesterday));
    let (mut change, mut yesterday_average) = (None, None);
    if whole_yesterday {
        let before = costs(&yesterday);
        let sum = |list: &[f64], up_to: f64| -> f64 {
            let end = if up_to.is_nan() {
                0
            } else {
                ((up_to + 1.0).max(0.0) as usize).min(list.len())
            };
            list[..end].iter().fold(0.0, |a, b| a + b)
        };
        let then = sum(&before, current_slot);
        if then > 0.0 {
            change = Some(sum(&today_costs, current_slot) / then - 1.0);
        }
        yesterday_average = Some(sum(&before, (SLOTS_PER_DAY - 1) as f64) / SLOTS_PER_DAY as f64);
    }

    TokenToday {
        date: today.clone(),
        totals,
        slots,
        current_slot,
        change,
        yesterday_average,
        slots_since: since.filter(|s| *s > start_of(&today)),
    }
}
