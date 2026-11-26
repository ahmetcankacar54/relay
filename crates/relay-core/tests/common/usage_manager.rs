//! Helpers for the ported `UsageManager` tests: a temporary registry, a settable clock, a
//! one-shot value (the TS tests' deferred promises) and the deps the manager is built from.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{
    Account, AccountAuth, AccountDesktop, AccountKind, AccountProvider, AccountUsage,
    CreateAccount, UsageIssue,
};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage::{UsageEndpoint, UsageManager, UsageManagerDeps};
use relay_core::usage_credentials::{UsageCredential, UsageError};
use serde_json::Value;

/// A registry in a temporary folder, removed when dropped.
pub struct Temp {
    pub dir: tempfile::TempDir,
    pub root: PathBuf,
    pub store: Arc<Store>,
}

/// `new Store(fs.realpathSync(fs.mkdtempSync(prefix)))`.
pub fn temp_store(prefix: &str) -> Temp {
    let dir = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let store = Arc::new(Store::open(&root, StoreOptions::default()).unwrap());
    Temp { dir, root, store }
}

pub fn create(
    store: &Store,
    name: &str,
    kind: AccountKind,
    provider: Option<AccountProvider>,
) -> Account {
    store
        .create(&CreateAccount {
            name: name.into(),
            kind,
            group: None,
            provider,
        })
        .unwrap()
}

/// `Date.parse(text)`.
pub fn ms(text: &str) -> i64 {
    date_parse(text) as i64
}

/// `new Date(ms).toISOString()`.
pub fn iso_at(ms: i64) -> String {
    iso(ms as f64)
}

/// A signed-in Claude Code sign-in.
pub fn auth(email: Option<&str>, checked_at: &str) -> AccountAuth {
    AccountAuth {
        logged_in: true,
        email: email.map(str::to_owned),
        checked_at: checked_at.into(),
        ..AccountAuth::default()
    }
}

pub fn desktop(account_uuid: &str, org_id: &str, saved_at: &str) -> AccountDesktop {
    AccountDesktop {
        account_uuid: account_uuid.into(),
        org_id: org_id.into(),
        saved_at: saved_at.into(),
        ..AccountDesktop::default()
    }
}

pub fn credential(token: &str, expires_at: Option<f64>, scopes: &[&str]) -> UsageCredential {
    UsageCredential {
        access_token: token.into(),
        expires_at,
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
        ..UsageCredential::default()
    }
}

/// What a TS callback throwing a plain `Error` becomes once the manager catches it.
pub fn thrown() -> UsageError {
    UsageError::with_detail(UsageIssue::Unavailable, "no answer: Error")
}

/// A clock the test moves.
#[derive(Clone)]
pub struct Clock(pub Arc<AtomicI64>);

impl Clock {
    pub fn new(at: i64) -> Clock {
        Clock(Arc::new(AtomicI64::new(at)))
    }
    pub fn get(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn set(&self, at: i64) {
        self.0.store(at, Ordering::SeqCst);
    }
    pub fn add(&self, by: i64) {
        self.0.fetch_add(by, Ordering::SeqCst);
    }
    pub fn now_fn(&self) -> Arc<dyn Fn() -> i64 + Send + Sync> {
        let clock = self.clone();
        Arc::new(move || clock.get())
    }
}

/// A counter shared with the callbacks.
#[derive(Clone, Default)]
pub struct Count(pub Arc<AtomicUsize>);

impl Count {
    pub fn bump(&self) -> usize {
        self.0.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub fn get(&self) -> usize {
        self.0.load(Ordering::SeqCst)
    }
}

/// A list shared with the callbacks.
#[derive(Clone)]
pub struct Log<T>(pub Arc<Mutex<Vec<T>>>);

impl<T: Clone> Log<T> {
    pub fn new() -> Self {
        Log(Arc::new(Mutex::new(Vec::new())))
    }
    pub fn push(&self, value: T) {
        self.0.lock().unwrap().push(value);
    }
    pub fn all(&self) -> Vec<T> {
        self.0.lock().unwrap().clone()
    }
    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

/// A deferred promise: `wait` blocks until `resolve` gives the value.
pub struct Deferred<T>(Arc<(Mutex<Option<T>>, Condvar)>);

impl<T> Clone for Deferred<T> {
    fn clone(&self) -> Self {
        Deferred(self.0.clone())
    }
}

impl<T: Clone> Deferred<T> {
    pub fn new() -> Self {
        Deferred(Arc::new((Mutex::new(None), Condvar::new())))
    }
    pub fn resolve(&self, value: T) {
        let (slot, ready) = &*self.0;
        slot.lock().unwrap().get_or_insert(value);
        ready.notify_all();
    }
    pub fn wait(&self) -> T {
        let (slot, ready) = &*self.0;
        let mut value = slot.lock().unwrap();
        loop {
            if let Some(v) = value.as_ref() {
                return v.clone();
            }
            let (next, timeout) = ready.wait_timeout(value, Duration::from_secs(10)).unwrap();
            assert!(!timeout.timed_out(), "a deferred value never came");
            value = next;
        }
    }
}

/// Waits (at most 10 s) until `done` holds.
pub fn until(done: impl Fn() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out waiting"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// The manager's deps from its credential read, its OAuth request and its clock.
pub fn deps(
    credentials: impl Fn(&Path, bool) -> Result<UsageCredential, UsageError> + Send + Sync + 'static,
    request: impl Fn(UsageEndpoint, &str) -> Result<Value, UsageError> + Send + Sync + 'static,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
) -> UsageManagerDeps {
    let mut deps = UsageManagerDeps::new(Arc::new(credentials));
    deps.request = Arc::new(request);
    deps.now = now;
    deps
}

/// `manager.snapshot()[id]`.
pub fn snap(manager: &UsageManager, id: &str) -> AccountUsage {
    manager
        .snapshot()
        .get(id)
        .cloned()
        .expect("the account is in the snapshot")
}

/// `manager.refresh(id, prompt)` on its own thread: the TS's unawaited promise.
pub fn spawn_refresh(
    manager: &Arc<UsageManager>,
    id: &str,
    allow_prompt: bool,
) -> std::thread::JoinHandle<AccountUsage> {
    let manager = manager.clone();
    let id = id.to_owned();
    std::thread::spawn(move || manager.refresh(&id, allow_prompt).unwrap())
}

/// None of `secrets` appears in the JSON of `value`.
pub fn assert_no_secrets(value: &impl serde::Serialize, secrets: &[&str]) {
    let serialized = serde_json::to_string(value).unwrap();
    for secret in secrets {
        assert!(
            !serialized.contains(secret),
            "a secret leaked: {serialized}"
        );
    }
}
