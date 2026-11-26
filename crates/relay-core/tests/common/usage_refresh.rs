//! The fixture of `tests/usage-refresh.test.ts`: a refresher over an isolated profile whose
//! saved credential, exchange command, server profile and profile guard the test controls.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use relay_core::environment::Env;
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountAuth, AccountKind};
use relay_core::usage_credentials::{UsageCredential, UsageError};
use relay_core::usage_refresh::{UsageCredentialRefresher, UsageRefreshCommand, UsageRefreshDeps};
use serde_json::{Value, json};

/// 2026-10-13T18:00:00Z.
pub const NOW: i64 = 1_791_914_400_000;

/// The refresh in progress map is process-wide, as the TS module map: the cases of one file run
/// one at a time, as node:test runs them.
pub fn serial() -> MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the exchange command does: it may save a new credential and may fail.
pub type Run = Arc<dyn Fn(&Shared) -> Result<(), UsageError> + Send + Sync>;

/// The state the fixture's dependencies share with the test.
pub struct Shared {
    saved: Mutex<UsageCredential>,
    calls: Mutex<Vec<UsageRefreshCommand>>,
    run: Mutex<Run>,
    server: Mutex<Value>,
    allowed: AtomicBool,
    requests: Mutex<Vec<String>>,
}

impl Shared {
    pub fn save(&self, credential: &UsageCredential) {
        *lock(&self.saved) = credential.clone();
    }

    pub fn saved(&self) -> UsageCredential {
        lock(&self.saved).clone()
    }
}

pub struct Fixture {
    _dir: tempfile::TempDir,
    pub profile: PathBuf,
    pub account: Account,
    pub old: UsageCredential,
    pub replacement: UsageCredential,
    pub shared: Arc<Shared>,
    pub deps: UsageRefreshDeps,
    pub refresher: UsageCredentialRefresher,
}

impl Fixture {
    pub fn new() -> Fixture {
        let dir = tempfile::Builder::new()
            .prefix("relay-refresh-")
            .tempdir()
            .unwrap();
        // A folder inside the temporary one, so the CLI's legacy `<profile>.lock` stays in it.
        let profile = relay_core::fs_util::real_path(dir.path())
            .unwrap()
            .join("profile");
        fs::create_dir(&profile).unwrap();
        let mut account = Account::new(uuid::Uuid::new_v4().to_string(), "Fixture");
        account.kind = AccountKind::Personal;
        account.group = "personal".into();
        account.color = "blue".into();
        account.created_at = "2026-10-13T18:00:00.000Z".into();
        account.auth = Some(AccountAuth {
            logged_in: true,
            checked_at: "2026-10-13T18:00:00.000Z".into(),
            account_uuid: Some(uuid::Uuid::new_v4().to_string()),
            org_id: Some(uuid::Uuid::new_v4().to_string()),
            email: Some("a@example.test".into()),
            org_name: None,
            subscription: None,
            plan: None,
            error: None,
        });
        let old = UsageCredential {
            access_token: "fixture-old-access".into(),
            refresh_token: Some("fixture-old-refresh".into()),
            expires_at: Some(NOW as f64 - 1.0),
            scopes: [
                "user:profile",
                "user:inference",
                "user:sessions:claude_code",
            ]
            .map(String::from)
            .to_vec(),
            client_id: Some("fixture-client".into()),
            refresh_token_expires_at: None,
        };
        let replacement = UsageCredential {
            access_token: "fixture-new-access".into(),
            refresh_token: Some("fixture-new-refresh".into()),
            expires_at: Some(NOW as f64 + 3_600_000.0),
            ..old.clone()
        };
        let auth = account.auth.clone().unwrap();
        let saved_replacement = replacement.clone();
        let shared = Arc::new(Shared {
            saved: Mutex::new(old.clone()),
            calls: Mutex::new(Vec::new()),
            run: Mutex::new(Arc::new(move |s: &Shared| {
                s.save(&saved_replacement);
                Ok(())
            })),
            server: Mutex::new(json!({
                "account": { "uuid": auth.account_uuid, "email_address": auth.email },
                "organization": { "uuid": auth.org_id },
            })),
            allowed: AtomicBool::new(true),
            requests: Mutex::new(Vec::new()),
        });
        let executable = profile.join("fake-claude").to_string_lossy().into_owned();
        let read_shared = shared.clone();
        let read_profile = profile.clone();
        let mut deps = UsageRefreshDeps::new(
            Arc::new(move || Ok(executable.clone())),
            Arc::new(move |directory: &Path, prompt| {
                assert_eq!(directory, read_profile);
                assert!(!prompt);
                Ok(read_shared.saved())
            }),
        );
        let run_shared = shared.clone();
        deps.run = Some(Arc::new(move |command: &UsageRefreshCommand| {
            lock(&run_shared.calls).push(command.clone());
            // Taken out first: a run may block, and the test sets the next one meanwhile.
            let run = lock(&run_shared.run).clone();
            run(&run_shared)
        }));
        let request_shared = shared.clone();
        deps.request = Some(Arc::new(move |endpoint, token: &str| {
            lock(&request_shared.requests).push(endpoint.as_str().to_owned());
            assert_eq!(token, request_shared.saved().access_token);
            Ok(lock(&request_shared.server).clone())
        }));
        let allowed_shared = shared.clone();
        deps.can_proceed = Some(Arc::new(move |_, _| {
            allowed_shared.allowed.load(Ordering::SeqCst)
        }));
        deps.now = Some(Arc::new(|| NOW));
        deps.platform = Some(Platform::Linux);
        deps.environment = Some(Env::from_iter(
            [
                ("ANTHROPIC_API_KEY", "foreign-secret"),
                ("CLAUDE_CONFIG_DIR", "/foreign"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "foreign-access"),
                ("CLAUDECODE", "nested"),
                ("ELECTRON_RUN_AS_NODE", "1"),
                ("NODE_OPTIONS", "--require foreign"),
                ("PATH", "/fixture/bin"),
            ]
            .map(|(k, v)| (k.to_owned(), v.to_owned())),
        ));
        let refresher = UsageCredentialRefresher::new(deps.clone());
        Fixture {
            _dir: dir,
            profile,
            account,
            old,
            replacement,
            shared,
            deps,
            refresher,
        }
    }

    pub fn save(&self, credential: &UsageCredential) {
        self.shared.save(credential);
    }

    pub fn run(&self, run: impl Fn(&Shared) -> Result<(), UsageError> + Send + Sync + 'static) {
        *lock(&self.shared.run) = Arc::new(run);
    }

    pub fn server(&self, value: Value) {
        *lock(&self.shared.server) = value;
    }

    pub fn allow(&self, value: bool) {
        self.shared.allowed.store(value, Ordering::SeqCst);
    }

    pub fn calls(&self) -> Vec<UsageRefreshCommand> {
        lock(&self.shared.calls).clone()
    }

    pub fn requests(&self) -> Vec<String> {
        lock(&self.shared.requests).clone()
    }

    pub fn journal(&self) -> PathBuf {
        self.profile.join(".relay-usage-refresh.json")
    }

    /// The profile folder's entries.
    pub fn entries(&self) -> Vec<String> {
        fs::read_dir(&self.profile)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    /// `refresher.refresh(account, profile, credential)` with the TS defaults.
    pub fn refresh(&self, credential: &UsageCredential) -> Result<UsageCredential, UsageError> {
        self.refresher
            .refresh(&self.account, &self.profile, credential, false, false)
    }

    /// The fixture account with other auth fields.
    pub fn account_with(&self, change: impl FnOnce(&mut AccountAuth)) -> Account {
        let mut account = self.account.clone();
        change(account.auth.as_mut().unwrap());
        account
    }
}

/// A failed exchange command, as the TS fixtures' thrown `Error`.
pub fn failed() -> UsageError {
    UsageError::new(relay_core::shared::types::UsageIssue::Expired)
}
