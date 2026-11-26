//! Port of `electron/core/store.ts`: the account registry (`state.json`), its schemas, and the
//! write recipe Relay's processes share under `state.lock`.

pub mod schema;

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use self::schema::{
    IssueCode, NumberRule, PathKey, Schema, SchemaError, StringRule, any_string, array, boolean,
    datetime, enumeration, literal, number, object, partial_record, record, strict, string, union,
    uuid,
};
use crate::clock::now_ms;
use crate::desktop_files::is_uuid;
use crate::fs_util::{
    FileId, create_new_private, create_private_dir_all, iso_timestamp, mtime_ms, safe_integer,
    set_mode,
};
use crate::process_lock::{LockBy, ProcessLock, ProcessLockError};
use crate::shared::browser_extension::{
    BROWSER_APPS, EXTENSION_MODES, ExtensionMode, is_profile_folder,
};
use crate::shared::feature_risk::FEATURE_RISK_IDS;
use crate::shared::meters::METER_PROVIDERS;
use crate::shared::planning::{default_planning, is_clock, system_time_zone};
use crate::shared::proxy_types::DEFAULT_AFFINITY_TTL_SECONDS;
use crate::shared::remote_notify::{REMOTE_NOTIFY_URL_MAX, remote_notify_url};
use crate::shared::shortcuts::normalize_accelerator;
use crate::shared::terminal_identity::TERMINAL_MODES;
use crate::shared::time_zones::valid_time_zone;
use crate::shared::types::js::{JsMap, Num};
use crate::shared::types::{
    Account, AccountKind, AccountProvider, CreateAccount, DesktopHistoryTransfer, PlanningAccount,
    PlanningHours, PlanningSettings, RelaySettings, default_planning_settings, default_settings,
};

/// The registry layout this build writes (see the TS for each bump). A file without the field
/// was written before 0.12 and counts as 1.
pub const STATE_SCHEMA: i64 = 8;
/// A new install starts with "same-group"; a saved registry that never wrote the mode shared
/// across all accounts, and keeps doing so.
const SAVED_WITHOUT_HISTORY_MODE: &str = "all";
const MAX_ACCOUNTS: usize = 50;

/// The registry, in `stateSchema`'s key order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// Always 1.
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<i64>,
    pub settings: RelaySettings,
    pub accounts: Vec<Account>,
    pub pinned: Vec<String>,
    pub import_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    /// Where Claude Desktop is, when the user chose it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_app: Option<String>,
    pub lineage: JsMap<String>,
    #[serde(default)]
    pub auto_switch_completed: JsMap<Num>,
}

// ---------------------------------------------------------------------------------------------
// Schemas

fn names<T: Serialize>(items: impl IntoIterator<Item = T>) -> Vec<String> {
    items
        .into_iter()
        .filter_map(|item| {
            serde_json::to_value(item)
                .ok()?
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

fn int(min: f64, max: f64) -> Schema {
    number(NumberRule {
        int: true,
        min: Some(min),
        max: Some(max),
    })
}

fn text(min: Option<usize>, max: Option<usize>) -> Schema {
    string(StringRule {
        min,
        max,
        ..Default::default()
    })
}

fn trimmed(min: usize, max: usize) -> Schema {
    string(StringRule {
        trim: true,
        min: Some(min),
        max: Some(max),
        ..Default::default()
    })
}

fn clock() -> Schema {
    string(StringRule {
        pattern: Some(is_clock),
        ..Default::default()
    })
}

fn unique_by(list: &Value, key: impl Fn(&Value) -> Value) -> bool {
    let items = list.as_array().map(Vec::as_slice).unwrap_or_default();
    let mut seen = HashSet::new();
    items.iter().all(|item| seen.insert(key(item).to_string()))
}

/// `accountPlanningSchema`.
pub fn account_planning_schema() -> Schema {
    strict(vec![
        (
            "plan",
            enumeration(["unknown", "pro", "max5", "max20", "team"]),
        ),
        (
            "capacityWeight",
            number(NumberRule {
                int: false,
                min: Some(1.0),
                max: Some(100.0),
            }),
        ),
    ])
}

/// `extensionSettingSchema`.
pub fn extension_setting_schema() -> Schema {
    strict(vec![
        ("mode", enumeration(names(EXTENSION_MODES))),
        (
            "browser",
            strict(vec![
                ("app", enumeration(names(BROWSER_APPS))),
                (
                    "profile",
                    string(StringRule {
                        pattern: Some(is_profile_folder),
                        ..Default::default()
                    }),
                ),
            ])
            .optional(),
        ),
    ])
}

/// `timeZoneSchema`: a zone `Intl.DateTimeFormat` accepts.
pub fn time_zone_schema() -> Schema {
    text(Some(1), Some(100)).refine(
        |v| v.as_str().is_some_and(valid_time_zone),
        "Choose a valid time zone.",
    )
}

fn hours_schema() -> Schema {
    strict(vec![
        ("enabled", boolean()),
        ("start", clock()),
        ("end", clock()),
    ])
}

/// `planningSchema`.
pub fn planning_schema() -> Schema {
    strict(vec![
        ("autoStart", boolean()),
        ("timeZone", time_zone_schema()),
        ("weekday", hours_schema()),
        ("weekend", hours_schema()),
        (
            "accounts",
            array(
                strict(vec![("id", uuid()), ("firstStart", clock().optional())]),
                Some(50),
            )
            .refine(
                |list| unique_by(list, |a| a["id"].clone()),
                "Select each account once.",
            ),
        ),
        // No default: a partial patch must keep the stored choice.
        (
            "tempo",
            enumeration(["auto", "light", "medium", "heavy"]).optional(),
        ),
        ("adaptive", boolean().optional()),
    ])
}

/// `planningPatchSchema`.
pub fn planning_patch_schema() -> Schema {
    planning_schema().partial()
}

/// `accountSchema`: one saved account (unknown keys dropped).
pub fn account_schema() -> Schema {
    object(vec![
        ("id", uuid()),
        ("name", text(Some(1), Some(64))),
        ("kind", enumeration(["personal", "work"])),
        ("group", text(Some(1), Some(69))),
        ("color", any_string()),
        ("createdAt", datetime()),
        // "gemini" is only read: nothing creates one.
        (
            "provider",
            enumeration(["claude", "codex", "antigravity", "gemini"]).optional(),
        ),
        ("cooldownUntil", datetime().optional()),
        ("planning", account_planning_schema().optional()),
        ("switchAtPercent", int(50.0, 100.0).optional()),
        (
            "desktop",
            object(vec![
                ("accountUuid", uuid()),
                ("orgId", uuid()),
                ("savedAt", datetime()),
                ("email", text(None, Some(254)).optional()),
                ("rejectedAt", datetime().optional()),
            ])
            .optional(),
        ),
        (
            "auth",
            object(vec![
                ("loggedIn", boolean()),
                ("email", any_string().optional()),
                ("accountUuid", uuid().optional()),
                ("orgId", uuid().optional()),
                ("orgName", text(None, Some(150)).optional()),
                ("subscription", any_string().optional()),
                (
                    "plan",
                    enumeration(["pro", "max5", "max20", "team"]).optional(),
                ),
                ("checkedAt", any_string()),
                ("error", any_string().optional()),
            ])
            .optional(),
        ),
    ])
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}')
}

/// `proxyConfigSchema`: where the gateway listens, how it routes, and its client key.
pub fn proxy_config_schema() -> Schema {
    strict(vec![
        ("enabled", boolean()),
        ("port", int(1.0, 65_535.0)),
        (
            "host",
            trimmed(1, 255).refine(
                |v| {
                    !v.as_str()
                        .unwrap_or_default()
                        .chars()
                        .any(|c| js_space(c) || "/@?#".contains(c))
                },
                "Not a host address",
            ),
        ),
        (
            "affinityTtlSeconds",
            int(10.0, 3_600.0).default_to(|| json!(DEFAULT_AFFINITY_TTL_SECONDS)),
        ),
        (
            "routingStrategy",
            enumeration(["soonest-reset", "balanced", "strict-priority"])
                .default_to(|| json!("soonest-reset")),
        ),
        ("apiKey", text(Some(1), Some(200)).optional()),
    ])
}

fn literals(values: &[i64]) -> Schema {
    union(values.iter().map(|v| literal(json!(v))).collect())
}

/// `settingsSchema`.
pub fn settings_schema() -> Schema {
    strict(vec![
        (
            "appearance",
            enumeration(["system", "light", "dark"]).default_to(|| json!("system")),
        ),
        // No default: a patch keeps the stored choice.
        ("proxy", proxy_config_schema().optional()),
        ("planning", planning_schema()),
        ("usageRefreshMinutes", literals(&[0, 5, 15, 30])),
        ("usageWarningPercent", literals(&[80, 90, 95])),
        ("usageWarnings", boolean()),
        ("suggestAccounts", boolean()),
        (
            "desktopHistoryTransfer",
            enumeration(["all", "same-group", "selected", "off"]),
        ),
        (
            "desktopHistoryAccounts",
            array(uuid(), Some(50)).default_to(|| json!([])),
        ),
        (
            "autoSwitchMode",
            enumeration(["off", "after-exit"]).default_to(|| json!("off")),
        ),
        (
            "autoSwitchAccounts",
            array(uuid(), Some(50)).default_to(|| json!([])),
        ),
        ("historyPolicyVersion", literal(json!(2)).optional()),
        ("menuBarAnimation", boolean().optional()),
        ("switchWindow", boolean().optional()),
        (
            "pranks",
            enumeration(["sometimes", "rarely", "off"]).optional(),
        ),
        ("draftRetype", boolean().optional()),
        ("claudeExtension", extension_setting_schema().optional()),
        ("terminalCli", enumeration(names(TERMINAL_MODES)).optional()),
        (
            "notifications",
            strict(vec![
                ("limitFiveHour", boolean().optional()),
                ("limitWeekly", boolean().optional()),
                (
                    "limitReset",
                    enumeration(["off", "in-use", "all"]).optional(),
                ),
                ("switches", boolean().optional()),
                ("signIns", boolean().optional()),
                ("earlyStart", boolean().optional()),
                ("updates", boolean().optional()),
            ])
            .optional(),
        ),
        ("launchAtLogin", boolean().optional()),
        ("updateChannel", enumeration(["stable", "beta"]).optional()),
        // A saved key Relay cannot read is skipped when registering, never a reason to reject the file.
        (
            "shortcuts",
            strict(vec![
                ("openPanel", text(None, Some(100)).optional()),
                ("switchToSuggested", text(None, Some(100)).optional()),
            ])
            .optional(),
        ),
        (
            "configSync",
            strict(vec![
                ("mcpServers", boolean()),
                ("skills", boolean()),
                ("settings", boolean()),
                ("claudeMd", boolean()),
            ])
            .optional(),
        ),
        (
            "autoSwitchStrategy",
            enumeration(["best", "weekly-first", "consume-first"]).optional(),
        ),
        (
            "remoteNotify",
            strict(vec![
                (
                    "url",
                    text(None, Some(REMOTE_NOTIFY_URL_MAX))
                        .refine(
                            |v| remote_notify_url(v.as_str()).is_some(),
                            "Use https, or http to this computer.",
                        )
                        .optional(),
                ),
                ("kind", enumeration(["ntfy", "webhook"])),
                (
                    "events",
                    strict(vec![
                        ("limit", boolean()),
                        ("reset", boolean()),
                        ("autoSwitch", boolean()),
                        ("signIn", boolean()),
                    ]),
                ),
            ])
            .optional(),
        ),
        (
            "meters",
            array(
                enumeration(names(METER_PROVIDERS)),
                Some(METER_PROVIDERS.len()),
            )
            .refine(|list| unique_by(list, Value::clone), "Each meter once.")
            .optional(),
        ),
        // A registry from before the risk notes has accepted none of them.
        (
            "riskAcknowledged",
            partial_record(
                enumeration(names(FEATURE_RISK_IDS)),
                number(NumberRule {
                    int: true,
                    min: Some(1.0),
                    max: None,
                }),
            )
            .default_to(|| json!({})),
        ),
    ])
}

fn accelerator_choice() -> Schema {
    any_string().refine(
        |v| {
            v.as_str().is_some_and(|key| {
                key.is_empty() || normalize_accelerator(key).as_deref() == Some(key)
            })
        },
        "Invalid input",
    )
}

/// `settingsPatchSchema`: what `updateSettings` may change. No defaults (a patch never resets a
/// stored choice); the gateway, planning and the accepted risks change through their own calls.
pub fn settings_patch_schema() -> Schema {
    let base = settings_schema();
    let undefaulted = |key: &str| {
        base.field(key)
            .cloned()
            .map(Schema::remove_default)
            .expect("settings field")
    };
    let replaced = vec![
        ("appearance", undefaulted("appearance")),
        (
            "desktopHistoryAccounts",
            undefaulted("desktopHistoryAccounts"),
        ),
        ("autoSwitchMode", undefaulted("autoSwitchMode")),
        ("autoSwitchAccounts", undefaulted("autoSwitchAccounts")),
        (
            "shortcuts",
            strict(vec![
                ("openPanel", accelerator_choice().optional()),
                ("switchToSuggested", accelerator_choice().optional()),
            ])
            .optional(),
        ),
    ];
    settings_schema()
        .extend_omit(replaced, &["proxy", "planning", "riskAcknowledged"])
        .partial()
}

/// Registries before 0.11 kept a workday block; 0.18.0 and 0.18.1 kept a live-switch setting and a
/// cross-provider switch that were removed.
fn prepare_settings(value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return value.clone();
    };
    let mut rest = map.clone();
    let workday = rest.shift_remove("workday");
    rest.shift_remove("cdpHotSwitch");
    if let Some(Value::Object(proxy)) = rest.get_mut("proxy") {
        proxy.shift_remove("allowCrossProviderFallback");
    }
    if !rest.contains_key("desktopHistoryTransfer") {
        rest.insert(
            "desktopHistoryTransfer".into(),
            json!(SAVED_WITHOUT_HISTORY_MODE),
        );
    }
    if !rest.contains_key("planning") {
        let planning = planning_from_workday(workday.as_ref());
        rest.insert(
            "planning".into(),
            serde_json::to_value(planning).unwrap_or(Value::Null),
        );
    }
    Value::Object(rest)
}

fn default_saved_settings() -> Value {
    let settings = RelaySettings {
        planning: default_planning(),
        desktop_history_transfer: DesktopHistoryTransfer::All,
        ..default_settings()
    };
    serde_json::to_value(settings).unwrap_or(Value::Null)
}

/// `stateSchema`.
pub fn state_schema_value() -> Schema {
    object(vec![
        ("version", literal(json!(1))),
        (
            "schema",
            number(NumberRule {
                int: true,
                min: Some(1.0),
                max: None,
            })
            .optional(),
        ),
        // A registry without settings never saved planning either: it plans in the system's zone.
        (
            "settings",
            settings_schema()
                .preprocess(prepare_settings)
                .default_to(default_saved_settings),
        ),
        ("accounts", array(account_schema(), Some(MAX_ACCOUNTS))),
        ("pinned", array(any_string(), None)),
        ("importEnabled", boolean()),
        ("executable", any_string().optional()),
        ("claudeApp", any_string().optional()),
        ("lineage", record(any_string(), any_string())),
        (
            "autoSwitchCompleted",
            record(
                text(None, Some(200)),
                number(NumberRule {
                    int: false,
                    min: Some(0.0),
                    max: None,
                }),
            )
            .refine(
                |v| v.as_object().is_some_and(|m| m.len() <= 100),
                "Invalid input",
            )
            .default_to(|| json!({})),
        ),
    ])
}

/// `createAccountSchema`.
pub fn create_account_schema() -> Schema {
    strict(vec![
        ("name", trimmed(1, 64)),
        ("kind", enumeration(["personal", "work"])),
        ("group", trimmed(1, 64).optional()),
        (
            "provider",
            enumeration(["claude", "codex", "antigravity"]).optional(),
        ),
    ])
}

static STATE_SCHEMA_CACHE: LazyLock<Schema> = LazyLock::new(state_schema_value);
static CREATE_ACCOUNT_SCHEMA: LazyLock<Schema> = LazyLock::new(create_account_schema);

/// The registry's schema, built once.
pub fn state_schema() -> &'static Schema {
    &STATE_SCHEMA_CACHE
}

/// `schema.parse(value)` into a Rust type. The schema's output always deserializes; a failure
/// there is reported as an issue at the root.
pub fn parse_as<T: DeserializeOwned>(schema: &Schema, value: &Value) -> Result<T, SchemaError> {
    let out = schema.parse(value)?;
    serde_json::from_value(out).map_err(|error| SchemaError {
        issues: vec![schema::Issue {
            code: IssueCode::Custom,
            path: Vec::new(),
            message: error.to_string(),
            continues: false,
        }],
    })
}

/// One-time conversion of the pre-0.11 workday settings.
pub fn planning_from_workday(raw: Option<&Value>) -> PlanningSettings {
    let empty = serde_json::Map::new();
    let w = raw.and_then(Value::as_object).unwrap_or(&empty);
    // No workday was ever saved: the new install's planning, in the system's time zone.
    if w.is_empty() {
        return default_planning();
    }
    let defaults = default_planning_settings();
    let clock_or = |value: Option<&Value>, fallback: &str| match value.and_then(Value::as_str) {
        Some(text) if is_clock(text) => text.to_string(),
        _ => fallback.to_string(),
    };
    let days: &[Value] = w
        .get("weekdays")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let start = clock_or(w.get("start"), &defaults.weekday.start);
    let end = clock_or(w.get("end"), &defaults.weekday.end);
    let time_zone = match w.get("timeZone") {
        Some(zone) if time_zone_schema().accepts(zone) => {
            zone.as_str().unwrap_or_default().to_string()
        }
        _ => system_time_zone(),
    };
    let account_ids = w.get("accountIds").and_then(Value::as_array);
    // The old screen saved its 00:00–00:00 every-day default even when unused; that is not a
    // request for 24-hour work days.
    if start == "00:00"
        && end == "00:00"
        && distinct(days) == 7
        && !account_ids.is_some_and(|ids| !ids.is_empty())
        && w.get("routineEnabled") != Some(&Value::Bool(true))
    {
        return PlanningSettings {
            time_zone,
            ..defaults
        };
    }
    let mut ids: Vec<String> = Vec::new();
    for id in account_ids.map(Vec::as_slice).unwrap_or_default() {
        if let Some(id) = id.as_str().filter(|id| is_uuid(id))
            && !ids.iter().any(|seen| seen == id)
        {
            ids.push(id.to_string());
        }
    }
    let weekday_day = |d: &Value| d.as_f64().is_some_and(|d| (1.0..=5.0).contains(&d));
    let weekend_day = |d: &Value| d.as_f64().is_some_and(|d| d == 0.0 || d == 6.0);
    PlanningSettings {
        auto_start: w.get("routineEnabled") == Some(&Value::Bool(true)),
        time_zone,
        weekday: PlanningHours {
            enabled: days.iter().any(weekday_day),
            start: start.clone(),
            end: end.clone(),
        },
        weekend: PlanningHours {
            enabled: days.iter().any(weekend_day),
            start,
            end,
        },
        accounts: ids
            .into_iter()
            .map(|id| PlanningAccount {
                id,
                first_start: None,
            })
            .collect(),
        tempo: None,
        adaptive: None,
    }
}

/// `new Set(values).size` for JSON values: objects and arrays are each their own.
fn distinct(values: &[Value]) -> usize {
    let mut seen = HashSet::new();
    let mut objects = 0;
    for value in values {
        match value {
            Value::Object(_) | Value::Array(_) => objects += 1,
            Value::Number(n) => {
                seen.insert(format!("n:{}", n.as_f64().unwrap_or(f64::NAN)));
            }
            other => {
                seen.insert(other.to_string());
            }
        }
    }
    seen.len() + objects
}

// ---------------------------------------------------------------------------------------------
// Errors

/// Why a registry write was refused: the file is newer than this build, or older than 0.12.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WriteRefusedReason {
    NewerSchema,
    Unversioned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("{}", match .reason {
    WriteRefusedReason::NewerSchema => "Relay’s account list was written by a newer version. Update this copy of Relay before changing it.",
    WriteRefusedReason::Unversioned => "Relay’s account list was written by Relay 0.11 or older. Update Relay.app to 0.12 or later and open it once.",
})]
pub struct StoreWriteRefused {
    pub reason: WriteRefusedReason,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Io(#[from] io::Error),
    /// The file is not JSON (`JSON.parse` threw).
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    /// A schema refused the value (`ZodError`).
    #[error(transparent)]
    Invalid(#[from] SchemaError),
    #[error(transparent)]
    WriteRefused(#[from] StoreWriteRefused),
    #[error(transparent)]
    Lock(#[from] ProcessLockError),
    #[error("Invalid settings file.")]
    InvalidFile,
    #[error("The data folder cannot be a symbolic link.")]
    SymlinkDataFolder,
    #[error("Account not found.")]
    AccountNotFound,
    #[error("En fazla 50 hesap eklenebilir.")]
    TooManyAccounts,
}

// ---------------------------------------------------------------------------------------------
// Store

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreOptions {
    /// Keep a copy of the registry at open (state-backups/, newest 20).
    pub backup_on_open: bool,
    /// Run open-time migrations, and stamp a missing schema.
    pub migrate_on_open: bool,
    /// Write over a file without a schema (pre-0.12).
    pub adopt_unversioned: bool,
    /// How long a write waits for another process's write.
    pub lock_wait_ms: u64,
    pub by: LockBy,
}

impl Default for StoreOptions {
    fn default() -> Self {
        StoreOptions {
            backup_on_open: true,
            migrate_on_open: true,
            adopt_unversioned: true,
            lock_wait_ms: 2000,
            by: LockBy::App,
        }
    }
}

impl StoreOptions {
    /// The relay CLI's options: no open-time backups or migrations.
    pub fn cli() -> Self {
        StoreOptions {
            backup_on_open: false,
            migrate_on_open: false,
            by: LockBy::Cli,
            ..Default::default()
        }
    }
}

/// A file's identity and stamp, to notice another process's write.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Seen {
    id: FileId,
    size: u64,
    mtime: f64,
}

fn seen(file: &Path) -> io::Result<Seen> {
    let meta = fs::symlink_metadata(file)?;
    Ok(Seen {
        id: FileId::of_path(file)?,
        size: meta.len(),
        mtime: mtime_ms(&meta)?,
    })
}

/// `privateDir`: a private folder that is not a symbolic link.
pub fn private_dir(dir: &Path) -> Result<(), StoreError> {
    create_private_dir_all(dir)?;
    if fs::symlink_metadata(dir)?.file_type().is_symlink() {
        return Err(StoreError::SymlinkDataFolder);
    }
    set_mode(dir, 0o700)?;
    Ok(())
}

/// `new Date().toISOString().replace(/[:.]/g, "-")`.
pub fn file_stamp(ms: i64) -> String {
    iso_timestamp(ms).replace([':', '.'], "-")
}

/// The registry. Every method takes `&self` (share it as `Arc<Store>`): the state is behind a
/// mutex, held for the whole of a write, so a change closure must not call back into the Store.
pub struct Store {
    pub root: PathBuf,
    pub file: PathBuf,
    options: StoreOptions,
    lock: ProcessLock,
    inner: Mutex<Inner>,
}

struct Inner {
    state: State,
    /// The schema of the file as last read; 1 for a file without one.
    file_schema: i64,
    /// The file as last read or written.
    seen: Option<Seen>,
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("file", &self.file)
            .field("file_schema", &self.file_schema())
            .finish()
    }
}

/// Parses a registry a newer build wrote: its unknown keys are dropped, in strict objects too.
/// Only a reader that never writes uses it.
fn parse_newer(raw: &Value) -> Result<State, StoreError> {
    let mut value = raw.clone();
    for _ in 0..50 {
        let error = match parse_as::<State>(state_schema(), &value) {
            Ok(state) => return Ok(state),
            Err(error) => error,
        };
        let unknown: Vec<_> = error
            .issues
            .iter()
            .filter_map(|issue| match &issue.code {
                IssueCode::UnrecognizedKeys(keys) => Some((issue.path.clone(), keys.clone())),
                _ => None,
            })
            .collect();
        if unknown.is_empty() {
            return Err(error.into());
        }
        for (path, keys) in unknown {
            if let Some(Value::Object(map)) = at_path(&mut value, &path) {
                for key in keys {
                    map.shift_remove(&key);
                }
            }
        }
    }
    Err(StoreError::InvalidFile)
}

/// The value at `path`, as `at?.[key]` walks it.
pub fn at_path<'a>(value: &'a mut Value, path: &[PathKey]) -> Option<&'a mut Value> {
    let mut at = value;
    for key in path {
        at = match (at, key) {
            (Value::Object(map), PathKey::Key(k)) => map.get_mut(k)?,
            (Value::Array(items), PathKey::Index(i)) => items.get_mut(*i)?,
            (Value::Object(map), PathKey::Index(i)) => map.get_mut(&i.to_string())?,
            _ => return None,
        };
    }
    Some(at)
}

fn new_state() -> State {
    State {
        version: 1,
        schema: None,
        settings: RelaySettings {
            planning: default_planning(),
            ..default_settings()
        },
        accounts: Vec::new(),
        pinned: Vec::new(),
        import_enabled: false,
        executable: None,
        claude_app: None,
        lineage: JsMap::new(),
        auto_switch_completed: JsMap::new(),
    }
}

impl Store {
    /// Opens the registry in `root` (made private), reading `state.json` when there is one.
    pub fn open(root: impl Into<PathBuf>, options: StoreOptions) -> Result<Store, StoreError> {
        let root = root.into();
        private_dir(&root)?;
        let file = root.join("state.json");
        let lock = ProcessLock::new(root.join("state.lock"), options.by);
        let inner = Inner {
            state: new_state(),
            file_schema: STATE_SCHEMA,
            seen: None,
        };
        let store = Store {
            root,
            file,
            options,
            lock,
            inner: Mutex::new(inner),
        };
        if store.file.exists() {
            store.load(&mut store.inner())?;
            if options.backup_on_open {
                store.backup();
            }
            if options.migrate_on_open {
                // Before version 2, history stayed inside a sharing group unless accounts were
                // picked; that choice moved to sharing across all accounts. An explicit
                // "selected" or "off" is kept; a new install starts in "same-group".
                if store.with_state(|s| s.settings.history_policy_version) != Some(2) {
                    store.update(|state| {
                        if state.settings.desktop_history_transfer
                            == DesktopHistoryTransfer::SameGroup
                        {
                            state.settings.desktop_history_transfer = DesktopHistoryTransfer::All;
                        }
                        state.settings.history_policy_version = Some(2);
                    })?;
                }
                // A registry from 0.11 or older gets its schema now, so a CLI next to this app
                // knows the app has been updated.
                if options.adopt_unversioned && store.file_schema() < STATE_SCHEMA {
                    store.update(|_| {})?;
                }
            }
        }
        private_dir(&store.root.join("profiles"))?;
        Ok(store)
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// A copy of the registry as last read or written.
    pub fn state(&self) -> State {
        self.inner().state.clone()
    }

    /// Reads the registry without copying it.
    pub fn with_state<R>(&self, read: impl FnOnce(&State) -> R) -> R {
        read(&self.inner().state)
    }

    /// The schema of the file as last read; 1 for a file without one.
    pub fn file_schema(&self) -> i64 {
        self.inner().file_schema
    }

    /// Reads the file. Fail closed: a corrupt registry must never silently discard saved profiles.
    fn load(&self, inner: &mut Inner) -> Result<(), StoreError> {
        let before = fs::symlink_metadata(&self.file)?;
        if before.file_type().is_symlink() {
            return Err(StoreError::InvalidFile);
        }
        let stamp = seen(&self.file)?;
        let raw: Value = serde_json::from_slice(&fs::read(&self.file)?)?;
        let schema = raw
            .get("schema")
            .and_then(safe_integer)
            .filter(|s| *s >= 1)
            .unwrap_or(1);
        let mut state = if schema > STATE_SCHEMA {
            parse_newer(&raw)?
        } else {
            parse_as::<State>(state_schema(), &raw)?
        };
        // Writing to a browser is opt-in: an older file's mode never turns into it silently.
        if schema < 5
            && let Some(extension) = state.settings.claude_extension.as_mut()
            && matches!(
                extension.mode,
                ExtensionMode::Restart | ExtensionMode::Closed
            )
        {
            extension.mode = ExtensionMode::Guide;
        }
        inner.state = state;
        inner.file_schema = schema;
        inner.seen = Some(stamp);
        Ok(())
    }

    /// Re-reads the file when another process changed it; true when it did.
    pub fn reload(&self) -> Result<bool, StoreError> {
        self.reload_into(&mut self.inner())
    }

    fn reload_into(&self, inner: &mut Inner) -> Result<bool, StoreError> {
        let Ok(stamp) = seen(&self.file) else {
            return Ok(false);
        };
        if inner.seen == Some(stamp) {
            return Ok(false);
        }
        self.load(inner)?;
        Ok(true)
    }

    /// Keeps the registry as it was at each start (last 20): another build can rewrite it with
    /// its own schema, and the single `.bak` rotates on every write. Never fails the open.
    fn backup(&self) {
        let _ = (|| -> Result<(), StoreError> {
            let dir = self.root.join("state-backups");
            private_dir(&dir)?;
            fs::copy(
                &self.file,
                dir.join(format!("state-{}.json", file_stamp(now_ms()))),
            )?;
            let mut saved: Vec<String> = fs::read_dir(&dir)?
                .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
                .filter(|name| backup_name(name))
                .collect();
            saved.sort();
            let excess = saved.len().saturating_sub(20);
            for old in &saved[..excess] {
                fs::remove_file(dir.join(old))?;
            }
            Ok(())
        })();
    }

    /// Changes the registry: under the lock shared with Relay's other processes, re-reads the
    /// file when another process wrote it, applies `change`, and writes the result with this
    /// build's schema. A newer file, or a pre-0.12 one when adopting is off, is never written.
    pub fn update(&self, change: impl FnOnce(&mut State)) -> Result<(), StoreError> {
        self.try_update(|state| {
            change(state);
            Ok::<(), StoreError>(())
        })
    }

    /// `update` with a change that can fail; a failed change writes nothing.
    pub fn try_update<T, E: From<StoreError>>(
        &self,
        change: impl FnOnce(&mut State) -> Result<T, E>,
    ) -> Result<T, E> {
        let mut inner = self.inner();
        self.lock
            .acquire("state", Duration::from_millis(self.options.lock_wait_ms))
            .map_err(StoreError::from)?;
        let result = self.write_locked(&mut inner, change);
        self.lock.release();
        result
    }

    fn write_locked<T, E: From<StoreError>>(
        &self,
        inner: &mut Inner,
        change: impl FnOnce(&mut State) -> Result<T, E>,
    ) -> Result<T, E> {
        let exists = self.file.exists();
        if exists {
            self.reload_into(inner)?;
        }
        if exists && inner.file_schema > STATE_SCHEMA {
            return Err(StoreError::from(StoreWriteRefused {
                reason: WriteRefusedReason::NewerSchema,
            })
            .into());
        }
        if exists && inner.file_schema < STATE_SCHEMA && !self.options.adopt_unversioned {
            return Err(StoreError::from(StoreWriteRefused {
                reason: WriteRefusedReason::Unversioned,
            })
            .into());
        }
        let mut next = inner.state.clone();
        let out = change(&mut next)?;
        next.schema = Some(STATE_SCHEMA);
        let value = serde_json::to_value(&next).map_err(StoreError::from)?;
        state_schema().parse(&value).map_err(StoreError::from)?;
        let text = serde_json::to_string_pretty(&value).map_err(StoreError::from)?;
        self.write_file(&text, exists)?;
        inner.state = next;
        inner.file_schema = STATE_SCHEMA;
        inner.seen = Some(seen(&self.file).map_err(StoreError::from)?);
        Ok(out)
    }

    /// `state.json.<uuid>.tmp` (new, 0600) → fsync → copy the old file to `.bak` → rename.
    fn write_file(&self, text: &str, exists: bool) -> Result<(), StoreError> {
        let mut name = self.file.clone().into_os_string();
        name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let tmp = PathBuf::from(name);
        let result = (|| -> Result<(), StoreError> {
            {
                let mut fd = create_new_private(&tmp)?;
                fd.write_all(text.as_bytes())?;
                fd.sync_all()?;
            }
            if exists {
                let mut bak = self.file.clone().into_os_string();
                bak.push(".bak");
                fs::copy(&self.file, PathBuf::from(bak))?;
            }
            fs::rename(&tmp, &self.file)?;
            Ok(())
        })();
        if tmp.exists() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    /// A copy of the account `id`.
    pub fn account(&self, id: &str) -> Result<Account, StoreError> {
        self.with_state(|s| s.accounts.iter().find(|a| a.id == id).cloned())
            .ok_or(StoreError::AccountNotFound)
    }

    /// The account's Claude Code profile folder.
    pub fn profile(&self, id: &str) -> Result<PathBuf, StoreError> {
        self.account(id)?;
        Ok(self.root.join("profiles").join(id))
    }

    /// Adds an account, checked by `createAccountSchema`.
    pub fn create(&self, input: &CreateAccount) -> Result<Account, StoreError> {
        let data = checked_input(input)?;
        let count = self.with_state(|s| s.accounts.len());
        if count >= MAX_ACCOUNTS {
            return Err(StoreError::TooManyAccounts);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let account = Account {
            group: group_of(&data, &id),
            id: id.clone(),
            name: data.name.clone(),
            kind: data.kind,
            color: ["terra", "olive", "blue", "plum"][count % 4].to_string(),
            created_at: iso_timestamp(now_ms()),
            provider: Some(data.provider.unwrap_or(AccountProvider::Claude)),
            cooldown_until: None,
            planning: None,
            switch_at_percent: None,
            desktop: None,
            auth: None,
        };
        private_dir(&self.root.join("profiles").join(&id))?;
        let pushed = account.clone();
        self.update(|state| state.accounts.push(pushed))?;
        Ok(account)
    }

    /// Renames an account and sets its type and sharing group, checked as `create` checks them.
    /// The provider is fixed when the account is added.
    pub fn edit(&self, id: &str, input: &CreateAccount) -> Result<Account, StoreError> {
        let data = checked_input(input)?;
        self.account(id)?;
        self.update(|state| {
            if let Some(account) = state.accounts.iter_mut().find(|a| a.id == id) {
                account.name = data.name.clone();
                account.kind = data.kind;
                account.group = group_of(&data, id);
            }
        })?;
        self.account(id)
    }
}

fn checked_input(input: &CreateAccount) -> Result<CreateAccount, StoreError> {
    let value = serde_json::to_value(input)?;
    Ok(parse_as(&CREATE_ACCOUNT_SCHEMA, &value)?)
}

fn group_of(data: &CreateAccount, id: &str) -> String {
    match data.kind {
        AccountKind::Personal => "personal".into(),
        AccountKind::Work => format!(
            "work:{}",
            data.group
                .as_deref()
                .filter(|g| !g.is_empty())
                .unwrap_or(id)
        ),
    }
}

/// `/^state-[0-9TZ-]+\.json$/`.
fn backup_name(name: &str) -> bool {
    name.strip_prefix("state-")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|stamp| {
            !stamp.is_empty()
                && stamp
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b == b'T' || b == b'Z' || b == b'-')
        })
}
