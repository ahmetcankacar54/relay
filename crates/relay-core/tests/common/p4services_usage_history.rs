//! Helpers for the ported `UsageHistory` tests: a temporary folder, a settable clock, the
//! fixture account and usage, and a write failure as on a full disk.
#![allow(dead_code)]

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{Account, AccountUsage};
use relay_core::usage_history::UsageHistory;
use serde_json::{Value, json};

pub const MINUTE: f64 = 60_000.0;
pub const DAY: f64 = 86_400_000.0;

/// `Date.parse(text)`.
pub fn ms(text: &str) -> f64 {
    date_parse(text)
}

/// `new Date(ms).toISOString()`.
pub fn at(ms: f64) -> String {
    iso(ms)
}

/// A temporary folder removed when dropped (`fs.mkdtempSync` + `t.after(rmSync)`).
pub struct Dir {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
}

pub fn directory(prefix: &str) -> Dir {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = dir.path().to_path_buf();
    Dir { _dir: dir, root }
}

/// A clock the test moves (`let now = …; () => now`).
#[derive(Clone)]
pub struct Clock(Arc<AtomicU64>);

impl Clock {
    pub fn new(now: f64) -> Self {
        Clock(Arc::new(AtomicU64::new(now.to_bits())))
    }
    pub fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::SeqCst))
    }
    pub fn set(&self, now: f64) {
        self.0.store(now.to_bits(), Ordering::SeqCst);
    }
    pub fn add(&self, ms: f64) {
        self.set(self.get() + ms);
    }
    pub fn open(&self, root: &Path) -> UsageHistory {
        let clock = self.clone();
        UsageHistory::with_clock(root, move || clock.get())
    }
}

/// `new UsageHistory(root, () => now)` with a fixed `now`.
pub fn open_at(root: &Path, now: f64) -> UsageHistory {
    UsageHistory::with_clock(root, move || now)
}

/// The fixture account: personal, signed in with a verified UUID and organization.
pub fn account(id: &str, color: &str, created: f64) -> Account {
    serde_json::from_value(json!({
        "id": id,
        "name": "A",
        "kind": "personal",
        "group": "personal",
        "color": color,
        "createdAt": at(created),
        "auth": {
            "loggedIn": true,
            "accountUuid": "verified-account-a",
            "orgId": "verified-org-a",
            "email": "a@example.test",
            "checkedAt": at(created),
        },
    }))
    .unwrap()
}

/// `{ ...account, auth: { ...account.auth, ...patch } }`.
pub fn with_auth(account: &Account, patch: Value) -> Account {
    let mut value = serde_json::to_value(account).unwrap();
    let auth = value["auth"].as_object_mut().unwrap();
    for (key, item) in patch.as_object().unwrap() {
        if item.is_null() {
            auth.remove(key);
        } else {
            auth.insert(key.clone(), item.clone());
        }
    }
    serde_json::from_value(value).unwrap()
}

/// A ready, fresh usage of `account_id` from JSON windows.
pub fn usage_of(
    account_id: &str,
    checked: f64,
    five_hour: Value,
    seven_day: Value,
) -> AccountUsage {
    let mut value = json!({
        "accountId": account_id,
        "status": "ready",
        "stale": false,
        "checkedAt": at(checked),
    });
    if !five_hour.is_null() {
        value["fiveHour"] = five_hour;
    }
    if !seven_day.is_null() {
        value["sevenDay"] = seven_day;
    }
    serde_json::from_value(value).unwrap()
}

/// `{ ...usage, ...patch }` on the JSON form.
pub fn patched(usage: &AccountUsage, patch: Value) -> AccountUsage {
    let mut value = serde_json::to_value(usage).unwrap();
    for (key, item) in patch.as_object().unwrap() {
        value[key] = item.clone();
    }
    serde_json::from_value(value).unwrap()
}

/// The non-empty lines of a file.
pub fn lines(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .unwrap()
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// The lines of a JSONL file, parsed.
pub fn json_lines(file: &Path) -> Vec<Value> {
    lines(file)
        .iter()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

pub fn read_json(file: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// Opening or replacing `file` fails as on a full disk.
pub fn fail_writes(history: &mut UsageHistory, file: &Path) {
    let file = file.to_path_buf();
    history.set_file_fault(Box::new(move |_, path| {
        if path == file {
            Err(io::Error::other("disk full"))
        } else {
            Ok(())
        }
    }));
}

#[cfg(unix)]
pub fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
pub fn symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}
