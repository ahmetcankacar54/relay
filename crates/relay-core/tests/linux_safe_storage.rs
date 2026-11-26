//! Port of `tests/linux-safe-storage.test.ts`.

#[path = "common/usage_desktop.rs"]
mod helpers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use helpers::{encrypt_with, temp};
use relay_core::desktop_usage::{
    CookieFiles, CookieKeys, CookieRows, DESKTOP_USAGE_MARKER, DesktopUsageDeps,
    DesktopUsageReader, EncryptedCookie, SafeStoragePassword, WebResponse, cookie_key,
    decrypt_cookie, desktop_usage_readable,
};
use relay_core::linux_safe_storage::{
    Env, LINUX_V10_KEY, LinuxKeyring, LinuxSafeStorageOptions, Run, RunCode, RunResult,
    linux_cookie_key, linux_keyring, linux_keyring_reachable, linux_safe_storage_password,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::types::{Account, AccountDesktop, UsageIssue};
use relay_core::usage_credentials::UsageError;
use serde_json::{Value, json};

const SECRET: &str = "fixture-keyring-secret";
const ORG: &str = "11111111-2222-4333-8444-555555555555";

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn kde6() -> Env {
    env(&[("XDG_CURRENT_DESKTOP", "KDE"), ("KDE_SESSION_VERSION", "6")])
}

fn issue_of(result: Result<String, UsageError>) -> Option<UsageIssue> {
    result.err().map(|e| e.issue)
}

#[test]
fn chromiums_linux_keys_one_pbkdf2_iteration_v10_from_peanuts_v11_from_the_keyring() {
    // Known answer, independent of the code under test.
    let mut expected = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"peanuts", b"saltysalt", 1, &mut expected);
    assert_eq!(*LINUX_V10_KEY, expected);
    let v11 = linux_cookie_key(SECRET);
    let keys = CookieKeys {
        v10: Some(*LINUX_V10_KEY),
        v11: Some(v11),
    };
    assert_eq!(
        decrypt_cookie(
            &encrypt_with("sk-ant-sid01-abc", ".claude.ai", "v11", &v11),
            &keys,
            ".claude.ai",
            24.0
        )
        .as_deref(),
        Some("sk-ant-sid01-abc")
    );
    assert_eq!(
        decrypt_cookie(
            &encrypt_with("plain", ".claude.ai", "v10", &LINUX_V10_KEY),
            &keys,
            ".claude.ai",
            24.0
        )
        .as_deref(),
        Some("plain")
    );
    // The macOS derivation (1003 iterations) is not Linux's.
    assert_eq!(
        decrypt_cookie(
            &encrypt_with("x", ".claude.ai", "v11", &cookie_key(SECRET)),
            &keys,
            ".claude.ai",
            24.0
        ),
        None
    );
    // A v11 value needs the keyring key; the host digest still guards against a moved value.
    let v10_only = CookieKeys {
        v10: Some(*LINUX_V10_KEY),
        v11: None,
    };
    assert_eq!(
        decrypt_cookie(
            &encrypt_with("x", ".claude.ai", "v11", &v11),
            &v10_only,
            ".claude.ai",
            24.0
        ),
        None
    );
    assert_eq!(
        decrypt_cookie(
            &encrypt_with("x", "claude.ai", "v11", &v11),
            &keys,
            ".claude.ai",
            24.0
        ),
        None
    );
}

#[test]
fn on_linux_the_keyring_is_asked_only_for_v11_login_cookies() {
    let mut account = Account::new("a", "A");
    account.desktop = Some(AccountDesktop {
        account_uuid: "0d1e2f3a-38b0-4c1f-9d39-6f1f4c0a1b2c".into(),
        org_id: ORG.into(),
        saved_at: String::new(),
        ..AccountDesktop::default()
    });
    let row = |name: &str, value: &str, prefix: &str| EncryptedCookie {
        host: ".claude.ai".into(),
        name: name.into(),
        value: String::new(),
        encrypted: encrypt_with(
            value,
            ".claude.ai",
            prefix,
            &if prefix == "v10" {
                *LINUX_V10_KEY
            } else {
                linux_cookie_key(SECRET)
            },
        ),
        ..EncryptedCookie::default()
    };
    let rows: Arc<Mutex<Vec<EncryptedCookie>>> = Arc::default();
    let prompts: Arc<Mutex<Vec<bool>>> = Arc::default();
    let cookies: Arc<Mutex<Vec<String>>> = Arc::default();
    let password: Arc<dyn SafeStoragePassword> = Arc::new({
        let prompts = prompts.clone();
        move |allow_prompt: bool| {
            prompts.lock().unwrap().push(allow_prompt);
            Ok::<_, UsageError>(SECRET.to_owned())
        }
    });
    let reader = DesktopUsageReader::new(DesktopUsageDeps {
        cookie_files: Arc::new(|_| Ok(CookieFiles::new())),
        read_rows: Some(Arc::new({
            let rows = rows.clone();
            move |_| {
                Ok(CookieRows {
                    version: 24.0,
                    rows: rows.lock().unwrap().clone(),
                })
            }
        })),
        password,
        request: Arc::new({
            let cookies = cookies.clone();
            move |_, cookie| {
                cookies.lock().unwrap().push(cookie.to_owned());
                Ok(WebResponse {
                    status: 200,
                    content_type: "application/json".into(),
                    retry_after: None,
                    body: "{}".into(),
                    cf_mitigated: None,
                })
            }
        }),
        now: None,
        platform: Some(Platform::Linux),
    });
    // --password-store=basic: no keyring at all.
    *rows.lock().unwrap() = vec![row("sessionKey", "sk-basic", "v10")];
    reader.read(&account, false).unwrap();
    assert!(prompts.lock().unwrap().is_empty());
    *rows.lock().unwrap() = vec![
        row("sessionKey", "sk-keyring", "v11"),
        row("lastActiveOrg", ORG, "v11"),
    ];
    reader.read(&account, true).unwrap();
    assert_eq!(*prompts.lock().unwrap(), [true]);
    assert_eq!(
        *cookies.lock().unwrap(),
        [
            "sessionKey=sk-basic".to_owned(),
            format!("sessionKey=sk-keyring; lastActiveOrg={ORG}")
        ]
    );
}

#[test]
fn chromiums_keyring_choice_follows_the_desktop() {
    assert_eq!(
        linux_keyring(&kde6()),
        LinuxKeyring::Kwallet {
            service: "org.kde.kwalletd6".into(),
            object_path: "/modules/kwalletd6".into()
        }
    );
    assert_eq!(
        linux_keyring(&env(&[
            ("XDG_CURRENT_DESKTOP", "KDE"),
            ("KDE_SESSION_VERSION", "5")
        ])),
        LinuxKeyring::Kwallet {
            service: "org.kde.kwalletd5".into(),
            object_path: "/modules/kwalletd5".into()
        }
    );
    assert_eq!(
        linux_keyring(&env(&[("XDG_CURRENT_DESKTOP", "ubuntu:GNOME")])),
        LinuxKeyring::SecretService
    );
    assert_eq!(linux_keyring(&Env::new()), LinuxKeyring::SecretService);
    assert!(linux_keyring_reachable(&kde6(), &|f| f == "/usr/bin/busctl"));
    let gnome = env(&[("XDG_CURRENT_DESKTOP", "GNOME")]);
    assert!(!linux_keyring_reachable(&gnome, &|f| f == "/usr/bin/busctl"));
    // secret-tool counts only at its two fixed places, never wherever PATH points.
    assert!(linux_keyring_reachable(&gnome, &|f| f == "/usr/local/bin/secret-tool"));
    assert!(!linux_keyring_reachable(
        &env(&[("XDG_CURRENT_DESKTOP", "GNOME"), ("PATH", "/tmp")]),
        &|f| f == "/tmp/secret-tool"
    ));
}

/// A busctl stand-in answering KWallet's D-Bus methods as `busctl --json=short` does.
struct Kwallet {
    run: Run,
    calls: Arc<Mutex<Vec<Vec<String>>>>,
}

impl Kwallet {
    fn new(answers: Value, failing: Option<&'static str>) -> Kwallet {
        let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
        let run: Run = Arc::new({
            let calls = calls.clone();
            move |file: &str, args: &[String], _| {
                assert_eq!(file, "/usr/bin/busctl");
                calls.lock().unwrap().push(args.to_vec());
                let method = args[7].as_str();
                if Some(method) == failing {
                    return RunResult {
                        code: Some(RunCode::Exit(1)),
                        stdout: String::new(),
                        stderr: "Call failed".into(),
                    };
                }
                RunResult {
                    code: None,
                    stdout: json!({ "type": "x", "data": [answers.get(method)] }).to_string(),
                    stderr: String::new(),
                }
            }
        });
        Kwallet { run, calls }
    }

    fn calls(&self) -> Vec<Vec<String>> {
        self.calls.lock().unwrap().clone()
    }

    fn methods(&self) -> Vec<String> {
        self.calls().iter().map(|c| c[7].clone()).collect()
    }
}

#[test]
fn kwallet_claudes_own_folder_and_key_never_opened_in_the_background_while_closed() {
    let remembered: Arc<Mutex<Vec<bool>>> = Arc::default();
    let allowed = Arc::new(AtomicBool::new(false));
    let make = |run: &Run| {
        linux_safe_storage_password(LinuxSafeStorageOptions {
            allowed: Arc::new({
                let allowed = allowed.clone();
                move || allowed.load(Ordering::SeqCst)
            }),
            remember: Arc::new({
                let remembered = remembered.clone();
                move |a| remembered.lock().unwrap().push(a)
            }),
            env: Some(kde6()),
            run: Some(run.clone()),
        })
    };
    let answers = json!({
        "networkWallet": "kdewallet", "isOpen": true, "open": 7, "hasEntry": true,
        "readPassword": SECRET, "close": 0
    });
    let with = |key: &str, value: Value| {
        let mut a = answers.clone();
        a[key] = value;
        a
    };

    // Not allowed yet: no D-Bus call at all.
    let quiet = Kwallet::new(answers.clone(), None);
    assert_eq!(
        issue_of(make(&quiet.run).get(false)),
        Some(UsageIssue::KeychainLocked)
    );
    assert!(quiet.calls().is_empty());

    // Allowed, but the wallet is closed: opening it would show its unlock dialog.
    allowed.store(true, Ordering::SeqCst);
    let closed = Kwallet::new(with("isOpen", json!(false)), None);
    assert_eq!(
        issue_of(make(&closed.run).get(false)),
        Some(UsageIssue::KeychainLocked)
    );
    assert_eq!(closed.methods(), ["networkWallet", "isOpen"]);
    assert!(remembered.lock().unwrap().is_empty());

    let open = Kwallet::new(answers.clone(), None);
    let read = make(&open.run);
    assert_eq!(read.get(false).unwrap(), SECRET);
    assert_eq!(
        open.methods(),
        [
            "networkWallet",
            "isOpen",
            "open",
            "hasEntry",
            "readPassword",
            "close"
        ]
    );
    let calls = open.calls();
    assert_eq!(
        calls[4][calls[4].len() - 4..],
        ["7", "Claude Keys", "Claude Safe Storage", "Relay"]
    );
    assert!(
        calls[0].iter().any(|a| a == "org.kde.kwalletd6")
            && calls[0].iter().any(|a| a == "/modules/kwalletd6")
    );
    assert_eq!(*remembered.lock().unwrap(), [true]);
    // Kept for the run.
    assert_eq!(read.get(false).unwrap(), SECRET);
    assert_eq!(open.calls().len(), 6);

    // Asked for: the wallet may be opened (its dialog is the user's answer).
    let asked = Kwallet::new(with("isOpen", json!(false)), None);
    assert_eq!(make(&asked.run).get(true).unwrap(), SECRET);
    assert!(!asked.methods().iter().any(|m| m == "isOpen"));

    let missing = Kwallet::new(with("hasEntry", json!(false)), None);
    assert_eq!(
        issue_of(make(&missing.run).get(true)),
        Some(UsageIssue::CredentialsMissing)
    );
    assert_eq!(missing.methods().last().map(String::as_str), Some("close"));

    remembered.lock().unwrap().clear();
    let refused = Kwallet::new(answers, Some("open"));
    assert_eq!(
        issue_of(make(&refused.run).get(true)),
        Some(UsageIssue::KeychainLocked)
    );
    assert_eq!(*remembered.lock().unwrap(), [false]);
}

fn secret_service(run: Run) -> Result<String, UsageError> {
    linux_safe_storage_password(LinuxSafeStorageOptions {
        allowed: Arc::new(|| true),
        remember: Arc::new(|_| {}),
        env: Some(env(&[("XDG_CURRENT_DESKTOP", "GNOME")])),
        run: Some(run),
    })
    .get(false)
}

fn answer(code: Option<RunCode>, stdout: &str, stderr: &str) -> RunResult {
    RunResult {
        code,
        stdout: stdout.into(),
        stderr: stderr.into(),
    }
}

#[test]
fn secret_service_the_item_chromiums_schema_files_under_claudes_name() {
    let calls: Arc<Mutex<Vec<Vec<String>>>> = Arc::default();
    let files: Arc<Mutex<Vec<String>>> = Arc::default();
    let current = Arc::new(Mutex::new(answer(None, &format!("{SECRET}\n"), "")));
    let run: Run = Arc::new({
        let (calls, files, current) = (calls.clone(), files.clone(), current.clone());
        move |file: &str, args: &[String], _| {
            files.lock().unwrap().push(file.to_owned());
            calls.lock().unwrap().push(args.to_vec());
            current.lock().unwrap().clone()
        }
    });
    let read = || secret_service(run.clone());
    assert_eq!(read().unwrap(), SECRET);
    assert_eq!(*files.lock().unwrap(), ["/usr/bin/secret-tool"]);
    assert_eq!(
        calls.lock().unwrap()[0],
        [
            "lookup",
            "xdg:schema",
            "chrome_libsecret_os_crypt_password_v2",
            "application",
            "Claude"
        ]
    );
    *current.lock().unwrap() = answer(Some(RunCode::Exit(1)), "", "");
    assert_eq!(issue_of(read()), Some(UsageIssue::CredentialsMissing));
    *current.lock().unwrap() = answer(
        Some(RunCode::Exit(1)),
        "",
        "secret-tool: Cannot create an item in a locked collection",
    );
    assert_eq!(issue_of(read()), Some(UsageIssue::KeychainLocked));
    // Installed at neither place: the keyring cannot be read.
    files.lock().unwrap().clear();
    *current.lock().unwrap() = answer(Some(RunCode::Error("ENOENT".into())), "", "");
    assert_eq!(issue_of(read()), Some(UsageIssue::KeychainLocked));
    assert_eq!(
        *files.lock().unwrap(),
        ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"]
    );
}

#[test]
fn secret_service_secret_tool_under_usr_local_bin_is_used_when_usr_bin_has_none() {
    let files: Arc<Mutex<Vec<String>>> = Arc::default();
    let secret = secret_service(Arc::new({
        let files = files.clone();
        move |file: &str, _: &[String], _| {
            files.lock().unwrap().push(file.to_owned());
            if file == "/usr/bin/secret-tool" {
                answer(Some(RunCode::Error("ENOENT".into())), "", "")
            } else {
                answer(None, SECRET, "")
            }
        }
    }))
    .unwrap();
    assert_eq!(secret, SECRET);
    assert_eq!(
        *files.lock().unwrap(),
        ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool"]
    );
}

#[test]
fn the_claude_app_reads_limits_on_macos_always_on_linux_only_after_a_keyring_read_succeeded() {
    let dir = temp("relay-desktop-readable-");
    assert!(desktop_usage_readable(dir.path(), Platform::MacOs));
    assert!(!desktop_usage_readable(dir.path(), Platform::Linux));
    assert!(!desktop_usage_readable(dir.path(), Platform::Windows));
    std::fs::write(
        dir.path().join(DESKTOP_USAGE_MARKER),
        json!({ "allowed": true }).to_string(),
    )
    .unwrap();
    assert!(desktop_usage_readable(dir.path(), Platform::Linux));
    assert!(!desktop_usage_readable(dir.path(), Platform::Windows));
}
