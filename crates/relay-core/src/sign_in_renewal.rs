//! Renews Claude Code sign-ins before they end.
//!
//! Anthropic gives each browser sign-in about 30 days (18 to 29 measured by others); renewing the
//! access token keeps that end date, so past it every account needs a new browser sign-in. Claude
//! Code itself only warns 3 days ahead ("run /login"). Relay starts that sign-in by itself when an
//! account's end is that close: the CLI's own `auth login`, its page approved in a hidden window
//! that holds the account's claude.ai session from the Claude app. When that cannot run or does
//! not finish, the user hears it once per end date, with a click to sign in.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fs_util::{iso_timestamp, parse_iso_ms};
use crate::shared::account_state::desktop_cli_mismatch;
use crate::shared::types::{Account, AccountProvider, AccountUsage};

/// How long before a sign-in's end Relay renews it (Claude Code warns this far ahead).
pub const RENEW_BEFORE_MS: i64 = 3 * 86_400_000;
/// How long after a failed or impossible attempt the next one may run.
pub const RENEW_RETRY_MS: i64 = 6 * 3_600_000;
/// How recent a claude.ai sign-in must be for claude.ai to grant a new Claude Code sign-in: older
/// sessions get `403 session_stale_relogin` ("Session is not fresh enough…"). Reports put the
/// limit at 18 to 36 hours; the shortest is used.
pub const FRESH_SIGN_IN_MS: i64 = 18 * 3_600_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum RenewalResult {
    Connected,
    /// Not tried for a passing reason (the Claude app busy, another sign-in running): no notice, no wait.
    Busy {
        detail: String,
    },
    /// Not tried: the account's claude.ai sign-in is too old for claude.ai to approve a new one.
    /// Tried again on every pass, so a fresh sign-in in the Claude app is used within minutes.
    Waiting {
        detail: String,
    },
    /// Nothing to renew with: no claude.ai session Relay may read, or the account is busy.
    Unavailable {
        detail: String,
    },
    Failed {
        detail: String,
    },
}

impl RenewalResult {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Busy { .. } => "busy",
            Self::Waiting { .. } => "waiting",
            Self::Unavailable { .. } => "unavailable",
            Self::Failed { .. } => "failed",
        }
    }

    pub fn detail(&self) -> Option<&str> {
        match self {
            Self::Connected => None,
            Self::Busy { detail }
            | Self::Waiting { detail }
            | Self::Unavailable { detail }
            | Self::Failed { detail } => Some(detail),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// The end date the user was told about, so each end is said once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notified_for: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Saved {
    version: u32,
    accounts: IndexMap<String, Entry>,
}

/// When a renewal is due, with the sign-in's end when the read said it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RenewalDue {
    pub ends_at: Option<String>,
}

/// When the account's Claude Code sign-in has to be renewed; `None` when not yet.
pub fn renewal_due(
    account: &Account,
    usage: Option<&AccountUsage>,
    now: i64,
) -> Option<RenewalDue> {
    if account.provider.unwrap_or(AccountProvider::Claude) != AccountProvider::Claude
        || !account.auth.as_ref().is_some_and(|a| a.logged_in)
        || account.desktop.is_none()
    {
        return None;
    }
    // A Claude Code sign-in of another account or workspace than the Claude app's: renewing it
    // from the app's session would replace it with the app's identity.
    if desktop_cli_mismatch(account) {
        return None;
    }
    let usage = usage?;
    if usage.cli_sign_in_ended == Some(true) {
        return Some(RenewalDue {
            ends_at: usage.cli_sign_in_ends_at.clone(),
        });
    }
    let ends_at = parse_iso_ms(usage.cli_sign_in_ends_at.as_deref()?)?;
    (ends_at - now <= RENEW_BEFORE_MS).then(|| RenewalDue {
        ends_at: usage.cli_sign_in_ends_at.clone(),
    })
}

type Renew = dyn Fn(&Account) -> Result<RenewalResult, String> + Send + Sync;
type ReadUsage = dyn Fn(&str) -> Option<AccountUsage> + Send + Sync;
type Notify = dyn Fn(&Account, Option<&str>) + Send + Sync;

pub struct SignInRenewalDeps {
    pub file: PathBuf,
    pub accounts: Box<dyn Fn() -> Vec<Account> + Send + Sync>,
    pub usage: Box<ReadUsage>,
    /// Runs one renewal to its end; an error counts as `failed` with its message.
    pub renew: Box<Renew>,
    /// Told once per end date when Relay could not renew it.
    pub notify: Box<Notify>,
    pub now: Option<Box<dyn Fn() -> i64 + Send + Sync>>,
}

pub struct SignInRenewal {
    deps: SignInRenewalDeps,
    running: AtomicBool,
    saved: Mutex<Option<Saved>>,
}

/// Clears `running` when a pass ends, however it ends.
struct Running<'a>(&'a AtomicBool);
impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl SignInRenewal {
    pub fn new(deps: SignInRenewalDeps) -> Self {
        Self {
            deps,
            running: AtomicBool::new(false),
            saved: Mutex::new(None),
        }
    }

    fn now(&self) -> i64 {
        self.deps
            .now
            .as_ref()
            .map_or_else(crate::clock::now_ms, |now| now())
    }

    fn start(&self) -> Option<Running<'_>> {
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| Running(&self.running))
    }

    fn read(&self) -> Saved {
        let empty = || Saved {
            version: 1,
            accounts: IndexMap::new(),
        };
        let Ok(text) = fs::read_to_string(&self.deps.file) else {
            return empty();
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            return empty();
        };
        if value.get("version").and_then(Value::as_f64) != Some(1.0) {
            return empty();
        }
        let Some(accounts) = value.get("accounts").and_then(Value::as_object) else {
            return empty();
        };
        let text =
            |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
        Saved {
            version: 1,
            accounts: accounts
                .iter()
                .map(|(id, entry)| {
                    let entry = Entry {
                        attempt_at: text(entry, "attemptAt"),
                        result: text(entry, "result"),
                        detail: text(entry, "detail"),
                        notified_for: text(entry, "notifiedFor"),
                    };
                    (id.clone(), entry)
                })
                .collect(),
        }
    }

    /// Runs `change` on the saved state (read once), then writes it; write errors are ignored.
    fn with_saved<T>(&self, change: impl FnOnce(&mut Saved) -> T) -> T {
        let mut guard = self.saved.lock().unwrap_or_else(|e| e.into_inner());
        let saved = guard.get_or_insert_with(|| self.read());
        let out = change(saved);
        let _ = self.save(saved);
        out
    }

    fn save(&self, saved: &Saved) -> std::io::Result<()> {
        let file = &self.deps.file;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent)?;
        }
        let temp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut out = options.open(&temp)?;
        out.write_all(serde_json::to_string_pretty(saved)?.as_bytes())?;
        drop(out);
        fs::rename(&temp, file)
    }

    /// After the user allowed what an attempt lacked (the Keychain read of the Claude app's
    /// sign-in): attempts that could not run may run again at once.
    pub fn retry_unavailable(&self) {
        self.with_saved(|saved| {
            for entry in saved.accounts.values_mut() {
                if entry.result.as_deref() == Some("unavailable") {
                    entry.attempt_at = None;
                }
            }
        });
        self.tick();
    }

    /// Renews one account now, asked by the user: due or not, and told nobody but the caller.
    pub fn renew_now(&self, account: &Account) -> RenewalResult {
        let Some(_running) = self.start() else {
            return RenewalResult::Busy {
                detail: "another renewal is running".into(),
            };
        };
        self.with_saved(|_| ());
        let outcome = self.attempt(account);
        // Nothing was tried: the automatic passes keep their own schedule.
        if matches!(
            outcome,
            RenewalResult::Busy { .. } | RenewalResult::Waiting { .. }
        ) {
            return outcome;
        }
        let at = iso_timestamp(self.now());
        self.with_saved(|saved| {
            let entry = saved.accounts.entry(account.id.clone()).or_default();
            entry.attempt_at = Some(at);
            entry.result = Some(outcome.name().into());
            match outcome.detail() {
                None => {
                    entry.detail = None;
                    entry.notified_for = None;
                }
                Some(detail) => entry.detail = Some(detail.into()),
            }
        });
        outcome
    }

    fn attempt(&self, account: &Account) -> RenewalResult {
        (self.deps.renew)(account).unwrap_or_else(|error| RenewalResult::Failed {
            detail: error.chars().take(200).collect(),
        })
    }

    /// One pass: renews at most one account, the one whose sign-in ends first.
    pub fn tick(&self) {
        let Some(_running) = self.start() else {
            return;
        };
        let now = self.now();
        let accounts = (self.deps.accounts)();
        let attempts = self.with_saved(|saved| {
            saved
                .accounts
                .retain(|id, _| accounts.iter().any(|a| &a.id == id));
            saved
                .accounts
                .iter()
                .map(|(id, entry)| (id.clone(), entry.attempt_at.clone()))
                .collect::<Vec<_>>()
        });
        let attempt_at = |id: &str| {
            attempts
                .iter()
                .find(|(key, _)| key == id)
                .and_then(|(_, at)| at.as_deref().and_then(parse_iso_ms))
        };
        let mut due: Vec<(&Account, RenewalDue)> = accounts
            .iter()
            .filter_map(|account| {
                renewal_due(account, (self.deps.usage)(&account.id).as_ref(), now)
                    .map(|due| (account, due))
            })
            .filter(|(account, _)| match attempt_at(&account.id) {
                None => true,
                Some(at) => now - at >= RENEW_RETRY_MS || at > now,
            })
            .collect();
        let end = |due: &RenewalDue| due.ends_at.as_deref().and_then(parse_iso_ms).unwrap_or(0);
        due.sort_by_key(|(_, due)| end(due));
        // One real attempt per pass; accounts only waiting for a fresh sign-in cost a cookie read.
        for (account, due) in due {
            let before = self.with_saved(|saved| {
                let entry = saved.accounts.entry(account.id.clone()).or_default();
                entry.attempt_at.replace(iso_timestamp(now))
            });
            let outcome = self.attempt(account);
            let mut notify = false;
            self.with_saved(|saved| {
                let entry = saved.accounts.entry(account.id.clone()).or_default();
                // Nothing was tried: the next pass looks again.
                if matches!(
                    outcome,
                    RenewalResult::Waiting { .. } | RenewalResult::Busy { .. }
                ) {
                    entry.attempt_at = before;
                }
                if matches!(outcome, RenewalResult::Busy { .. }) {
                    return;
                }
                entry.result = Some(outcome.name().into());
                match outcome.detail() {
                    None => {
                        entry.detail = None;
                        entry.notified_for = None;
                    }
                    Some(detail) => {
                        entry.detail = Some(detail.into());
                        let key = due.ends_at.clone().unwrap_or_else(|| "ended".into());
                        if entry.notified_for.as_ref() != Some(&key) {
                            entry.notified_for = Some(key);
                            notify = true;
                        }
                    }
                }
            });
            if notify {
                let deps = &self.deps;
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    (deps.notify)(account, due.ends_at.as_deref())
                }));
            }
            if matches!(
                outcome,
                RenewalResult::Busy { .. } | RenewalResult::Waiting { .. }
            ) {
                continue;
            }
            break;
        }
    }
}
