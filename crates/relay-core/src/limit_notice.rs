//! Port of `electron/core/limit-notice.ts`: the notices about the 5-hour and weekly limits.

use std::collections::HashMap;
use std::path::PathBuf;

use indexmap::IndexMap;
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use crate::shared::notifications::notification_settings;
use crate::shared::types::js::{JsMap, date_parse, iso};
use crate::shared::types::{
    Account, AccountUsage, LimitResetNotice, NotificationSettings, RelaySettings, UsageWindow,
    literal_enum,
};

literal_enum!(LimitWindowKind { FiveHour = "five_hour", SevenDay = "seven_day" });

/// The settings the notices read: `Pick<RelaySettings, "usageWarnings" | "usageWarningPercent" |
/// "notifications">`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitNoticeSettings {
    pub usage_warnings: bool,
    pub usage_warning_percent: u32,
    pub notifications: Option<NotificationSettings>,
}

impl From<&RelaySettings> for LimitNoticeSettings {
    fn from(settings: &RelaySettings) -> Self {
        LimitNoticeSettings {
            usage_warnings: settings.usage_warnings,
            usage_warning_percent: settings.usage_warning_percent,
            notifications: settings.notifications,
        }
    }
}

type Notify = Box<dyn Fn(&Account, LimitWindowKind, &UsageWindow) + Send>;
type Ready = Box<dyn Fn(&Account, LimitWindowKind) + Send>;

pub struct LimitNoticeDeps {
    pub settings: Box<dyn Fn() -> LimitNoticeSettings + Send>,
    /// The account the Claude app is signed in to now: only its limits are worth a warning.
    pub in_use: Box<dyn Fn() -> Option<String> + Send>,
    pub notify: Notify,
    /// Says that a window which reached the warning threshold has reset: the account is ready again.
    pub ready: Ready,
    /// Where the resets awaited and told are kept (userData/limit-notices.json), so a restart neither
    /// repeats a "ready again" nor forgets a window that filled before it. `None` keeps them in memory.
    pub file: Option<Box<dyn Fn() -> PathBuf + Send>>,
    pub now: Option<Box<dyn Fn() -> f64 + Send>>,
}

/// How far under the threshold a window must fall before it can tell again: in practice, its reset.
pub const REARM_MARGIN: f64 = 10.0;
/// Reset times drift by seconds to minutes between reads; within this they name the same reset.
pub const SAME_RESET_MS: f64 = 15.0 * 60_000.0;
/// A reset noticed later than this after it happened (Relay was closed or asleep) is old news and
/// not told.
pub const READY_FRESH_MS: f64 = 60.0 * 60_000.0;
/// Windows remembered at most; removed accounts' entries fall out first.
const MAX_WINDOWS: usize = 400;

/// Per account and window: the reset awaited since it reached the threshold, and the last one told
/// or passed. `told_first` keeps the key order the TS object spread gives (`{ told, awaiting }`
/// when a told entry starts awaiting again), so the saved file reads the same.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ResetMemory {
    awaiting: Option<String>,
    told: Option<String>,
    told_first: bool,
}

impl Serialize for ResetMemory {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        let told = |map: &mut S::SerializeMap| match &self.told {
            Some(t) => map.serialize_entry("told", t),
            None => Ok(()),
        };
        if self.told_first {
            told(&mut map)?;
        }
        if let Some(a) = &self.awaiting {
            map.serialize_entry("awaiting", a)?;
        }
        if !self.told_first {
            told(&mut map)?;
        }
        map.end()
    }
}

#[derive(Serialize)]
struct SavedNotices<'a> {
    version: u32,
    windows: &'a IndexMap<String, ResetMemory>,
}

/// The warning tells once when the account in use crosses the warning threshold. Only a crossing
/// counts: a reading already past the threshold when Relay starts, or when the user switches to
/// that account, says nothing, so a restart never repeats it. Once told, a window tells again only
/// after it falls well under the threshold (its reset). A gateway answer (a fraction) and a later
/// poll (whole, sometimes older) can disagree by a point around the threshold; that must not read
/// as a second crossing. Reset times are not compared: they drift by seconds between reads.
///
/// "Ready again" tells once when a window that reached the threshold resets. The reset awaited and
/// the last reset told are saved, so a restart does not tell it twice, and an older poll still
/// showing the full window after the reset does not await it again.
pub struct LimitNotices {
    /// Per account and window: whether a crossing would tell now.
    armed: HashMap<String, bool>,
    memory: Option<IndexMap<String, ResetMemory>>,
    deps: LimitNoticeDeps,
}

impl LimitNotices {
    pub fn new(deps: LimitNoticeDeps) -> Self {
        LimitNotices {
            armed: HashMap::new(),
            memory: None,
            deps,
        }
    }

    pub fn observe(&mut self, account: &Account, usage: &AccountUsage) {
        let settings = (self.deps.settings)();
        let choices = notification_settings(settings.notifications.as_ref());
        let threshold = f64::from(settings.usage_warning_percent);
        let in_use = (self.deps.in_use)().as_deref() == Some(account.id.as_str());
        let windows = [
            (
                LimitWindowKind::FiveHour,
                usage.five_hour.as_ref(),
                choices.limit_five_hour,
            ),
            (
                LimitWindowKind::SevenDay,
                usage.seven_day.as_ref(),
                choices.limit_weekly,
            ),
        ];
        for (kind, window, enabled) in windows {
            let Some(window) = window else { continue };
            let key = format!("{}:{}", account.id, kind.as_str());
            let watched = enabled && settings.usage_warnings && in_use;
            self.warn(account, kind, window, &key, threshold, watched);
            let ready_for = choices.limit_reset == LimitResetNotice::All
                || (choices.limit_reset == LimitResetNotice::InUse && in_use);
            self.watch_reset(account, kind, window, &key, threshold, enabled && ready_for);
        }
    }

    fn warn(
        &mut self,
        account: &Account,
        kind: LimitWindowKind,
        window: &UsageWindow,
        key: &str,
        threshold: f64,
        watched: bool,
    ) {
        let used = window.used_percent;
        match self.armed.get(key).copied() {
            // The first reading only arms: under the threshold it can tell later, past it it cannot.
            None => {
                self.armed.insert(key.to_string(), used < threshold);
            }
            Some(_) if used < threshold - REARM_MARGIN => {
                self.armed.insert(key.to_string(), true);
            }
            Some(true) if used >= threshold => {
                // Disarmed whether told or not: an account crossing while not in use says nothing later.
                self.armed.insert(key.to_string(), false);
                if watched {
                    (self.deps.notify)(account, kind, window);
                }
            }
            Some(_) => {}
        }
    }

    fn watch_reset(
        &mut self,
        account: &Account,
        kind: LimitWindowKind,
        window: &UsageWindow,
        key: &str,
        threshold: f64,
        tell: bool,
    ) {
        let state = self.load().get(key).cloned().unwrap_or_default();
        let reset_at = match window.resets_at.as_deref() {
            Some(at) if !at.is_empty() => date_parse(at),
            _ => f64::NAN,
        };
        let told = match state.told.as_deref() {
            Some(t) if !t.is_empty() => date_parse(t),
            _ => f64::NEG_INFINITY,
        };
        let awaiting = state
            .awaiting
            .as_deref()
            .filter(|a| !a.is_empty())
            .map(date_parse);
        if window.used_percent >= threshold {
            // Without a reset time there is no reset to wait for; one already told is an older reading.
            if !reset_at.is_finite() || reset_at <= told + SAME_RESET_MS {
                return;
            }
            if awaiting.is_some_and(|a| (reset_at - a).abs() < SAME_RESET_MS) {
                return;
            }
            let told_first = state.told.is_some() && (state.told_first || state.awaiting.is_none());
            self.save(
                key,
                ResetMemory {
                    awaiting: Some(iso(reset_at)),
                    told: state.told,
                    told_first,
                },
            );
            return;
        }
        let Some(awaiting) = awaiting else { return };
        if window.used_percent >= threshold - REARM_MARGIN {
            return;
        }
        let now = self
            .deps
            .now
            .as_ref()
            .map_or_else(|| crate::clock::now_ms() as f64, |now| now());
        // Well under the threshold: a reset once its time came, or earlier when a later window began.
        let reset = now >= awaiting - SAME_RESET_MS
            || (reset_at.is_finite() && reset_at > awaiting + SAME_RESET_MS);
        if !reset {
            return;
        }
        // Saved before telling: a failed notification must not tell again after a restart.
        self.save(
            key,
            ResetMemory {
                awaiting: None,
                told: state.awaiting,
                told_first: false,
            },
        );
        if tell && now - awaiting <= READY_FRESH_MS {
            (self.deps.ready)(account, kind);
        }
    }

    fn load(&mut self) -> &mut IndexMap<String, ResetMemory> {
        if self.memory.is_none() {
            let mut memory = IndexMap::new();
            if let Some(file) = &self.deps.file {
                // Missing (a first run) or unreadable: start empty; the worst case is one missed
                // "ready again".
                if let Ok(saved) = read_private_json(&file(), MAX_BYTES) {
                    load_windows(&saved, &mut memory);
                }
            }
            self.memory = Some(memory);
        }
        self.memory.get_or_insert_with(IndexMap::new)
    }

    fn save(&mut self, key: &str, entry: ResetMemory) {
        let memory = self.load();
        memory.shift_remove(key);
        memory.insert(key.to_string(), entry);
        while memory.len() > MAX_WINDOWS {
            memory.shift_remove_index(0);
        }
        let Some(file) = &self.deps.file else { return };
        let saved = SavedNotices {
            version: 1,
            windows: self.memory.as_ref().expect("loaded above"),
        };
        // Kept in memory: a failed write must not stop the usage reading that called here.
        let _ = write_private_json(&file(), &saved, MAX_BYTES);
    }
}

/// `Object.entries(saved?.windows ?? {})`, keeping valid dates only.
fn load_windows(saved: &Value, memory: &mut IndexMap<String, ResetMemory>) {
    let entries: Vec<(String, Value)> = match saved.get("windows") {
        Some(Value::Object(map)) => map
            .clone()
            .into_iter()
            .collect::<JsMap<Value>>()
            .into_iter()
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        _ => Vec::new(),
    };
    let valid = |v: Option<&Value>| {
        v.and_then(Value::as_str)
            .filter(|s| date_parse(s).is_finite())
            .map(str::to_string)
    };
    for (key, value) in entries {
        let Value::Object(value) = value else {
            continue;
        };
        memory.insert(
            key,
            ResetMemory {
                awaiting: valid(value.get("awaiting")),
                told: valid(value.get("told")),
                told_first: false,
            },
        );
    }
}
