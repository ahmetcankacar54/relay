//! Port of `electron/core/token-attribution.ts`: which Relay account a Claude response belongs
//! to, from a Relay profile, the gateway, the Claude app's timeline, or the 5-hour usage samples.

use std::cell::RefCell;
use std::sync::Arc;

use indexmap::IndexMap;
use serde::Serialize;

use crate::shared::desktop_account::{KnownDesktop, desktop_account_for};
use crate::shared::types::Account;
use crate::shared::types::js::date_parse;
use crate::shared::usage_statistics::{MAX_USAGE_GAP_MS, UsageSample};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Attribution {
    Account { account_id: String, estimated: bool },
    Terminal,
    Unknown,
}

/// A later reset time by at least this much means the window rolled over.
const RESET_SHIFT_MS: f64 = 60.0 * 60_000.0;
/// When no account's usage rose across the pair around a response, the nearest rise this close
/// still names the account: a small response may not move the percent within its own five
/// minutes, and the server may report it a reading late.
pub const NEAR_RISE_MS: f64 = 15.0 * 60_000.0;

/// How far `time` is from a sample pair: 0 inside it, else to its nearer end.
fn distance(time: f64, from: f64, to: f64) -> f64 {
    if time < from {
        from - time
    } else if time >= to {
        time - to
    } else {
        0.0
    }
}

#[derive(Debug, Clone, Copy)]
struct Near {
    distance: f64,
    rise: f64,
}

/// Whether `candidate` beats `best`: nearer, then a larger rise.
fn nearer(candidate: Near, best: Option<Near>) -> bool {
    best.is_none_or(|best| {
        candidate.distance < best.distance
            || (candidate.distance == best.distance && candidate.rise > best.rise)
    })
}

#[derive(Debug, Clone, Copy)]
struct Reading {
    at: f64,
    percent: f64,
    resets_at: Option<f64>,
}

fn reading(sample: &UsageSample) -> Option<Reading> {
    let at = date_parse(&sample.checked_at);
    let window = sample.five_hour.as_ref()?;
    if !at.is_finite() || !window.used_percent.is_finite() {
        return None;
    }
    let resets_at = window.resets_at.as_deref().map_or(f64::NAN, date_parse);
    Some(Reading {
        at,
        percent: window.used_percent,
        resets_at: resets_at.is_finite().then_some(resets_at),
    })
}

fn rise(a: &Reading, b: &Reading) -> f64 {
    let reset = b.percent < a.percent
        || matches!((a.resets_at, b.resets_at), (Some(x), Some(y)) if y - x >= RESET_SHIFT_MS);
    if reset {
        b.percent
    } else {
        b.percent - a.percent
    }
}

/// Each account's readings, accounts in first-seen order, readings sorted by time (stably).
fn group<'a>(samples: impl IntoIterator<Item = &'a UsageSample>) -> Vec<(String, Vec<Reading>)> {
    let mut by_account: IndexMap<&str, Vec<Reading>> = IndexMap::new();
    for sample in samples {
        if let Some(point) = reading(sample) {
            by_account
                .entry(sample.account_id.as_str())
                .or_default()
                .push(point);
        }
    }
    by_account
        .into_iter()
        .map(|(account_id, mut points)| {
            points.sort_by(|x, y| x.at.total_cmp(&y.at));
            (account_id.to_string(), points)
        })
        .collect()
}

fn estimate_grouped(time: f64, by_account: &[(String, Vec<Reading>)]) -> Option<String> {
    let mut best: Option<(&str, f64)> = None;
    for (account_id, points) in by_account {
        for pair in points.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if a.at > time {
                break;
            }
            if time >= b.at || b.at - a.at > MAX_USAGE_GAP_MS {
                continue;
            }
            let amount = rise(a, b);
            if amount > 0.0 && best.is_none_or(|(_, rise)| amount > rise) {
                best = Some((account_id, amount));
            }
            break;
        }
    }
    if let Some((account_id, _)) = best {
        return Some(account_id.to_string());
    }
    let mut near: Option<(&str, Near)> = None;
    for (account_id, points) in by_account {
        for pair in points.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            if b.at - a.at > MAX_USAGE_GAP_MS {
                continue;
            }
            let amount = rise(a, b);
            let away = distance(time, a.at, b.at);
            // `!(away <= NEAR_RISE_MS)`: a NaN distance is not near.
            if amount <= 0.0 || away.is_nan() || away > NEAR_RISE_MS {
                continue;
            }
            let candidate = Near {
                distance: away,
                rise: amount,
            };
            if nearer(candidate, near.map(|(_, n)| n)) {
                near = Some((account_id, candidate));
            }
        }
    }
    near.map(|(account_id, _)| account_id.to_string())
}

/// The Relay account whose 5-hour usage rose across the sample pair around `time`, the largest
/// rise winning. When none rose there, the account with the nearest rise within `NEAR_RISE_MS`
/// (nearest first, then the larger rise). `None` when no account's usage rose that close.
pub fn estimate_account_at(time: f64, samples: &[UsageSample]) -> Option<String> {
    estimate_grouped(time, &group(samples))
}

#[derive(Debug, Clone)]
struct IndexedAccount {
    account_id: String,
    times: Vec<f64>,
    /// What each consecutive pair rose by; nothing across too long a gap.
    rises: Vec<f64>,
}

/// `estimate_account_at` for many times over one set of samples: the samples are read and
/// sorted once, and each time finds its pair by binary search.
#[derive(Debug, Clone)]
pub struct SampleIndex {
    grouped: Vec<(String, Vec<Reading>)>,
    accounts: Vec<IndexedAccount>,
    first: f64,
    last: f64,
}

/// `estimate_account_at` for many times over one set of samples.
pub fn index_samples(samples: &[UsageSample]) -> SampleIndex {
    index_grouped(group(samples))
}

fn index_grouped(grouped: Vec<(String, Vec<Reading>)>) -> SampleIndex {
    let mut first = f64::INFINITY;
    let mut last = f64::NEG_INFINITY;
    let accounts = grouped
        .iter()
        .map(|(account_id, points)| {
            let times: Vec<f64> = points.iter().map(|p| p.at).collect();
            first = first.min(times[0]);
            last = last.max(times[times.len() - 1]);
            let rises = points
                .windows(2)
                .map(|pair| {
                    if pair[1].at - pair[0].at > MAX_USAGE_GAP_MS {
                        0.0
                    } else {
                        rise(&pair[0], &pair[1])
                    }
                })
                .collect();
            IndexedAccount {
                account_id: account_id.clone(),
                times,
                rises,
            }
        })
        .collect();
    SampleIndex {
        grouped,
        accounts,
        first,
        last,
    }
}

/// The rise nearest `time` within `NEAR_RISE_MS` for one account, whose first sample after
/// `time` is `low`.
fn nearest_rise(account: &IndexedAccount, time: f64, low: usize) -> Option<Near> {
    let IndexedAccount { times, rises, .. } = account;
    let mut near: Option<Near> = None;
    let mut consider = |i: usize| {
        let away = distance(time, times[i], times[i + 1]);
        if rises[i] > 0.0 && away <= NEAR_RISE_MS {
            let candidate = Near {
                distance: away,
                rise: rises[i],
            };
            if nearer(candidate, near) {
                near = Some(candidate);
            }
        }
    };
    // Pairs ending at or before `time`, then the pair around it, then pairs after it.
    let mut i = low as isize - 2;
    while i >= 0 && time - times[i as usize + 1] <= NEAR_RISE_MS {
        consider(i as usize);
        i -= 1;
    }
    if low >= 1 && low < times.len() {
        consider(low - 1);
    }
    let mut i = low;
    while i + 1 < times.len() && times[i] - time <= NEAR_RISE_MS {
        consider(i);
        i += 1;
    }
    near
}

impl SampleIndex {
    /// `estimate_account_at(time, samples)`, for the samples indexed.
    pub fn estimate(&self, time: f64) -> Option<String> {
        if time.is_nan() {
            return estimate_grouped(time, &self.grouped);
        }
        if !(time >= self.first - NEAR_RISE_MS && time < self.last + NEAR_RISE_MS) {
            return None;
        }
        let mut best: Option<(&str, f64)> = None;
        let mut lows = Vec::with_capacity(self.accounts.len());
        for account in &self.accounts {
            // The first sample after `time`; the pair starts just before it.
            let low = account.times.partition_point(|t| *t <= time);
            lows.push(low);
            let amount = if low >= 1 && low < account.times.len() {
                account.rises[low - 1]
            } else {
                0.0
            };
            if amount > 0.0 && best.is_none_or(|(_, rise)| amount > rise) {
                best = Some((&account.account_id, amount));
            }
        }
        if let Some((account_id, _)) = best {
            return Some(account_id.to_string());
        }
        let mut near: Option<(&str, Near)> = None;
        for (account, low) in self.accounts.iter().zip(lows) {
            if let Some(found) = nearest_rise(account, time, low)
                && nearer(found, near.map(|(_, n)| n))
            {
                near = Some((&account.account_id, found));
            }
        }
        near.map(|(account_id, _)| account_id.to_string())
    }
}

/// The Claude app sign-in the timeline knew at a time.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TimelineAccount {
    pub account_uuid: String,
    pub org_id: Option<String>,
}

/// The active-account timeline: the Claude app's sign-in at a time, when known.
pub trait AccountTimeline {
    fn account_at(&self, time: f64) -> Option<TimelineAccount>;
}

impl<F: Fn(f64) -> Option<TimelineAccount>> AccountTimeline for F {
    fn account_at(&self, time: f64) -> Option<TimelineAccount> {
        self(time)
    }
}

/// The index of one samples array, per set of candidate accounts. The TS keeps it in a
/// `WeakMap` keyed by the array; here the caller keeps one cache per samples array (and drops
/// it with that array), so `attribute` indexes each array once per set of candidates.
#[derive(Debug, Default)]
pub struct SampleIndexCache {
    cached: RefCell<Option<(String, Arc<SampleIndex>)>>,
}

impl SampleIndexCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// One transcript row to attribute.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct AttributionRow<'a> {
    pub time: f64,
    pub entrypoint: Option<&'a str>,
    pub profile_account_id: Option<&'a str>,
    /// The Claude Code session the row is in.
    pub session_id: Option<&'a str>,
    /// The provider's id for the response (Anthropic's `request-id`).
    pub request_id: Option<&'a str>,
}

/// The Claude app account (by uuid) whose separate window held a session at a time.
pub type WindowOwnerFn<'a> = dyn Fn(&str, f64) -> Option<String> + 'a;
/// The Relay account Relay's gateway sent a request id to.
pub type GatewayAccountFn<'a> = dyn Fn(&str) -> Option<String> + 'a;

/// What `attribute` reads.
pub struct AttributionDeps<'a> {
    pub timeline: &'a dyn AccountTimeline,
    pub samples: &'a [UsageSample],
    pub accounts: &'a [Account],
    /// The account whose separate Claude window held a session at time `t`, by Claude Code
    /// session id.
    pub window_owner: Option<&'a WindowOwnerFn<'a>>,
    /// The Relay account Relay's gateway sent a request id to, while its request log keeps it.
    pub gateway_account: Option<&'a GatewayAccountFn<'a>>,
    /// The index of `samples`; without one each estimate indexes them anew.
    pub index: Option<&'a SampleIndexCache>,
}

impl<'a> AttributionDeps<'a> {
    pub fn new(
        timeline: &'a dyn AccountTimeline,
        samples: &'a [UsageSample],
        accounts: &'a [Account],
    ) -> Self {
        AttributionDeps {
            timeline,
            samples,
            accounts,
            window_owner: None,
            gateway_account: None,
            index: None,
        }
    }
}

/// Each samples array is indexed once per set of candidates, on the first row that needs an
/// estimate.
fn index_for(
    samples: &[UsageSample],
    accounts: &[Account],
    cache: Option<&SampleIndexCache>,
) -> Arc<SampleIndex> {
    // Desktop's rows can belong only to an account Claude Desktop has signed in to.
    let ids: Vec<&str> = accounts
        .iter()
        .filter(|account| {
            account
                .desktop
                .as_ref()
                .is_some_and(|d| !d.account_uuid.is_empty())
        })
        .map(|account| account.id.as_str())
        .collect();
    let candidates = ids.join("\n");
    if let Some(cache) = cache
        && let Some((cached, index)) = cache.cached.borrow().as_ref()
        && *cached == candidates
    {
        return Arc::clone(index);
    }
    let allowed = samples
        .iter()
        .filter(|sample| ids.contains(&sample.account_id.as_str()));
    let index = Arc::new(index_grouped(group(allowed)));
    if let Some(cache) = cache {
        *cache.cached.borrow_mut() = Some((candidates, Arc::clone(&index)));
    }
    index
}

fn owned(id: &str) -> Attribution {
    Attribution::Account {
        account_id: id.to_string(),
        estimated: false,
    }
}

fn truthy(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// Which Relay account a Claude response belongs to, or whether it is not Desktop's. Only an
/// account with a Claude app sign-in can be estimated. `samples` is indexed once per cache and
/// must not change after.
pub fn attribute(row: &AttributionRow<'_>, deps: &AttributionDeps<'_>) -> Attribution {
    if let Some(profile) = truthy(row.profile_account_id) {
        return owned(profile);
    }
    // A response that came through the gateway: the gateway knows which account served it.
    let served = truthy(row.request_id)
        .and_then(|id| deps.gateway_account.and_then(|gateway| gateway(id)))
        .filter(|served| !served.is_empty());
    if let Some(served) = served
        && deps.accounts.iter().any(|account| account.id == served)
    {
        return owned(&served);
    }
    if truthy(row.entrypoint).is_some_and(|entry| entry != "claude-desktop") {
        return Attribution::Terminal;
    }
    // A separate window's conversation runs on its own account, whatever the main Claude has
    // open.
    let window_account = truthy(row.session_id)
        .and_then(|id| deps.window_owner.and_then(|owner| owner(id, row.time)))
        .filter(|uuid| !uuid.is_empty());
    if let Some(uuid) = window_account {
        let known = KnownDesktop {
            account_uuid: &uuid,
            org_id: None,
        };
        if let Some(owner) = desktop_account_for(known, deps.accounts) {
            return owned(&owner.id);
        }
    }
    if let Some(known) = deps.timeline.account_at(row.time) {
        let known = KnownDesktop {
            account_uuid: &known.account_uuid,
            org_id: known.org_id.as_deref(),
        };
        return match desktop_account_for(known, deps.accounts) {
            Some(owner) => owned(&owner.id),
            None => Attribution::Unknown,
        };
    }
    match index_for(deps.samples, deps.accounts, deps.index).estimate(row.time) {
        Some(account_id) => Attribution::Account {
            account_id,
            estimated: true,
        },
        None => Attribution::Unknown,
    }
}
