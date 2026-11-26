//! Port of `tests/desktop-usage.test.ts`.

#[path = "common/usage_desktop.rs"]
mod helpers;

#[cfg(unix)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use helpers::*;
use relay_core::desktop_usage::{
    CookieFiles, CookieKeys, DesktopUsageDeps, DesktopUsageReader, SafeStoragePassword, SameSite,
    WebResponse, cookie_header, cookie_key, decrypt_cookie, read_cookie_rows,
};
#[cfg(unix)]
use relay_core::desktop_usage::{SafeStorageOptions, SavedPassword, safe_storage_password};
use relay_core::relay_paths::Platform;
use relay_core::shared::account_state::{cli_needs_reconnect, reads_through_app};
use relay_core::shared::types::js::date_parse;
use relay_core::shared::types::{
    AccountKind, AccountUsage, CreateAccount, UsageIssue, UsageSource, UsageStatus, UsageWindow,
};
use relay_core::shared::usage_statistics::{history_identity, usage_identity};
use relay_core::store::{Store, StoreOptions};
use relay_core::usage::{
    DesktopUsageSource, UsageLimits, UsageManager, UsageManagerDeps, parse_usage,
};
use relay_core::usage_credentials::UsageError;
use serde_json::json;

fn v10() -> CookieKeys {
    CookieKeys {
        v10: Some(key()),
        v11: None,
    }
}

type Password = Arc<dyn SafeStoragePassword>;

fn fixed_password() -> Password {
    Arc::new(|_: bool| Ok::<_, UsageError>(PASSWORD.to_owned()))
}

fn reader(
    cookie_files: impl Fn(&str) -> Result<CookieFiles, String> + Send + Sync + 'static,
    password: Password,
    request: impl Fn(&str, &str) -> Result<WebResponse, UsageError> + Send + Sync + 'static,
    platform: Option<Platform>,
) -> DesktopUsageReader {
    DesktopUsageReader::new(DesktopUsageDeps {
        cookie_files: Arc::new(cookie_files),
        password,
        request: Arc::new(request),
        read_rows: None,
        now: None,
        platform,
    })
}

#[test]
fn chromiums_macos_cookie_values_decrypt_with_the_safe_storage_key_and_only_with_it() {
    assert_eq!(
        decrypt_cookie(
            &encrypt("sk-ant-sid01-abc", ".claude.ai"),
            &v10(),
            ".claude.ai",
            24.0
        )
        .as_deref(),
        Some("sk-ant-sid01-abc")
    );
    // The host digest guards against a value moved to another host.
    assert_eq!(
        decrypt_cookie(&encrypt("x", "claude.ai"), &v10(), ".claude.ai", 24.0),
        None
    );
    let other = CookieKeys {
        v10: Some(cookie_key("other")),
        v11: None,
    };
    assert_eq!(
        decrypt_cookie(&encrypt("x", ".claude.ai"), &other, ".claude.ai", 24.0),
        None
    );
    assert_eq!(
        decrypt_cookie(b"v11abcdefghijklmnopqrs", &v10(), ".claude.ai", 24.0),
        None
    );
    // Before version 24 there is no digest.
    let old = [b"v10".as_slice(), &cbc_encrypt(&key(), b"plain-old")].concat();
    assert_eq!(
        decrypt_cookie(&old, &v10(), ".claude.ai", 23.0).as_deref(),
        Some("plain-old")
    );
}

#[test]
fn the_cookie_header_carries_the_session_and_its_routing_hints_nothing_else() {
    let files = cookie_database(&[
        (".claude.ai", "sessionKey", "sk-ant-sid01-abc"),
        (".claude.ai", "lastActiveOrg", ORG),
        (".claude.ai", "cf_clearance", "never-sent"),
        ("claude.ai", "anthropic-device-id", "never-sent"),
        (".example.com", "sessionKey", "other-site"),
    ]);
    let read = read_cookie_rows(&files).unwrap();
    assert_eq!(read.version, 24.0);
    let mut names: Vec<&str> = read.rows.iter().map(|r| r.name.as_str()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "anthropic-device-id",
            "cf_clearance",
            "lastActiveOrg",
            "sessionKey"
        ]
    );
    assert_eq!(
        cookie_header(&read.rows, &v10(), read.version),
        Some(format!("sessionKey=sk-ant-sid01-abc; lastActiveOrg={ORG}"))
    );
    // Without a session there is nothing to send.
    let without: Vec<_> = read
        .rows
        .iter()
        .filter(|r| r.name != "sessionKey")
        .cloned()
        .collect();
    assert_eq!(cookie_header(&without, &v10(), read.version), None);
    assert_eq!(
        read_cookie_rows(&CookieFiles::new()).unwrap_err().issue,
        UsageIssue::CredentialsMissing
    );
}

#[test]
fn a_claude_app_sign_in_reads_claude_ais_usage_for_the_accounts_organization() {
    let files = cookie_database(&[(".claude.ai", "sessionKey", "sk-ant-sid01-abc")]);
    let calls: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let answer = Arc::new(Mutex::new(json(
        200,
        r#"{"five_hour":{"utilization":12,"resets_at":"2026-11-07T15:00:00Z"}}"#,
    )));
    let prompts: Arc<Mutex<Vec<bool>>> = Arc::default();
    let reader = DesktopUsageReader::new(DesktopUsageDeps {
        cookie_files: Arc::new(move |uuid: &str| {
            assert_eq!(uuid, ACCOUNT);
            Ok(files.clone())
        }),
        password: Arc::new({
            let prompts = prompts.clone();
            move |allow_prompt: bool| {
                prompts.lock().unwrap().push(allow_prompt);
                Ok::<_, UsageError>(PASSWORD.to_owned())
            }
        }),
        request: Arc::new({
            let calls = calls.clone();
            let answer = answer.clone();
            move |url: &str, cookie: &str| {
                calls
                    .lock()
                    .unwrap()
                    .push((url.to_owned(), cookie.to_owned()));
                Ok(answer.lock().unwrap().clone())
            }
        }),
        read_rows: None,
        now: Some(Arc::new(|| 0)),
        platform: Some(Platform::MacOs),
    });
    assert_eq!(
        reader.read(&account(), false).unwrap(),
        json!({ "five_hour": { "utilization": 12, "resets_at": "2026-11-07T15:00:00Z" } })
    );
    assert_eq!(
        *calls.lock().unwrap(),
        [(
            format!("https://claude.ai/api/organizations/{ORG}/usage"),
            "sessionKey=sk-ant-sid01-abc".to_owned()
        )]
    );
    assert_eq!(*prompts.lock().unwrap(), [false]);
    let issue = |response: WebResponse| {
        *answer.lock().unwrap() = response;
        reader.read(&account(), false).err().map(|e| e.issue)
    };
    assert_eq!(issue(json(401, "{}")), Some(UsageIssue::Expired));
    assert_eq!(
        issue(json(403, r#"{"error":{"type":"permission_error"}}"#)),
        Some(UsageIssue::Expired)
    );
    // Cloudflare's challenge page passes on its own.
    assert_eq!(
        issue(WebResponse {
            status: 403,
            content_type: "text/html".into(),
            retry_after: None,
            body: "<html>".into(),
            cf_mitigated: None,
        }),
        Some(UsageIssue::Unavailable)
    );
    // A bot challenge is named in the issue log, so it never reads as a sign-out.
    *answer.lock().unwrap() = WebResponse {
        status: 403,
        content_type: "text/html".into(),
        retry_after: None,
        body: "<html>".into(),
        cf_mitigated: Some("challenge".into()),
    };
    let challenged = reader.read(&account(), false).unwrap_err();
    assert_eq!(challenged.issue, UsageIssue::Unavailable);
    assert_eq!(
        challenged.detail.as_deref(),
        Some("desktop usage 403 challenge")
    );
    assert_eq!(
        issue(WebResponse {
            retry_after: Some("120".into()),
            ..json(429, "{}")
        }),
        Some(UsageIssue::RateLimited)
    );
    assert_eq!(issue(json(500, "{}")), Some(UsageIssue::Unavailable));
    assert_eq!(issue(json(200, "{")), Some(UsageIssue::Unsupported));
}

#[test]
fn a_signed_out_claude_app_sign_in_a_missing_one_and_a_refused_keychain_each_say_so() {
    let signed_out = cookie_database(&[(".claude.ai", "lastActiveOrg", ORG)]);
    let request = |_: &str, _: &str| Ok(json(200, "{}"));
    let issue = |reader: DesktopUsageReader| reader.read(&account(), false).err().map(|e| e.issue);
    let out = signed_out.clone();
    assert_eq!(
        issue(reader(
            move |_| Ok(out.clone()),
            fixed_password(),
            request,
            Some(Platform::MacOs)
        )),
        Some(UsageIssue::Expired)
    );
    assert_eq!(
        issue(reader(
            |_| Err("missing".into()),
            fixed_password(),
            request,
            Some(Platform::MacOs)
        )),
        Some(UsageIssue::CredentialsMissing)
    );
    let locked = reader(
        move |_| Ok(signed_out.clone()),
        Arc::new(|_: bool| Err::<String, _>(UsageError::new(UsageIssue::KeychainLocked))),
        request,
        Some(Platform::MacOs),
    );
    assert_eq!(issue(locked), Some(UsageIssue::KeychainLocked));
}

#[cfg(unix)]
fn options(
    allowed: impl Fn() -> bool + Send + Sync + 'static,
    remember: impl Fn(bool) + Send + Sync + 'static,
    tool: std::path::PathBuf,
    saved: Option<SavedPassword>,
) -> SafeStorageOptions {
    SafeStorageOptions {
        allowed: Arc::new(allowed),
        remember: Arc::new(remember),
        tool: Some(tool),
        saved,
    }
}

#[cfg(unix)]
/// A vault kept in memory.
fn memory_vault(start: Option<&str>) -> (SavedPassword, Arc<Mutex<Option<String>>>) {
    let vault = Arc::new(Mutex::new(start.map(str::to_owned)));
    let saved = SavedPassword {
        load: Arc::new({
            let vault = vault.clone();
            move || vault.lock().unwrap().clone()
        }),
        store: Arc::new({
            let vault = vault.clone();
            move |p: &str| {
                *vault.lock().unwrap() = Some(p.to_owned());
                Ok(())
            }
        }),
        clear: Arc::new({
            let vault = vault.clone();
            move || *vault.lock().unwrap() = None
        }),
    };
    (saved, vault)
}

// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn the_safe_storage_password_is_read_only_once_allowed_then_kept_for_the_run() {
    let dir = temp("relay-safe-storage-");
    let log = dir.path().join("calls");
    let tool = tool(
        dir.path(),
        &format!(
            "echo \"$@\" >> \"{}\"\necho \"{PASSWORD}\"\n",
            log.display()
        ),
    );
    let allowed = Arc::new(AtomicBool::new(false));
    let remembered: Arc<Mutex<Vec<bool>>> = Arc::default();
    let read = safe_storage_password(options(
        {
            let allowed = allowed.clone();
            move || allowed.load(Ordering::SeqCst)
        },
        {
            let remembered = remembered.clone();
            move |v| remembered.lock().unwrap().push(v)
        },
        tool,
        None,
    ));
    // In the background, before the user allowed it, no Keychain dialog may open.
    assert_eq!(
        read.get(false).unwrap_err().issue,
        UsageIssue::KeychainLocked
    );
    assert!(std::fs::read_to_string(&log).is_err());
    assert_eq!(read.get(true).unwrap(), PASSWORD);
    assert_eq!(*remembered.lock().unwrap(), [true]);
    assert_eq!(
        std::fs::read_to_string(&log).unwrap().trim(),
        "find-generic-password -s Claude Safe Storage -a Claude -w"
    );
    allowed.store(true, Ordering::SeqCst);
    assert_eq!(read.get(false).unwrap(), PASSWORD);
    // Kept in memory: the tool ran once.
    assert_eq!(log_lines(&log).unwrap().len(), 1);
}

fn usage_store(root: &std::path::Path) -> (Arc<Store>, String) {
    let store = Arc::new(Store::open(root, StoreOptions::default()).unwrap());
    let created = store
        .create(&CreateAccount {
            name: "A".into(),
            kind: AccountKind::Personal,
            group: None,
            provider: None,
        })
        .unwrap();
    store
        .update(|s| s.accounts[0].desktop = Some(desktop()))
        .unwrap();
    (store, created.id)
}

#[test]
fn an_account_without_a_claude_code_sign_in_reads_its_limits_through_the_claude_app() {
    let root = temp("relay-usage-app-");
    let (store, id) = usage_store(root.path());
    let credentials: relay_core::usage::CredentialRead =
        Arc::new(|_, _| panic!("the CLI credential must not be read"));
    let reads: Arc<Mutex<Vec<bool>>> = Arc::default();
    let samples: Arc<Mutex<Vec<String>>> = Arc::default();
    let mut deps = UsageManagerDeps::new(credentials.clone());
    deps.now = Arc::new(|| date_parse("2026-11-07T12:00:00Z") as i64);
    deps.on_sample = Arc::new({
        let samples = samples.clone();
        move |_, usage: &AccountUsage| {
            samples
                .lock()
                .unwrap()
                .push(usage.source.map_or("", |s| s.as_str()).to_owned())
        }
    });
    deps.desktop_usage = Some(DesktopUsageSource {
        usable: Arc::new(|a| a.desktop.is_some()),
        read: Arc::new({
            let reads = reads.clone();
            move |_, allow_prompt| {
                reads.lock().unwrap().push(allow_prompt);
                Ok(json!({
                    "five_hour": { "utilization": 40, "resets_at": "2026-11-07T15:00:00Z" },
                    "seven_day": null
                }))
            }
        }),
    });
    let manager = UsageManager::new(store.clone(), deps);
    let usage = manager.refresh(&id, true).unwrap();
    assert_eq!(usage.status, UsageStatus::Ready);
    assert_eq!(usage.source, Some(UsageSource::Desktop));
    assert_eq!(usage.five_hour.as_ref().map(|w| w.used_percent), Some(40.0));
    assert_eq!(usage.issue, None);
    assert_eq!(*reads.lock().unwrap(), [true]);
    assert_eq!(*samples.lock().unwrap(), ["desktop"]);

    // Without the second source (Windows) the account still asks for a usage sign-in.
    let plain = UsageManager::new(store.clone(), UsageManagerDeps::new(credentials));
    assert_eq!(
        plain.snapshot()[id.as_str()].issue,
        Some(UsageIssue::ConnectCli)
    );
    // An account without any Claude app sign-in has no source either.
    store.update(|s| s.accounts[0].desktop = None).unwrap();
    assert_eq!(
        manager.snapshot()[id.as_str()].issue,
        Some(UsageIssue::ConnectCli)
    );
}

#[test]
fn a_failed_read_through_the_claude_app_keeps_its_source_so_the_app_knows_which_sign_in_to_fix() {
    let root = temp("relay-usage-app-");
    let (store, id) = usage_store(root.path());
    let mut deps = UsageManagerDeps::new(Arc::new(|_, _| panic!("unused")));
    deps.desktop_usage = Some(DesktopUsageSource {
        usable: Arc::new(|_| true),
        read: Arc::new(|_, _| Err(UsageError::new(UsageIssue::KeychainLocked))),
    });
    let manager = UsageManager::new(store, deps);
    let usage = manager.refresh(&id, false).unwrap();
    assert_eq!(usage.issue, Some(UsageIssue::KeychainLocked));
    assert_eq!(usage.source, Some(UsageSource::Desktop));
}

/// `usageSignInStatus` (`src/lib/account-health.ts`) is the React UI's and stays TS: its
/// assertion is not ported.
#[test]
fn the_accounts_status_names_the_claude_app_as_its_usage_source() {
    let ready = AccountUsage {
        source: Some(UsageSource::Desktop),
        checked_at: Some("2026-11-07T12:00:00Z".into()),
        ..AccountUsage::new("a", UsageStatus::Ready)
    };
    assert!(reads_through_app(&account(), Some(&ready)));
    assert!(!cli_needs_reconnect(&account(), Some(&ready)));
    let expired = AccountUsage {
        status: UsageStatus::Error,
        issue: Some(UsageIssue::Expired),
        ..ready.clone()
    };
    assert!(cli_needs_reconnect(&account(), Some(&expired)));
    // Without a usage source the CLI sign-in is still asked for.
    let none = AccountUsage {
        issue: Some(UsageIssue::ConnectCli),
        ..AccountUsage::new("a", UsageStatus::Idle)
    };
    assert!(!reads_through_app(&account(), Some(&none)));
    assert!(cli_needs_reconnect(&account(), Some(&none)));
    // Samples read through the app are filed under the app's identity.
    let identity = json!(["uuid", ACCOUNT, ORG]).to_string();
    assert_eq!(usage_identity(&account()), Some(identity.clone()));
    assert_eq!(history_identity(&account()), Some(identity));
}

#[test]
fn claude_ais_usage_answer_as_seen_live_on_2026_11_07_parses_like_the_cli_endpoints() {
    let window = |utilization: f64, resets_at: &str| {
        json!({
            "utilization": utilization,
            "resets_at": resets_at,
            "limit_dollars": null,
            "used_dollars": null,
            "remaining_dollars": null,
            "locked_reason": null,
        })
    };
    // Shape only: the many other keys (null model windows, extra_usage, limits, spend) are ignored.
    let answer = json!({
        "five_hour": window(9.0, "2026-11-07T03:40:00.996524+00:00"),
        "seven_day": window(2.0, "2026-11-13T21:00:00.996541+00:00"),
        "seven_day_oauth_apps": null,
        "seven_day_opus": null,
        "seven_day_sonnet": null,
        "seven_day_cowork": null,
        "pace": null,
        "indicator": null,
        "extra_usage": { "is_enabled": false, "utilization": null },
        "limits": [{}, {}, {}],
        "spend": { "used": { "amount_minor": 0, "currency": "USD", "exponent": 2 }, "percent": 0 },
    });
    assert_eq!(
        parse_usage(&answer).unwrap(),
        UsageLimits {
            five_hour: Some(UsageWindow::new(9.0, Some("2026-11-07T03:40:00.996Z"))),
            seven_day: Some(UsageWindow::new(2.0, Some("2026-11-13T21:00:00.996Z"))),
            other_limit_reached: None,
            model_windows: None,
        }
    );
}

// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn reads_asked_together_share_one_keychain_read_so_macos_asks_once() {
    let dir = temp("relay-safe-storage-");
    let log = dir.path().join("calls");
    let tool = tool(
        dir.path(),
        &format!(
            "echo x >> \"{}\"\nsleep 0.3\necho \"{PASSWORD}\"\n",
            log.display()
        ),
    );
    let read = Arc::new(safe_storage_password(options(|| true, |_| {}, tool, None)));
    let answers: Vec<_> = [true, false, true, false]
        .map(|prompt| {
            let read = read.clone();
            std::thread::spawn(move || read.get(prompt))
        })
        .into_iter()
        .map(|t| t.join().unwrap().unwrap())
        .collect();
    assert_eq!(answers, [PASSWORD; 4]);
    assert_eq!(log_lines(&log).unwrap().len(), 1);
}

#[test]
fn the_renewal_window_gets_every_live_claude_ai_cookie_of_the_account_with_its_attributes_its_workspace_as_the_last_one()
 {
    let dir = temp("relay-renewal-cookies-");
    let file = dir.path().join("Cookies");
    let db = rusqlite::Connection::open(&file).unwrap();
    db.execute_batch(
        "create table meta (key text primary key, value text);
         insert into meta values ('version', '24');
         create table cookies (host_key text, name text, value text, encrypted_value blob, path text, is_secure integer, is_httponly integer, samesite integer, expires_utc integer);",
    )
    .unwrap();
    // Chromium's time: microseconds since 1601.
    let chromium = |unix_seconds: i64| (unix_seconds + 11_644_473_600) * 1_000_000;
    let later = relay_core::clock::now_ms() / 1000 + 86_400;
    let rows: [(&str, &str, &str, i64, i64, i64); 4] = [
        (
            ".claude.ai",
            "sessionKey",
            "sk-ant-sid01-abc",
            1,
            1,
            chromium(later),
        ),
        (
            "claude.ai",
            "__Host-ant_trusted_device",
            "trusted",
            1,
            1,
            chromium(later),
        ),
        (
            ".claude.ai",
            "lastActiveOrg",
            "another-org",
            0,
            1,
            chromium(later),
        ),
        (
            ".claude.ai",
            "__cf_bm",
            "old",
            1,
            0,
            chromium(later - 2 * 86_400),
        ),
    ];
    for (host, name, value, http_only, same_site, expires) in rows {
        db.execute(
            "insert into cookies values (?, ?, '', ?, '/', 1, ?, ?, ?)",
            rusqlite::params![
                host,
                name,
                encrypt(value, host),
                http_only,
                same_site,
                expires
            ],
        )
        .unwrap();
    }
    drop(db);
    let files = helpers::files("Cookies", Some(std::fs::read(&file).unwrap()));
    let reader = reader(
        move |_| Ok(files.clone()),
        Arc::new(|allow_prompt: bool| {
            assert!(!allow_prompt);
            Ok::<_, UsageError>(PASSWORD.to_owned())
        }),
        |_, _| Ok(json(200, "{}")),
        // The fixture is sealed with the macOS scheme (the Keychain password's key).
        Some(Platform::MacOs),
    );
    let cookies = reader.cookies(&account()).unwrap().unwrap();
    let seen: Vec<_> = cookies
        .iter()
        .map(|c| {
            (
                c.host.as_str(),
                c.name.as_str(),
                c.value.clone(),
                c.http_only,
                c.same_site,
                c.expires == Some(later as f64),
            )
        })
        .collect();
    assert_eq!(
        seen,
        [
            (
                ".claude.ai",
                "sessionKey",
                "sk-ant-sid01-abc".to_owned(),
                true,
                SameSite::Lax,
                true
            ),
            (
                "claude.ai",
                "__Host-ant_trusted_device",
                "trusted".to_owned(),
                true,
                SameSite::Lax,
                true
            ),
            (
                ".claude.ai",
                "lastActiveOrg",
                ORG.to_lowercase(),
                false,
                SameSite::Lax,
                true
            ),
        ]
    );
}

// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn a_password_read_once_is_kept_in_the_vault_and_later_runs_never_ask_the_keychain_again() {
    let dir = temp("relay-safe-storage-");
    let log = dir.path().join("calls");
    let tool = tool(
        dir.path(),
        &format!("echo x >> \"{}\"\necho \"{PASSWORD}\"\n", log.display()),
    );
    let (saved, vault) = memory_vault(None);
    let first = safe_storage_password(options(|| false, |_| {}, tool.clone(), Some(saved.clone())));
    assert_eq!(first.get(true).unwrap(), PASSWORD);
    assert_eq!(vault.lock().unwrap().as_deref(), Some(PASSWORD));
    // A new run (a restarted Relay): read from the vault, in the background too.
    let next = safe_storage_password(options(|| false, |_| {}, tool, Some(saved)));
    assert_eq!(next.get(false).unwrap(), PASSWORD);
    assert_eq!(log_lines(&log).unwrap().len(), 1);
}

/// A password that changed since it was kept; counts its `forget` calls.
struct ChangedPassword(AtomicUsize);

impl SafeStoragePassword for ChangedPassword {
    fn get(&self, _: bool) -> Result<String, UsageError> {
        Ok("a-password-that-changed".into())
    }
    fn forget(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn a_kept_password_that_no_longer_opens_the_cookies_is_forgotten_so_the_next_read_asks_the_keychain()
 {
    let files = cookie_database(&[(".claude.ai", "sessionKey", "sk-ant-sid01-abc")]);
    let password = Arc::new(ChangedPassword(AtomicUsize::new(0)));
    let reader = reader(
        move |_| Ok(files.clone()),
        password.clone(),
        |_, _| Ok(json(200, "{}")),
        None,
    );
    assert_eq!(
        reader.read(&account(), false).unwrap_err().issue,
        UsageIssue::Unsupported
    );
    assert_eq!(reader.cookies(&account()).unwrap(), None);
    assert_eq!(password.0.load(Ordering::SeqCst), 2);
}

// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn forget_drops_the_password_in_memory_and_in_the_vault() {
    let dir = temp("relay-safe-storage-");
    let log = dir.path().join("calls");
    let tool = tool(
        dir.path(),
        &format!("echo x >> \"{}\"\necho \"{PASSWORD}\"\n", log.display()),
    );
    let (saved, vault) = memory_vault(Some("an-old-password"));
    let read = safe_storage_password(options(|| true, |_| {}, tool, Some(saved)));
    assert_eq!(read.get(false).unwrap(), "an-old-password");
    read.forget();
    assert_eq!(*vault.lock().unwrap(), None);
    assert_eq!(read.get(false).unwrap(), PASSWORD);
    assert_eq!(vault.lock().unwrap().as_deref(), Some(PASSWORD));
}

// macOS only: the Keychain, through a shell stand-in for security.
#[cfg(unix)]
#[test]
fn a_vault_that_cannot_keep_the_password_never_fails_the_read_that_got_it() {
    let dir = temp("relay-safe-storage-");
    let tool = tool(dir.path(), &format!("echo \"{PASSWORD}\"\n"));
    let saved = SavedPassword {
        load: Arc::new(|| None),
        store: Arc::new(|_| Err("vault refuses".into())),
        clear: Arc::new(|| {}),
    };
    let read = safe_storage_password(options(|| true, |_| {}, tool, Some(saved)));
    assert_eq!(read.get(true).unwrap(), PASSWORD);
}

/// Release gate (network, run by hand: `cargo test -p relay-core --test desktop_usage -- --ignored
/// live`): claude.ai's Cloudflare lets Relay's own HTTP client through, as it let Electron. With no
/// cookie the answer is claude.ai's JSON refusal; a bot challenge would make every Claude app
/// limit read fail.
#[test]
#[ignore = "talks to claude.ai"]
fn live_claude_ai_answers_relays_client_without_a_challenge() {
    let response =
        relay_core::desktop_usage::claude_web_request("https://claude.ai/api/organizations", "")
            .expect("claude.ai answered");
    assert_ne!(
        response.cf_mitigated.as_deref(),
        Some("challenge"),
        "{response:?}"
    );
    assert!(response.content_type.contains("json"), "{response:?}");
}
