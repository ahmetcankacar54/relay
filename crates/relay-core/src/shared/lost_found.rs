//! Port of `shared/lost-found.ts`: the panda's lost-and-found, what a week of use left behind.
//! Every item is a real moment of that week, found in the usage rollups, the active-account
//! timeline and the token ledger.

use std::collections::HashSet;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::desktop_account::{KnownDesktop, desktop_account_for};
use super::plan_prices::plan_price;
use super::planning::{local_date, local_hour, local_slot, wall_time};
use super::types::js::{date_parse, iso, max, round, ser_num, sort_by};
use super::types::{Account, literal_enum};
use super::usage_rollups::{LimitHitKind, UsageRollups, same_reset};
use super::usage_statistics::{history_identity, identity_owners};
use crate::token_ledger::{LedgerDays, LedgerSlots};

const MINUTE_MS: f64 = 60_000.0;
const HOUR_MS: f64 = 3_600_000.0;
const DAY_MS: f64 = 86_400_000.0;
const FIVE_HOURS_MS: f64 = 5.0 * HOUR_MS;
const QUARTER_MS: f64 = 15.0 * MINUTE_MS;

/// A five-hour window that ran out this soon after it began is an hourglass.
pub const HOURGLASS_MAX_MS: f64 = 150.0 * MINUTE_MS;
/// This many active hours in a row make a long scroll.
pub const SCROLL_MIN_HOURS: usize = 8;
/// Two accounts' windows resetting this close together ring as twin clocks.
pub const CLOCKS_MAX_GAP_MS: f64 = 10.0 * MINUTE_MS;
/// Leaving an account and coming back within this time is a boomerang.
pub const BOOMERANG_MAX_MS: f64 = 15.0 * MINUTE_MS;
/// Night hours run from midnight to this local hour.
pub const NIGHT_END_HOUR: f64 = 5.0;
/// The trophy day is the busiest of this many days, the week's own included.
pub const TROPHY_DAYS: usize = 30;
/// It is compared with at least this many other active days…
pub const TROPHY_MIN_DAYS: usize = 5;
/// …and is at least this many times an ordinary one.
pub const TROPHY_MIN_TIMES: f64 = 1.5;
/// The baton is handed on when another account takes over this soon after a limit hit.
pub const BATON_MAX_MS: f64 = 30.0 * MINUTE_MS;
/// …or this little before it: the hit is recorded at the poll that saw it, after the switch.
pub const BATON_EARLY_MS: f64 = 2.0 * MINUTE_MS;
/// A compass week has at least this many active hours and no limit hit.
pub const COMPASS_MIN_HOURS: usize = 20;
/// Morning hours run from the end of the night to this local hour.
pub const MORNING_END_HOUR: f64 = 8.0;
/// A window that came this full without a limit hit walked the tightrope.
pub const TIGHTROPE_MIN_PERCENT: f64 = 95.0;
/// A weekend watch is at least this many active hours over Saturday and Sunday.
pub const LANTERN_MIN_HOURS: usize = 6;
/// A rest day counts in a week with at least this many active days.
pub const HAMMOCK_MIN_DAYS: usize = 4;
/// The scales weigh a week of at least this many active hours…
pub const SCALES_MIN_HOURS: usize = 10;
/// …whose accounts' shares are at most this many points apart.
pub const SCALES_MAX_SPREAD: f64 = 15.0;
/// A treasure week is compared with at least this many earlier weeks of API value…
pub const CHEST_MIN_WEEKS: usize = 4;
/// …and is at least this many times an ordinary one.
pub const CHEST_MIN_TIMES: f64 = 1.2;
/// A model family joins the fan with at least this share of the week's tokens.
pub const FAN_MIN_SHARE: f64 = 0.01;
/// How many weeks back the bureau can look: the rollups keep 90 days.
pub const LOST_FOUND_WEEKS: i32 = 12;

literal_enum!(
    /// The items; `LOST_ITEM_KINDS` lists them most striking first.
    LostItemKind {
        Hourglass = "hourglass",
        Baton = "baton",
        Piggy = "piggy",
        Chest = "chest",
        Boomerang = "boomerang",
        Trophy = "trophy",
        Tightrope = "tightrope",
        Scroll = "scroll",
        Tally = "tally",
        Compass = "compass",
        Scales = "scales",
        Scarf = "scarf",
        Fan = "fan",
        Clocks = "clocks",
        Spare = "spare",
        Lantern = "lantern",
        Hammock = "hammock",
        Feather = "feather",
        Teaglass = "teaglass",
    }
);

/// The items, most striking first: the first one found is the week's featured item.
pub const LOST_ITEM_KINDS: [LostItemKind; 19] = [
    LostItemKind::Hourglass,
    LostItemKind::Baton,
    LostItemKind::Piggy,
    LostItemKind::Chest,
    LostItemKind::Boomerang,
    LostItemKind::Trophy,
    LostItemKind::Tightrope,
    LostItemKind::Scroll,
    LostItemKind::Tally,
    LostItemKind::Compass,
    LostItemKind::Scales,
    LostItemKind::Scarf,
    LostItemKind::Fan,
    LostItemKind::Clocks,
    LostItemKind::Spare,
    LostItemKind::Lantern,
    LostItemKind::Hammock,
    LostItemKind::Feather,
    LostItemKind::Teaglass,
];

/// Items the collection keeps secret until found once: they are surprises, not goals.
pub const SECRET_LOST_KINDS: [LostItemKind; 3] = [LostItemKind::Boomerang, LostItemKind::Clocks, LostItemKind::Tightrope];

literal_enum!(LostTier { Bronze = "bronze", Silver = "silver", Gold = "gold" });

/// A pin's finish: how many weeks it was found in.
pub const LOST_TIERS: [(LostTier, u32); 3] = [(LostTier::Bronze, 1), (LostTier::Silver, 3), (LostTier::Gold, 6)];

/// The finish `weeks` finds earn, or `None` before the first.
pub fn tier_of(weeks: f64) -> Option<LostTier> {
    LOST_TIERS.iter().filter(|(_, w)| weeks >= f64::from(*w)).map(|(t, _)| *t).last()
}

/// The next finish and the weeks it needs, or `None` at gold.
pub fn next_tier(weeks: f64) -> Option<(LostTier, u32)> {
    LOST_TIERS.iter().find(|(_, w)| weeks < f64::from(*w)).copied()
}

/// What a moment used: tokens and their API value in USD, from the token ledger.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct LostSpend {
    #[serde(serialize_with = "ser_num")]
    pub tokens: f64,
    #[serde(serialize_with = "ser_num")]
    pub cost: f64,
}

/// What happened, by kind, in the field order the TS writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LostMoment {
    /// A five-hour window ran out `minutes` after it began; `at` is when it ran out.
    #[serde(rename_all = "camelCase")]
    Hourglass {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
        #[serde(serialize_with = "ser_num")]
        minutes: f64,
    },
    /// Left `account_ids[0]` for `account_ids[1]` at `at` and came back `minutes` later.
    #[serde(rename_all = "camelCase")]
    Boomerang {
        at: String,
        account_ids: Vec<String>,
        #[serde(serialize_with = "ser_num")]
        minutes: f64,
    },
    /// `account_ids[0]` hit a limit and `account_ids[1]` took over; `count` such hand-overs.
    #[serde(rename_all = "camelCase")]
    Baton {
        at: String,
        account_ids: Vec<String>,
        #[serde(serialize_with = "ser_num")]
        minutes: f64,
        #[serde(serialize_with = "ser_num")]
        count: f64,
    },
    /// `date` was the busiest of the last 30 days, `times` an ordinary active day of them.
    Trophy {
        date: String,
        #[serde(serialize_with = "ser_num")]
        tokens: f64,
        #[serde(serialize_with = "ser_num")]
        times: f64,
    },
    /// `hours` active hours in a row from `at`.
    Scroll {
        at: String,
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// Every day of the week had active hours, `hours` in all.
    Tally {
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// `hours` active hours and not one limit hit.
    Compass {
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// The accounts used on `date`, busiest first.
    #[serde(rename_all = "camelCase")]
    Scarf { date: String, account_ids: Vec<String> },
    /// Two accounts' five-hour windows reset `gap_minutes` apart at `at`; `count` such pairs.
    #[serde(rename_all = "camelCase")]
    Clocks {
        at: String,
        account_ids: Vec<String>,
        #[serde(serialize_with = "ser_num")]
        gap_minutes: f64,
        #[serde(serialize_with = "ser_num")]
        count: f64,
    },
    /// `account_ids` were never used while other accounts hit a five-hour limit `hits` times.
    #[serde(rename_all = "camelCase")]
    Spare {
        account_ids: Vec<String>,
        #[serde(serialize_with = "ser_num")]
        hits: f64,
    },
    /// `hours` active hours after midnight; the latest began at `at`.
    Feather {
        at: String,
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// `hours` active hours early in the morning; the earliest began at `at`.
    Teaglass {
        at: String,
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// A five-hour window that reset at `at` came `percent` full without a limit hit.
    #[serde(rename_all = "camelCase")]
    Tightrope {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
        #[serde(serialize_with = "ser_num")]
        percent: f64,
    },
    /// `hours` active hours over Saturday and Sunday.
    Lantern {
        #[serde(serialize_with = "ser_num")]
        hours: f64,
    },
    /// Nothing was done on `date`, between active days, in a week of `active_days`.
    #[serde(rename_all = "camelCase")]
    Hammock {
        date: String,
        #[serde(serialize_with = "ser_num")]
        active_days: f64,
    },
    /// `account_ids` (busiest first) shared the week's work, from `low` to `high` percent each.
    #[serde(rename_all = "camelCase")]
    Scales {
        account_ids: Vec<String>,
        #[serde(serialize_with = "ser_num")]
        low: f64,
        #[serde(serialize_with = "ser_num")]
        high: f64,
    },
    /// The week's API value was the highest of the weeks before it, `times` an ordinary one.
    Chest {
        #[serde(serialize_with = "ser_num")]
        cost: f64,
        #[serde(serialize_with = "ser_num")]
        tokens: f64,
        #[serde(serialize_with = "ser_num")]
        times: f64,
    },
    /// `account_id`'s API value that week, `cost`, paid for its plan's month, `price`.
    #[serde(rename_all = "camelCase")]
    Piggy {
        account_id: String,
        #[serde(serialize_with = "ser_num")]
        cost: f64,
        #[serde(serialize_with = "ser_num")]
        price: f64,
    },
    /// Model families used that week, largest first.
    Fan { families: Vec<String> },
}

impl LostMoment {
    pub fn kind(&self) -> LostItemKind {
        match self {
            LostMoment::Hourglass { .. } => LostItemKind::Hourglass,
            LostMoment::Boomerang { .. } => LostItemKind::Boomerang,
            LostMoment::Baton { .. } => LostItemKind::Baton,
            LostMoment::Trophy { .. } => LostItemKind::Trophy,
            LostMoment::Scroll { .. } => LostItemKind::Scroll,
            LostMoment::Tally { .. } => LostItemKind::Tally,
            LostMoment::Compass { .. } => LostItemKind::Compass,
            LostMoment::Scarf { .. } => LostItemKind::Scarf,
            LostMoment::Clocks { .. } => LostItemKind::Clocks,
            LostMoment::Spare { .. } => LostItemKind::Spare,
            LostMoment::Feather { .. } => LostItemKind::Feather,
            LostMoment::Teaglass { .. } => LostItemKind::Teaglass,
            LostMoment::Tightrope { .. } => LostItemKind::Tightrope,
            LostMoment::Lantern { .. } => LostItemKind::Lantern,
            LostMoment::Hammock { .. } => LostItemKind::Hammock,
            LostMoment::Scales { .. } => LostItemKind::Scales,
            LostMoment::Chest { .. } => LostItemKind::Chest,
            LostMoment::Piggy { .. } => LostItemKind::Piggy,
            LostMoment::Fan { .. } => LostItemKind::Fan,
        }
    }
}

/// A find, with what it used when the token ledger can tell.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LostItem {
    #[serde(flatten)]
    pub moment: LostMoment,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend: Option<LostSpend>,
}

impl From<LostMoment> for LostItem {
    fn from(moment: LostMoment) -> Self {
        LostItem { moment, spend: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LostFoundWeek {
    /// The Monday the week starts, in the planning zone.
    pub start: String,
    /// The Sunday it ends.
    pub end: String,
    /// Monday of the newest complete week, which is the latest a user can open.
    pub latest: String,
    /// Monday of the oldest week the bureau can still look into.
    pub oldest: String,
    /// What the week left behind, most striking first.
    pub items: Vec<LostItem>,
}

/// One active-account segment (electron/core/active-account-timeline.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LostSegment {
    pub account_uuid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    pub from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

/// What the bureau reads.
#[derive(Debug, Clone, Copy)]
pub struct LostFoundInput<'a> {
    pub rollups: Option<&'a UsageRollups>,
    /// Active-account segments, oldest first.
    pub segments: &'a [LostSegment],
    /// Token ledger days: date → who → model → counts and their API value.
    pub ledger_days: &'a LedgerDays,
    /// Token ledger quarter hours of the last days: date → who → quarter (0–95) → counts.
    pub ledger_slots: Option<&'a LedgerSlots>,
    /// When the ledger began to keep quarter hours.
    pub slots_since: Option<f64>,
    pub accounts: &'a [Account],
    pub zone: &'a str,
    pub now: f64,
    /// A Monday; the newest complete week when missing or out of reach.
    pub week_start: Option<&'a str>,
}

/// The account a ledger `who` belongs to: `acct:<id>` or `est:<id>`.
fn ledger_account(who: &str) -> Option<&str> {
    who.strip_prefix("acct:").or_else(|| who.strip_prefix("est:")).filter(|id| !id.is_empty())
}

/// A model id's family, as people name it: "Opus", "Sonnet", "Haiku", "Fable".
pub fn model_family(model: &str) -> Option<String> {
    let lower = model.to_ascii_lowercase();
    let found = ["opus", "sonnet", "haiku", "fable"]
        .iter()
        .filter_map(|f| lower.find(f).map(|at| (at, *f)))
        .min_by_key(|(at, _)| *at)?;
    let mut out = found.1.to_string();
    out[..1].make_ascii_uppercase();
    Some(out)
}

/// `date` plus `days` calendar days.
pub fn add_days(date: &str, days: f64) -> String {
    let text = iso(date_parse(&format!("{date}T12:00:00Z")) + days * DAY_MS);
    text.get(..10).unwrap_or("").to_string()
}

/// The Monday of the week `date` falls in.
pub fn monday_of(date: &str) -> String {
    let at = date_parse(&format!("{date}T12:00:00Z"));
    let weekday = (((at / DAY_MS).floor() as i64 + 4).rem_euclid(7) + 6) % 7;
    add_days(date, -(weekday as f64))
}

/// Whether a stored item has what its kind needs to be told; a shelf from another version may not.
pub fn valid_lost_item(value: &Value) -> bool {
    let Some(item) = value.as_object() else { return false };
    let Some(kind) = item.get("kind").and_then(Value::as_str) else { return false };
    let Some(kind) = LOST_ITEM_KINDS.iter().find(|k| k.as_str() == kind) else { return false };
    let time = |key: &str| item.get(key).and_then(Value::as_str).is_some_and(|t| date_parse(t).is_finite());
    let date = |key: &str| {
        item.get(key).and_then(Value::as_str).is_some_and(|d| {
            d.len() == 10 && d.bytes().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == b'-' } else { c.is_ascii_digit() })
        })
    };
    let count = |key: &str| item.get(key).and_then(Value::as_f64).is_some_and(f64::is_finite);
    let ids = |key: &str| item.get(key).and_then(Value::as_array).is_some_and(|list| list.iter().all(Value::is_string));
    if let Some(spend) = item.get("spend") {
        let finite = |key: &str| spend.get(key).and_then(Value::as_f64).is_some_and(f64::is_finite);
        if !(spend.is_object() && finite("tokens") && finite("cost")) {
            return false;
        }
    }
    match kind {
        LostItemKind::Hourglass => time("at") && count("minutes"),
        LostItemKind::Tightrope => time("at") && count("percent"),
        LostItemKind::Lantern => count("hours"),
        LostItemKind::Hammock => date("date") && count("activeDays"),
        LostItemKind::Scales => ids("accountIds") && count("low") && count("high"),
        LostItemKind::Chest => count("cost") && count("tokens") && count("times"),
        LostItemKind::Piggy => item.get("accountId").is_some_and(Value::is_string) && count("cost") && count("price"),
        LostItemKind::Fan => ids("families"),
        LostItemKind::Boomerang => time("at") && ids("accountIds") && count("minutes"),
        LostItemKind::Baton => time("at") && ids("accountIds") && count("minutes") && count("count"),
        LostItemKind::Tally | LostItemKind::Compass => count("hours"),
        LostItemKind::Trophy => date("date") && count("tokens") && count("times"),
        LostItemKind::Scroll | LostItemKind::Feather | LostItemKind::Teaglass => time("at") && count("hours"),
        LostItemKind::Scarf => date("date") && ids("accountIds"),
        LostItemKind::Clocks => time("at") && ids("accountIds") && count("gapMinutes") && count("count"),
        LostItemKind::Spare => ids("accountIds") && count("hits"),
    }
}

fn tokens_in(input: f64, output: f64, cache_write: f64, cache_read: f64) -> f64 {
    input + output + cache_write + cache_read
}

fn round2(n: f64) -> f64 {
    round(n * 100.0) / 100.0
}

/// `a - b` as a sort key.
fn ascending(a: f64, b: f64) -> f64 {
    a - b
}

struct Segment {
    account: Option<String>,
    from: f64,
    to: f64,
}

/// Everything the week left behind, most striking first.
pub fn lost_found_week(input: &LostFoundInput<'_>) -> LostFoundWeek {
    let (zone, now, accounts) = (input.zone, input.now, input.accounts);
    let today = local_date(now, zone);
    let latest = add_days(&monday_of(&today), -7.0);
    let oldest = add_days(&latest, -7.0 * f64::from(LOST_FOUND_WEEKS - 1));
    let asked = input.week_start.filter(|w| !w.is_empty()).map(monday_of);
    let start = match asked {
        Some(asked) if asked.as_str() >= oldest.as_str() && asked.as_str() <= latest.as_str() => asked,
        _ => latest.clone(),
    };
    let end = add_days(&start, 6.0);
    let from = wall_time(&start, "00:00", zone).unwrap_or_else(|| date_parse(&format!("{start}T00:00:00Z")));
    let to = wall_time(&add_days(&start, 7.0), "00:00", zone).unwrap_or(from + 7.0 * DAY_MS);
    let within = |time: f64| time >= from && time < to;
    // An hour bucket's middle decides its local day and hour.
    let middle = |hour: f64| hour + 30.0 * MINUTE_MS;
    let owner: IndexMap<String, String> =
        identity_owners(accounts).into_iter().map(|(identity, account)| (identity, account.id.clone())).collect();
    let rollups = input.rollups;
    let hits: &[super::usage_rollups::LimitHit] = rollups.map_or(&[], |r| &r.hits);

    // Active hours: UTC hour start → account id (or identity, for a former account) → points.
    let mut hours: IndexMap<i64, IndexMap<String, f64>> = IndexMap::new();
    if let Some(rollups) = rollups {
        for (identity, by_hour) in &rollups.hours {
            for (key, hour) in by_hour {
                let time = date_parse(key);
                if !within(middle(time)) || !(hour.points > 0.0) {
                    continue;
                }
                let who = owner.get(identity).cloned().unwrap_or_else(|| identity.clone());
                *hours.entry(time as i64).or_default().entry(who).or_insert(0.0) += hour.points;
            }
        }
    }
    let mut active_hours: Vec<f64> = hours.keys().map(|t| *t as f64).collect();
    sort_by(&mut active_hours, |a, b| ascending(*a, *b));
    let hours_at = |time: f64| hours.get(&(time as i64)).expect("an active hour");
    let known = |who: &str| accounts.iter().any(|a| a.id == who);

    let mut found: Vec<LostMoment> = Vec::new();

    // Hourglass: the window that ran out soonest after it began.
    let five_hour_hits: Vec<_> =
        hits.iter().filter(|hit| hit.kind == LimitHitKind::FiveHour && within(date_parse(&hit.at))).collect();
    let mut hourglass: Option<(String, Option<String>, f64)> = None;
    for hit in &five_hour_hits {
        let Some(reset_at) = hit.reset_at.as_deref().filter(|r| !r.is_empty()) else { continue };
        let ms = date_parse(&hit.at) - (date_parse(reset_at) - FIVE_HOURS_MS);
        if !(ms > 0.0 && ms <= HOURGLASS_MAX_MS) {
            continue;
        }
        let minutes = round(ms / MINUTE_MS);
        if hourglass.as_ref().is_some_and(|h| minutes >= h.2) {
            continue;
        }
        hourglass = Some((hit.at.clone(), owner.get(&hit.identity).cloned().filter(|a| !a.is_empty()), minutes));
    }
    if let Some((at, account_id, minutes)) = hourglass {
        found.push(LostMoment::Hourglass { at, account_id, minutes });
    }

    // Boomerang: A, then B for a few minutes, then A again, all within the week.
    let segments: Vec<Segment> = input
        .segments
        .iter()
        .map(|s| Segment {
            account: desktop_account_for(
                KnownDesktop { account_uuid: &s.account_uuid, org_id: s.org_id.as_deref() },
                accounts,
            )
            .map(|a| a.id.clone()),
            from: date_parse(&s.from),
            to: s.to.as_deref().map_or(now, date_parse),
        })
        .filter(|s| s.from.is_finite() && s.to.is_finite())
        .collect();
    let mut boomerang: Option<LostMoment> = None;
    let mut boomerang_minutes = f64::INFINITY;
    for i in 0..segments.len().saturating_sub(2) {
        let (a, b, c) = (&segments[i], &segments[i + 1], &segments[i + 2]);
        let (Some(a_account), Some(b_account)) = (a.account.as_deref().filter(|x| !x.is_empty()), b.account.as_deref().filter(|x| !x.is_empty()))
        else {
            continue;
        };
        if a_account == b_account || c.account.as_deref() != Some(a_account) || !within(b.from) {
            continue;
        }
        if !(b.from - a.to <= BOOMERANG_MAX_MS) {
            continue;
        }
        let away = c.from - b.from;
        if !(away > 0.0 && away <= BOOMERANG_MAX_MS) {
            continue;
        }
        let minutes = max([1.0, round(away / MINUTE_MS)]);
        if boomerang.is_some() && minutes >= boomerang_minutes {
            continue;
        }
        boomerang_minutes = minutes;
        boomerang = Some(LostMoment::Boomerang {
            at: iso(b.from),
            account_ids: vec![a_account.to_string(), b_account.to_string()],
            minutes,
        });
    }
    if let Some(b) = boomerang {
        found.push(b);
    }

    // Baton: an account hit a limit and the next one took over at once.
    let mut baton: Option<(String, Vec<String>, f64)> = None;
    // A switch answers one hit: a five-hour and a weekly limit seen by one poll hand over once.
    let mut hand_overs: Vec<usize> = Vec::new();
    for hit in hits {
        let at = date_parse(&hit.at);
        let Some(giver) = owner.get(&hit.identity).filter(|g| !g.is_empty()) else { continue };
        if !within(at) {
            continue;
        }
        let next = (1..segments.len()).find(|&i| {
            let s = &segments[i];
            let prev = &segments[i - 1];
            prev.account.as_deref() == Some(giver.as_str())
                && s.account.as_deref().is_some_and(|x| x != giver)
                && s.from >= at - BATON_EARLY_MS
                && s.from <= at + BATON_MAX_MS
                && s.from - prev.to <= BOOMERANG_MAX_MS
        });
        let Some(next) = next else { continue };
        if hand_overs.contains(&next) {
            continue;
        }
        hand_overs.push(next);
        let minutes = max([0.0, round((segments[next].from - at) / MINUTE_MS)]);
        if baton.as_ref().is_some_and(|b| minutes >= b.2) {
            continue;
        }
        baton = Some((
            iso(segments[next].from),
            vec![giver.clone(), segments[next].account.clone().expect("checked")],
            minutes,
        ));
    }
    if let Some((at, account_ids, minutes)) = baton {
        found.push(LostMoment::Baton { at, account_ids, minutes, count: hand_overs.len() as f64 });
    }

    // Trophy: the week's busiest token day, when it is also the busiest of the last 30 days.
    let day_total = |date: &str| -> f64 {
        input.ledger_days.get(date).map_or(0.0, |by_who| {
            by_who.values().fold(0.0, |sum, by_model| {
                sum + by_model.values().fold(0.0, |s, c| s + c.input + c.output + c.cache_write + c.cache_read)
            })
        })
    };
    let week_days: Vec<String> = (0..7).map(|i| add_days(&start, f64::from(i))).collect();
    let mut busiest: Option<(String, f64)> = None;
    for date in &week_days {
        let tokens = day_total(date);
        if tokens > busiest.as_ref().map_or(0.0, |b| b.1) {
            busiest = Some((date.clone(), tokens));
        }
    }
    if let Some((date, tokens)) = &busiest {
        let window: Vec<f64> =
            (0..TROPHY_DAYS).map(|i| day_total(&add_days(date, -(i as f64)))).filter(|t| *t > 0.0).collect();
        let mut sorted = window.clone();
        sort_by(&mut sorted, |a, b| b - a);
        let ordinary = sorted.get(sorted.len() / 2).copied();
        let times = match ordinary {
            Some(o) if o > 0.0 => tokens / o,
            _ => 0.0,
        };
        if sorted.len() > TROPHY_MIN_DAYS && sorted[0] == *tokens && times >= TROPHY_MIN_TIMES {
            found.push(LostMoment::Trophy { date: date.clone(), tokens: *tokens, times: round(times * 10.0) / 10.0 });
        }
    }

    // Scroll: the longest run of active hours.
    let (mut run_from, mut run_hours) = (0.0, 0usize);
    let (mut current_from, mut current_hours) = (0.0, 0usize);
    for (i, time) in active_hours.iter().enumerate() {
        if i > 0 && time - active_hours[i - 1] == HOUR_MS {
            current_hours += 1;
        } else {
            current_from = *time;
            current_hours = 1;
        }
        if current_hours > run_hours {
            run_from = current_from;
            run_hours = current_hours;
        }
    }
    if run_hours >= SCROLL_MIN_HOURS {
        found.push(LostMoment::Scroll { at: iso(run_from), hours: run_hours as f64 });
    }

    // Scarf: the day the most accounts took a turn, three at least.
    let mut by_day: IndexMap<String, IndexMap<String, f64>> = IndexMap::new();
    for time in &active_hours {
        let date = local_date(middle(*time), zone);
        let day = by_day.entry(date).or_default();
        for (who, points) in hours_at(*time) {
            if known(who) {
                *day.entry(who.clone()).or_insert(0.0) += points;
            }
        }
    }
    let mut days_sorted: Vec<(&String, &IndexMap<String, f64>)> = by_day.iter().collect();
    sort_by(&mut days_sorted, |a, b| super::types::js::compare_str(a.0, b.0));
    let mut scarf: Option<(String, Vec<String>)> = None;
    for (date, day) in days_sorted {
        if day.len() >= 3 && day.len() > scarf.as_ref().map_or(0, |s| s.1.len()) {
            let mut list: Vec<(&String, &f64)> = day.iter().collect();
            sort_by(&mut list, |a, b| b.1 - a.1);
            scarf = Some((date.clone(), list.into_iter().map(|(who, _)| who.clone()).collect()));
        }
    }
    if let Some((date, account_ids)) = scarf {
        found.push(LostMoment::Scarf { date, account_ids });
    }

    // Tally: every day of the week had active hours, one notch a day.
    if week_days.iter().all(|date| by_day.contains_key(date)) {
        found.push(LostMoment::Tally { hours: active_hours.len() as f64 });
    }

    // Compass: a full week of work that never ran into a limit, nor started inside one.
    let blocked = hits.iter().any(|hit| {
        let at = date_parse(&hit.at);
        let until = match hit.until.as_deref().filter(|u| !u.is_empty()) {
            Some(u) => date_parse(u),
            None => at,
        };
        within(at) || (at < from && until > from)
    });
    if active_hours.len() >= COMPASS_MIN_HOURS && !blocked {
        found.push(LostMoment::Compass { hours: active_hours.len() as f64 });
    }

    // Clocks: two accounts' five-hour windows resetting close together.
    let mut resets: Vec<(String, f64)> = Vec::new();
    if let Some(rollups) = rollups {
        for (identity, windows) in &rollups.windows {
            for w in windows {
                if let Some(who) = owner.get(identity) {
                    let time = date_parse(&w.reset_at);
                    if within(time) {
                        resets.push((who.clone(), time));
                    }
                }
            }
        }
    }
    sort_by(&mut resets, |a, b| a.1 - b.1);
    // Every pair of two accounts' resets within the gap, not only neighbours.
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for i in 0..resets.len() {
        for j in i + 1..resets.len() {
            if resets[j].1 - resets[i].1 > CLOCKS_MAX_GAP_MS {
                break;
            }
            if resets[j].0 != resets[i].0 {
                pairs.push((i, j));
            }
        }
    }
    if let Some(first) = pairs.first() {
        let gap = |p: &(usize, usize)| resets[p.1].1 - resets[p.0].1;
        let closest = pairs.iter().skip(1).fold(*first, |best, pair| if gap(pair) < gap(&best) { *pair } else { best });
        found.push(LostMoment::Clocks {
            at: iso(resets[closest.0].1),
            account_ids: vec![resets[closest.0].0.clone(), resets[closest.1].0.clone()],
            gap_minutes: round(gap(&closest) / MINUTE_MS),
            count: pairs.len() as f64,
        });
    }

    // Spare: accounts never used while the others ran into five-hour limits.
    if !five_hour_hits.is_empty() {
        let mut used: Vec<&String> = Vec::new();
        for time in &active_hours {
            for who in hours_at(*time).keys() {
                if !used.contains(&who) {
                    used.push(who);
                }
            }
        }
        let idle: Vec<String> = accounts
            .iter()
            .filter(|a| {
                history_identity(a).is_some_and(|identity| owner.get(&identity) == Some(&a.id))
                    && date_parse(&a.created_at) < from
                    && !used.contains(&&a.id)
            })
            .map(|a| a.id.clone())
            .collect();
        if !idle.is_empty() && !used.is_empty() {
            found.push(LostMoment::Spare { account_ids: idle, hits: five_hour_hits.len() as f64 });
        }
    }

    // Feather: hours after midnight; the latest is the one nearest morning.
    let night_hour = |time: f64| local_hour(middle(time), zone);
    let night: Vec<f64> = active_hours.iter().copied().filter(|t| night_hour(*t) < NIGHT_END_HOUR).collect();
    if let Some(first) = night.first() {
        let latest_night = night.iter().skip(1).fold(*first, |best, time| if night_hour(*time) >= night_hour(best) { *time } else { best });
        found.push(LostMoment::Feather { at: iso(latest_night), hours: night.len() as f64 });
    }

    // Tea glass: hours after the night and before eight; the earliest is the one nearest dawn.
    let morning: Vec<f64> = active_hours
        .iter()
        .copied()
        .filter(|t| {
            let hour = night_hour(*t);
            hour >= NIGHT_END_HOUR && hour < MORNING_END_HOUR
        })
        .collect();
    if let Some(first) = morning.first() {
        let earliest = morning.iter().skip(1).fold(*first, |best, time| if night_hour(*time) < night_hour(best) { *time } else { best });
        found.push(LostMoment::Teaglass { at: iso(earliest), hours: morning.len() as f64 });
    }

    // What the token ledger says each moment used.
    let day_spend = |date: &str| -> LostSpend {
        let (mut tokens, mut cost) = (0.0, 0.0);
        if let Some(by_who) = input.ledger_days.get(date) {
            for by_model in by_who.values() {
                for c in by_model.values() {
                    tokens += tokens_in(c.input, c.output, c.cache_write, c.cache_read);
                    cost += c.cost.unwrap_or(0.0);
                }
            }
        }
        LostSpend { tokens, cost }
    };
    let sum_spend = |list: &[LostSpend]| {
        list.iter().fold(LostSpend::default(), |sum, s| LostSpend { tokens: sum.tokens + s.tokens, cost: sum.cost + s.cost })
    };
    let week_spend = |monday: &str| {
        let days: Vec<LostSpend> = (0..7).map(|i| day_spend(&add_days(monday, f64::from(i)))).collect();
        sum_spend(&days)
    };
    let quarter_spend = |quarters: &[f64]| -> Option<LostSpend> {
        let slots = input.ledger_slots?;
        let since = input.slots_since?;
        if quarters.is_empty() {
            return None;
        }
        let mut seen: HashSet<String> = HashSet::new();
        let (mut tokens, mut cost) = (0.0, 0.0);
        for time in quarters {
            if *time < since {
                return None;
            }
            let date = local_date(*time, zone);
            // A day without kept quarters is only known when it used nothing at all.
            let Some(by_who) = slots.get(&date) else {
                if day_spend(&date).tokens > 0.0 {
                    return None;
                }
                continue;
            };
            let slot = super::types::js::number_string(local_slot(*time, zone));
            if !seen.insert(format!("{date}|{slot}")) {
                continue;
            }
            for by_slot in by_who.values() {
                let Some(c) = by_slot.get(&slot) else { continue };
                tokens += tokens_in(c.input, c.output, c.cache_write, c.cache_read);
                cost += c.cost;
            }
        }
        Some(LostSpend { tokens, cost })
    };
    let hour_quarters =
        |starts: &[f64]| -> Vec<f64> { starts.iter().flat_map(|h| (0..4).map(move |q| h + f64::from(q) * QUARTER_MS)).collect() };
    let span_quarters = |from_time: f64, to_time: f64| -> Vec<f64> {
        let mut quarters = Vec::new();
        let mut time = (from_time / QUARTER_MS).floor() * QUARTER_MS;
        while time < to_time {
            quarters.push(time);
            time += QUARTER_MS;
        }
        quarters
    };

    // Tightrope: the fullest five-hour window that never hit its limit.
    let mut tightrope: Option<(String, Option<String>, f64)> = None;
    if let Some(rollups) = rollups {
        for (identity, windows) in &rollups.windows {
            for window in windows {
                let reset = date_parse(&window.reset_at);
                if !within(reset) || !(window.max_percent >= TIGHTROPE_MIN_PERCENT) || window.max_percent >= 100.0 {
                    continue;
                }
                let hit = hits.iter().any(|h| {
                    h.identity == *identity
                        && h.kind == LimitHitKind::FiveHour
                        && h.reset_at.as_deref().is_some_and(|r| same_reset(r, &window.reset_at))
                });
                let percent = window.max_percent.floor();
                if hit || tightrope.as_ref().is_some_and(|t| percent <= t.2) {
                    continue;
                }
                tightrope = Some((iso(reset), owner.get(identity).cloned().filter(|a| !a.is_empty()), percent));
            }
        }
    }
    if let Some((at, account_id, percent)) = tightrope {
        found.push(LostMoment::Tightrope { at, account_id, percent });
    }

    // Lantern: active on both days of the weekend, for some hours.
    let weekend: Vec<f64> = active_hours
        .iter()
        .copied()
        .filter(|t| {
            let date = local_date(middle(*t), zone);
            date == week_days[5] || date == week_days[6]
        })
        .collect();
    let weekend_days: HashSet<String> = weekend.iter().map(|t| local_date(middle(*t), zone)).collect();
    if weekend_days.len() == 2 && weekend.len() >= LANTERN_MIN_HOURS {
        found.push(LostMoment::Lantern { hours: weekend.len() as f64 });
    }

    // Hammock: a working day off between two active days, in a busy week.
    let active: Vec<bool> = week_days.iter().map(|d| by_day.contains_key(d)).collect();
    let active_days = active.iter().filter(|a| **a).count();
    if active_days >= HAMMOCK_MIN_DAYS
        && let Some(rest) = [1, 2, 3, 4].into_iter().find(|&i| !active[i] && active[i - 1] && active[i + 1])
    {
        found.push(LostMoment::Hammock { date: week_days[rest].clone(), active_days: active_days as f64 });
    }

    // Scales: two or more accounts carried nearly equal shares of the week.
    let mut shares: IndexMap<String, f64> = IndexMap::new();
    for row in hours.values() {
        for (who, points) in row {
            if known(who) {
                *shares.entry(who.clone()).or_insert(0.0) += points;
            }
        }
    }
    let share_total: f64 = shares.values().fold(0.0, |a, b| a + b);
    if shares.len() >= 2 && active_hours.len() >= SCALES_MIN_HOURS && share_total > 0.0 {
        let mut percents: Vec<(String, f64)> =
            shares.iter().map(|(who, points)| (who.clone(), (points / share_total) * 100.0)).collect();
        sort_by(&mut percents, |a, b| b.1 - a.1);
        let high = round(percents[0].1);
        let low = round(percents[percents.len() - 1].1);
        if high - low <= SCALES_MAX_SPREAD {
            found.push(LostMoment::Scales { account_ids: percents.into_iter().map(|p| p.0).collect(), low, high });
        }
    }

    // Chest: the week's API value beat every earlier week in reach, clearly ahead of an ordinary one.
    let this_week = week_spend(&start);
    if this_week.cost > 0.0 {
        let earlier: Vec<f64> = (0..LOST_FOUND_WEEKS - 1)
            .map(|i| week_spend(&add_days(&start, -7.0 * f64::from(i + 1))).cost)
            .filter(|c| *c > 0.0)
            .collect();
        let mut sorted = earlier.clone();
        sort_by(&mut sorted, |a, b| a - b);
        let times = match sorted.get(sorted.len() / 2) {
            Some(o) if *o > 0.0 => this_week.cost / o,
            _ => 0.0,
        };
        if earlier.len() >= CHEST_MIN_WEEKS && this_week.cost > max(earlier.iter().copied()) && times >= CHEST_MIN_TIMES {
            found.push(LostMoment::Chest {
                cost: round2(this_week.cost),
                tokens: this_week.tokens,
                times: round(times * 10.0) / 10.0,
            });
        }
    }

    // Piggy bank: an account's API value that week paid for its plan's month; the best is shown.
    let mut account_cost: IndexMap<String, f64> = IndexMap::new();
    for date in &week_days {
        let Some(by_who) = input.ledger_days.get(date) else { continue };
        for (who, by_model) in by_who {
            let Some(id) = ledger_account(who) else { continue };
            for c in by_model.values() {
                *account_cost.entry(id.to_string()).or_insert(0.0) += c.cost.unwrap_or(0.0);
            }
        }
    }
    let mut piggy: Option<(String, f64, f64)> = None;
    for (id, cost) in &account_cost {
        let plan = accounts.iter().find(|a| a.id == *id).and_then(|a| a.planning.as_ref()).map(|p| p.plan);
        let Some(price) = plan.and_then(plan_price) else { continue };
        if *cost < price {
            continue;
        }
        if piggy.as_ref().is_some_and(|p| cost / price <= p.1 / p.2) {
            continue;
        }
        piggy = Some((id.clone(), round2(*cost), price));
    }
    if let Some((account_id, cost, price)) = piggy {
        found.push(LostMoment::Piggy { account_id, cost, price });
    }

    // Fan: three or more model families each did a real share of the week's tokens.
    let mut families: IndexMap<String, f64> = IndexMap::new();
    let mut week_tokens = 0.0;
    for date in &week_days {
        let Some(by_who) = input.ledger_days.get(date) else { continue };
        for by_model in by_who.values() {
            for (model, c) in by_model {
                let tokens = tokens_in(c.input, c.output, c.cache_write, c.cache_read);
                week_tokens += tokens;
                if let Some(family) = model_family(model) {
                    *families.entry(family).or_insert(0.0) += tokens;
                }
            }
        }
    }
    let mut fan: Vec<(String, f64)> =
        families.into_iter().filter(|(_, tokens)| week_tokens > 0.0 && tokens / week_tokens >= FAN_MIN_SHARE).collect();
    sort_by(&mut fan, |a, b| b.1 - a.1);
    if fan.len() >= 3 {
        found.push(LostMoment::Fan { families: fan.into_iter().map(|f| f.0).collect() });
    }

    let spend_of = |item: &LostMoment| -> Option<LostSpend> {
        match item {
            LostMoment::Hourglass { at, minutes, .. } => {
                let at = date_parse(at);
                quarter_spend(&span_quarters(at - minutes * MINUTE_MS, at))
            }
            LostMoment::Scroll { at, hours } => {
                let starts: Vec<f64> = (0..*hours as usize).map(|i| date_parse(at) + i as f64 * HOUR_MS).collect();
                quarter_spend(&hour_quarters(&starts))
            }
            LostMoment::Feather { .. } => quarter_spend(&hour_quarters(&night)),
            LostMoment::Teaglass { .. } => quarter_spend(&hour_quarters(&morning)),
            LostMoment::Lantern { .. } => Some(sum_spend(&[day_spend(&week_days[5]), day_spend(&week_days[6])])),
            LostMoment::Trophy { date, .. } | LostMoment::Scarf { date, .. } => Some(day_spend(date)),
            LostMoment::Tally { .. } | LostMoment::Compass { .. } | LostMoment::Scales { .. } => Some(this_week),
            _ => None,
        }
    };
    let mut items: Vec<LostItem> = found
        .into_iter()
        .map(|moment| {
            let spend = spend_of(&moment).filter(|s| s.tokens > 0.0).map(|s| LostSpend { tokens: s.tokens, cost: round2(s.cost) });
            LostItem { moment, spend }
        })
        .collect();
    let rank = |kind: LostItemKind| LOST_ITEM_KINDS.iter().position(|k| *k == kind).unwrap_or(0) as f64;
    sort_by(&mut items, |a, b| rank(a.moment.kind()) - rank(b.moment.kind()));
    LostFoundWeek { start, end, latest, oldest, items }
}

/// One find: the week it was found in and what happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LostFind {
    /// The week's Monday.
    pub start: String,
    /// Its Sunday.
    pub end: String,
    pub item: LostItem,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LostFoundCollection {
    /// Monday of the newest complete week.
    pub latest: String,
    /// Monday of the oldest week in reach.
    pub oldest: String,
    /// Each kind's finds within reach, newest first; a kind never found is missing.
    pub found: IndexMap<LostItemKind, Vec<LostFind>>,
}

/// What every week within reach left behind, by kind (`week_start` is ignored).
pub fn lost_found_collection(input: &LostFoundInput<'_>) -> LostFoundCollection {
    let newest = lost_found_week(&LostFoundInput { week_start: None, ..*input });
    let mut found: IndexMap<LostItemKind, Vec<LostFind>> = IndexMap::new();
    let mut start = newest.latest.clone();
    while start.as_str() >= newest.oldest.as_str() {
        let other;
        let week = if start == newest.start {
            &newest
        } else {
            other = lost_found_week(&LostFoundInput { week_start: Some(&start), ..*input });
            &other
        };
        for item in &week.items {
            found.entry(item.moment.kind()).or_default().push(LostFind {
                start: week.start.clone(),
                end: week.end.clone(),
                item: item.clone(),
            });
        }
        start = add_days(&start, -7.0);
    }
    LostFoundCollection { latest: newest.latest, oldest: newest.oldest, found }
}
