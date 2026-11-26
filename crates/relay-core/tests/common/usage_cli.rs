//! The Usage side of `tests/cli-limits.test.ts` and `tests/cli-secrets.test.ts`: a registry with
//! one connected account whose CLI credential sits in a fake Keychain under its
//! `credential_service`, read and renewed the way `relay usage` wires the readers. The test file
//! declares `mod vault` (`common/vault.rs`) for the `security` stand-in.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountAuth, AccountKind, CreateAccount, UsageIssue};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage::{UsageManager, UsageManagerDeps, UsageRequest};
use relay_core::usage_credentials::{MISSING_RETRY_MS, credential_service, read_credential};
use relay_core::usage_refresh::{ProfileRelease, UsageCredentialRefresher, UsageRefreshDeps};
use serde_json::{Value, json};

use crate::vault::{FakeSecurity, Options};

pub const TOKEN: &str = "sk-ant-oat01-FAKEACCESSTOKENFORTESTS0000000000000000";
pub const REFRESH: &str = "sk-ant-ort01-FAKEREFRESHTOKENFORTESTS000000000000000";

pub fn now_ms() -> f64 {
    relay_core::clock::now_ms() as f64
}

/// A connected account "A" of a temporary registry.
pub struct Connected {
    _temp: tempfile::TempDir,
    pub home: PathBuf,
    pub store: Arc<Store>,
    pub account: Account,
    pub profile: PathBuf,
    pub locks: PathBuf,
    pub security: FakeSecurity,
    /// A fake `claude` that logs every call.
    pub claude: PathBuf,
    claude_log: PathBuf,
    /// What `on_issue` was told: never a credential.
    pub issues: Arc<Mutex<Vec<String>>>,
}

impl Connected {
    pub fn new() -> Connected {
        let temp = tempfile::Builder::new()
            .prefix("relay-cli-usage-")
            .tempdir()
            .unwrap();
        let home = relay_core::fs_util::real_path(temp.path()).unwrap();
        let store = Arc::new(Store::open(&home, StoreOptions::default()).unwrap());
        let created = store
            .create(&CreateAccount {
                name: "A".into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap();
        store
            .update(|s| {
                s.accounts[0].auth = Some(AccountAuth {
                    logged_in: true,
                    account_uuid: Some(uuid::Uuid::new_v4().to_string()),
                    org_id: Some(uuid::Uuid::new_v4().to_string()),
                    email: Some("a@example.test".into()),
                    checked_at: relay_core::shared::types::js::iso(now_ms()),
                    ..AccountAuth::default()
                });
            })
            .unwrap();
        let account = store.account(&created.id).unwrap();
        let profile = store.profile(&account.id).unwrap();
        let claude = home.join("fake-claude");
        let claude_log = home.join("claude.log");
        fs::write(
            &claude,
            format!(
                "#!/bin/sh\necho \"$*|$CLAUDE_CONFIG_DIR\" >> \"{}\"\ncase \"$1 $2\" in\n  \"auth status\") echo '{{}}';;\n  \"--version \") echo \"2.1.300 (Claude Code)\";;\nesac\nexit 0\n",
                claude_log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&claude, fs::Permissions::from_mode(0o755)).unwrap();
        }
        Connected {
            _temp: temp,
            locks: home.join("profiles").join(".locks"),
            home,
            store,
            account,
            profile,
            security: FakeSecurity::new(Options::default()),
            claude,
            claude_log,
            issues: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Stores a generic password for `service`, as the CLI would have (`setItem`).
    pub fn set_item(&self, service: &str, value: &str) {
        let key: String = service
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        let dir = self.security.tool().parent().unwrap();
        fs::write(dir.join(format!("item-{key}")), value).unwrap();
    }

    /// Saves the account's CLI sign-in in the fake Keychain.
    pub fn save_credential(
        &self,
        access_token: &str,
        expires_at: f64,
        scopes: &[&str],
        refresh: bool,
    ) {
        let mut oauth =
            json!({ "accessToken": access_token, "expiresAt": expires_at, "scopes": scopes });
        if refresh {
            oauth["refreshToken"] = json!(REFRESH);
        }
        self.set_item(
            &credential_service(&self.profile),
            &json!({ "claudeAiOauth": oauth }).to_string(),
        );
    }

    /// The server's profile answer for this account.
    pub fn server_profile(&self) -> Value {
        let auth = self.account.auth.as_ref().unwrap();
        json!({
            "account": { "uuid": auth.account_uuid, "email_address": "a@example.test" },
            "organization": { "uuid": auth.org_id },
        })
    }

    pub fn claude_log(&self) -> String {
        fs::read_to_string(&self.claude_log).unwrap_or_default()
    }

    /// The manager `relay usage` builds: the CLI credential read through `security`, renewed by
    /// the refresher under the account's exclusive profile lock.
    pub fn manager(&self, request: UsageRequest) -> Arc<UsageManager> {
        let tool = self.security.tool().to_path_buf();
        let read: relay_core::usage::CredentialRead = Arc::new(move |profile: &Path, prompt| {
            read_credential(
                profile,
                prompt,
                Some(&tool),
                Platform::MacOs,
                MISSING_RETRY_MS,
            )
        });
        let claude = self.claude.to_string_lossy().into_owned();
        let mut deps = UsageRefreshDeps::new(Arc::new(move || Ok(claude.clone())), read.clone());
        deps.request = Some(request.clone());
        let locks = self.locks.clone();
        deps.profile_lock = Some(Arc::new(move |id| {
            acquire_profile_lock(&locks, id, ProfileLockKind::Exclusive)
                .map(|guard| Box::new(move || drop(guard)) as ProfileRelease)
        }));
        let refresher = UsageCredentialRefresher::new(deps);
        let mut manager = UsageManagerDeps::new(read);
        manager.request = request;
        let (store, pending_store) = (self.store.clone(), self.store.clone());
        let pending = refresher.clone();
        manager.refresh_credential =
            Some(Arc::new(move |account, credential, force, interaction| {
                let profile = store.profile(&account.id).map_err(|_| {
                    relay_core::usage_credentials::UsageError::new(UsageIssue::Unavailable)
                })?;
                refresher.refresh(account, &profile, credential, force, interaction)
            }));
        manager.refresh_credential_pending = Some(Arc::new(move |account| {
            pending_store
                .profile(&account.id)
                .is_ok_and(|profile| pending.has_pending(&profile))
        }));
        let issues = self.issues.clone();
        manager.on_issue = Some(Arc::new(move |_, issue, detail| {
            issues
                .lock()
                .unwrap()
                .push(format!("{} {}", issue.as_str(), detail.unwrap_or("")));
        }));
        Arc::new(UsageManager::new(self.store.clone(), manager))
    }
}
