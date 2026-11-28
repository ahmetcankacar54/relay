//! The non-window checks of the old scripts/smoke.cjs, through the bridge's dispatch: a booted
//! core on a throwaway home with a fake `claude`, a fake `security` and no real accounts,
//! credentials, browser, model calls or user history. macOS only, as the Electron smoke was
//! (Linux and Windows would reach the system keyring for the vault key).
#![cfg(target_os = "macos")]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use relay_app::ipc::{Call, Sender, dispatch, dispatch_send};
use relay_app::state::STATE;
use relay_core::host::{
    AppPaths, FileDialog, MessageBox, MessageBoxResult, Notice, QuietOpened, QuietWindow, Shell,
    SignInWindow, Webviews,
};
use serde_json::{Value, json};

/// Dialogs answer as the Electron smoke's stubbed `showOpenDialog`: the project folder for a
/// folder, the fixture for a file.
struct FakeShell {
    file: PathBuf,
    notices: Mutex<Vec<String>>,
}

impl Shell for FakeShell {
    fn message_box(&self, _options: &MessageBox) -> MessageBoxResult {
        MessageBoxResult::default()
    }
    fn error_box(&self, _title: &str, _content: &str) {}
    fn save_dialog(&self, _options: &FileDialog) -> Option<PathBuf> {
        None
    }
    fn open_dialog(&self, _options: &FileDialog) -> Option<PathBuf> {
        Some(self.file.clone())
    }
    fn write_clipboard(&self, _text: &str) {}
    fn open_external(&self, _url: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_path(&self, _path: &Path) -> Result<(), String> {
        Ok(())
    }
    fn show_item_in_folder(&self, _path: &Path) {}
    fn notify(&self, notice: &Notice) {
        self.notices.lock().unwrap().push(notice.title.clone());
    }
    fn refresh_tray(&self) {}
}

struct NoWebviews;

impl Webviews for NoWebviews {
    fn show_sign_in(&self, _window: SignInWindow) {}
    fn close_sign_in(&self, _account_id: &str) {}
    fn forget_sign_in_session(&self, _account_id: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_quiet(&self, _window: &QuietWindow) -> Result<QuietOpened, String> {
        Err("no windows in the smoke test".into())
    }
}

const FIXTURE: &str = r#"#!/bin/sh
root="$CLAUDE_CONFIG_DIR"
if [ "$1" = "--version" ]; then echo '2.1.296 (Relay fixture)'; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -f "$root/logged-out" ]; then in=false; else in=true; fi
  printf '{"loggedIn":%s,"authMethod":"claude.ai","email":"fixture@example.test","subscriptionType":"max"}\n' "$in"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then echo FIXTURE_LOGIN_OK; sleep 0.1; exit 0; fi
id=""; prev=""; resume=0
for a in "$@"; do
  if [ "$prev" = "--session-id" ]; then id="$a"; fi
  if [ "$prev" = "--resume" ]; then id="$a"; resume=1; fi
  prev="$a"
done
folder="$(pwd | sed 's/[^a-zA-Z0-9]/-/g')"
dir="$root/projects/$folder"; mkdir -p "$dir"
file="$dir/$id.jsonl"
if [ "$resume" = 1 ] && [ ! -f "$file" ]; then echo RESUME_NOT_FOUND >&2; exit 2; fi
uuid="$(uuidgen | tr 'A-Z' 'a-z')"
printf '{"type":"user","uuid":"%s","sessionId":"%s","cwd":"%s","message":{"role":"user","content":"Fixture working session"}}\n' "$uuid" "$id" "$(pwd)" >> "$file"
echo FIXTURE_READY
args=""; for a in "$@"; do args="$args\"$a\","; done
printf '{"args":[%s],"config":"%s","cwd":"%s"%s}' "${args%,}" "$root" "$(pwd)" "${ANTHROPIC_API_KEY:+,\"key\":\"set\"}" > "$root/observed.json"
trap 'exit 0' HUP TERM
while IFS= read -r line; do printf 'ECHO:%s\n' "$line"; done
"#;

/// The vault key goes to a fake Keychain in the test folder, never the login Keychain.
fn fake_security(root: &Path) -> String {
    format!(
        r#"#!/bin/sh
dir="{}"
if [ "$1" = "-i" ]; then
  value="$(cat | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\1/' | head -1)"
  [ -f "$dir/vault-key" ] || printf '%s' "$value" > "$dir/vault-key"
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/vault-key" ] || exit 44
  cat "$dir/vault-key"; echo
  exit 0
fi
exit 9
"#,
        root.display()
    )
}

fn executable(path: &Path, text: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn call(method: &str, args: Vec<Value>) -> Result<Value, String> {
    dispatch(&format!("relay:{method}"), &Call::new(Sender::Main, args))
}

fn ok(method: &str, args: Vec<Value>) -> Value {
    call(method, args).unwrap_or_else(|e| panic!("relay:{method} failed: {e}"))
}

fn rejects(method: &str, args: Vec<Value>) -> String {
    match call(method, args.clone()) {
        Ok(value) => panic!("relay:{method} {args:?} should fail, answered {value}"),
        Err(error) => error,
    }
}

fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while Instant::now() < until {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("timed out waiting for {what}");
}

fn buffer(run: &str) -> String {
    call("buffer", vec![json!(run)])
        .ok()
        .and_then(|b| b["data"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Boots the core on a throwaway home (the env overrides an unpackaged build honors).
fn boot(root: &Path) -> PathBuf {
    let project = root.join("project with spaces");
    std::fs::create_dir_all(&project).unwrap();
    let fixture = root.join("claude-fixture");
    executable(&fixture, FIXTURE);
    let security = root.join("fake-security");
    executable(&security, &fake_security(root));
    std::fs::create_dir_all(root.join("appdata").join("Claude")).unwrap();
    // SAFETY: set once, before any thread of this test binary reads the environment.
    unsafe {
        std::env::set_var("RELAY_HOME", root.join("app"));
        std::env::set_var("RELAY_CLAUDE_DIR", root.join("appdata").join("Claude"));
        std::env::set_var("RELAY_CLAUDE_APP", root.join("no-claude.app"));
        std::env::set_var("RELAY_SECURITY_TOOL", &security);
        std::env::set_var("HOME", root);
    }
    let _ = STATE.shell.set(Arc::new(FakeShell {
        file: fixture,
        notices: Mutex::new(Vec::new()),
    }) as Arc<dyn Shell>);
    let _ = STATE
        .webviews
        .set(Arc::new(NoWebviews) as Arc<dyn Webviews>);
    let _ = STATE
        .paths
        .set(Arc::new(relay_app::host::TauriPaths::new(None)) as Arc<dyn AppPaths>);
    relay_app::boot::boot_core().expect("the core boots");
    STATE
        .initialized
        .store(true, std::sync::atomic::Ordering::SeqCst);
    relay_app::boot::start::boot_start();
    project
}

#[test]
fn desktop_integration() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let project = boot(&root);

    // Empty first launch.
    assert_eq!(ok("snapshot", vec![])["accounts"], json!([]));
    let legacy = ok("legacy-ui-storage", vec![]);
    assert!(legacy.is_null() || legacy.is_object());

    // Continuation starts off; invalid IPC fails before the native observer runs.
    let continuation = &ok("panel-snapshot", vec![])["continuation"];
    assert_eq!(continuation["status"], "off");
    assert_eq!(continuation["enabled"], false);
    assert_eq!(continuation["canArm"], false);
    rejects(
        "arm-continuation",
        vec![
            json!("invalid-account"),
            json!("guarded-native-at-most-once"),
        ],
    );
    rejects(
        "arm-continuation",
        vec![json!(uuid()), json!("implicit-consent")],
    );

    // Desktop error dismissal.
    let revision = ok("desktop-snapshot", vec![])["errorRevision"].clone();
    ok("dismiss-desktop-error", vec![revision]);
    assert!(ok("desktop-snapshot", vec![]).get("error").is_none());
    rejects("dismiss-desktop-error", vec![json!(-1)]);

    // Persistent settings and their validation.
    assert_eq!(
        ok("panel-snapshot", vec![])["settings"]["usageRefreshMinutes"],
        5
    );
    ok(
        "update-settings",
        vec![json!({ "usageRefreshMinutes": 0, "desktopHistoryTransfer": "off" })],
    );
    assert_eq!(
        ok("panel-snapshot", vec![])["settings"]["desktopHistoryTransfer"],
        "off"
    );
    rejects("update-settings", vec![json!({ "autoSwitch": true })]);
    rejects("refresh-usage", vec![json!("../../invalid")]);

    // Profiles, with the fixture as the Claude Code executable.
    ok("pick-executable", vec![]);
    let a = ok(
        "create-account",
        vec![json!({ "name": "Test Max A", "kind": "personal" })],
    );
    let b = ok(
        "create-account",
        vec![json!({ "name": "Test Max B", "kind": "personal" })],
    );
    let work = ok(
        "create-account",
        vec![json!({ "name": "Separate company", "kind": "work" })],
    );
    let (a_id, b_id, work_id) = (
        a["id"].as_str().unwrap().to_owned(),
        b["id"].as_str().unwrap().to_owned(),
        work["id"].as_str().unwrap().to_owned(),
    );

    // Language.
    ok("set-language", vec![json!("en")]);
    rejects("set-language", vec![json!("invalid")]);

    // Plan-aware account metadata and planning.
    let initial = ok("panel-snapshot", vec![])["settings"]["planning"].clone();
    assert_eq!(initial["autoStart"], false);
    assert_eq!(initial["accounts"], json!([]));
    let planned = ok(
        "account-planning",
        vec![json!(a_id), json!({ "plan": "max5", "capacityWeight": 5 })],
    );
    assert_eq!(planned["planning"]["plan"], "max5");
    rejects(
        "account-planning",
        vec![json!(a_id), json!({ "plan": "max5", "capacityWeight": 0 })],
    );
    rejects(
        "account-planning",
        vec![json!(uuid()), json!({ "plan": "pro", "capacityWeight": 1 })],
    );
    let planning = ok(
        "update-planning",
        vec![json!({
            "weekday": { "enabled": true, "start": "22:00", "end": "06:00" },
            "accounts": [{ "id": a_id }, { "id": b_id, "firstStart": "07:00" }],
        })],
    );
    assert_eq!(planning["weekday"]["end"], "06:00");
    assert_eq!(
        planning["accounts"],
        json!([{ "id": a_id }, { "id": b_id, "firstStart": "07:00" }])
    );
    ok("update-settings", vec![json!({ "usageWarnings": false })]);
    let snapshot = ok("panel-snapshot", vec![]);
    assert_eq!(snapshot["settings"]["planning"], planning);
    assert_eq!(snapshot["planning"]["enabled"], false);
    assert!(snapshot.get("usageStatistics").is_none());
    // A tempo choice survives a patch that does not mention it; so does adaptation off.
    assert_eq!(
        ok("update-planning", vec![json!({ "tempo": "heavy" })])["tempo"],
        "heavy"
    );
    assert_eq!(
        ok("update-planning", vec![json!({ "autoStart": false })])["tempo"],
        "heavy"
    );
    let tempo = ok("panel-snapshot", vec![])["planning"]["tempo"].clone();
    assert_eq!(tempo["source"], "preset");
    assert_eq!(tempo["rate"]["weekday"], 120);
    assert_eq!(
        ok("update-planning", vec![json!({ "tempo": "auto" })])["tempo"],
        "auto"
    );
    assert_eq!(
        ok("update-planning", vec![json!({ "adaptive": false })])["adaptive"],
        false
    );
    assert_eq!(
        ok("update-planning", vec![json!({ "autoStart": false })])["adaptive"],
        false
    );
    assert_eq!(
        ok("update-planning", vec![json!({ "adaptive": true })])["adaptive"],
        true
    );

    // Default-off keeper and empty usage statistics.
    let statistics = ok("usage-statistics", vec![json!({ "range": 30 })]);
    assert_eq!(statistics["range"], 30);
    assert!(["available", "empty"].contains(&statistics["status"].as_str().unwrap()));
    assert_eq!(statistics["heatmap"].as_array().unwrap().len(), 7);
    rejects("usage-statistics", vec![json!({ "range": 14 })]);
    rejects(
        "usage-statistics",
        vec![json!({ "range": 30, "accountId": "../../invalid" })],
    );
    rejects("update-planning", vec![json!({ "timeZone": "invalid" })]);
    rejects(
        "update-planning",
        vec![json!({ "accounts": [{ "id": uuid() }] })],
    );

    // Settings that name accounts.
    assert_eq!(ok("panel-snapshot", vec![])["autoSwitch"]["status"], "off");
    ok(
        "update-settings",
        vec![json!({
            "desktopHistoryTransfer": "selected",
            "desktopHistoryAccounts": [a_id, work_id],
            "autoSwitchAccounts": [a_id, b_id],
        })],
    );
    ok("update-settings", vec![json!({ "usageWarnings": false })]);
    let preserved = ok("panel-snapshot", vec![])["settings"].clone();
    assert_eq!(preserved["desktopHistoryAccounts"], json!([a_id, work_id]));
    assert_eq!(preserved["autoSwitchAccounts"], json!([a_id, b_id]));
    assert_eq!(preserved["autoSwitchMode"], "off");
    rejects(
        "update-settings",
        vec![json!({ "autoSwitchAccounts": [uuid()] })],
    );
    rejects(
        "update-settings",
        vec![json!({ "desktopHistoryAccounts": [a_id, a_id] })],
    );
    rejects("desktop-history-summary", vec![json!("../../invalid")]);
    rejects("sync-desktop-history", vec![json!("../../invalid")]);
    ok(
        "update-settings",
        vec![json!({ "desktopHistoryTransfer": "off" })],
    );

    // Quota with a disconnected account; auth status; hidden login, idempotent.
    assert_eq!(
        ok("refresh-usage", vec![json!(a_id)])["issue"],
        "connect-cli"
    );
    assert_eq!(
        ok("check-auth", vec![json!(a_id)])["auth"]["loggedIn"],
        true
    );
    let login = ok("login", vec![json!(a_id)]);
    assert_eq!(ok("login", vec![json!(a_id)])["id"], login["id"]);
    eventually("the login to connect", || {
        ok("snapshot", vec![])["authFlows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["id"] == login["id"] && f["status"] == "connected")
    });
    let snapshot = ok("snapshot", vec![]);
    assert_eq!(snapshot["runs"], json!([]));
    assert!(
        snapshot["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["id"] == json!(a_id) && x["auth"]["loggedIn"] == true)
    );
    // The login is not in the terminal registry.
    assert!(rejects("buffer", vec![login["id"].clone()]).contains("Terminal not found"));

    // A real PTY: launch, input and output.
    let run_a = ok(
        "launch",
        vec![json!({ "accountId": a_id, "cwd": project.to_string_lossy() })],
    );
    let run_a_id = run_a["id"].as_str().unwrap().to_owned();
    eventually("the fixture to start", || {
        buffer(&run_a_id).contains("FIXTURE_READY")
    });
    let observed: Value = serde_json::from_slice(
        &std::fs::read(root.join("app/profiles").join(&a_id).join("observed.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(observed["cwd"], json!(project.to_string_lossy()));
    assert!(observed.get("key").is_none());
    assert!(
        observed["args"]
            .as_array()
            .unwrap()
            .contains(&json!("--session-id"))
    );
    dispatch_send(
        "relay:write",
        &Call::new(Sender::Main, vec![json!(run_a_id), json!("hello\r")]),
    )
    .unwrap();
    eventually("the echo", || buffer(&run_a_id).contains("ECHO:hello"));

    // Pin and preview.
    let snapshot = ok("snapshot", vec![]);
    let original = snapshot["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["accountId"] == json!(a_id))
        .expect("the fixture session")
        .clone();
    assert_eq!(original["messages"], 1);
    ok("pin", vec![original["key"].clone(), json!(true)]);
    assert!(
        ok("snapshot", vec![])["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["key"] == original["key"] && s["pinned"] == true)
    );
    assert_eq!(
        ok("transcript", vec![original["key"].clone()])[0]["text"],
        "Fixture working session"
    );

    // An active writer, the company boundary, and an unauthenticated target.
    assert!(
        rejects(
            "launch",
            vec![json!({ "accountId": b_id, "sessionKey": original["key"] })]
        )
        .contains("running session")
    );
    assert!(
        rejects("switch-account", vec![json!(run_a_id), json!(work_id)]).contains("sharing group")
    );
    let status_of = |id: &str| {
        ok("snapshot", vec![])["runs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == json!(id))
            .map(|r| r["status"].clone())
    };
    assert_eq!(status_of(&run_a_id), Some(json!("running")));
    let logged_out = root.join("app/profiles").join(&b_id).join("logged-out");
    std::fs::write(&logged_out, "").unwrap();
    assert!(
        rejects("switch-account", vec![json!(run_a_id), json!(b_id)])
            .contains("Sign in to the target account")
    );
    assert_eq!(status_of(&run_a_id), Some(json!("running")));
    std::fs::remove_file(&logged_out).unwrap();

    // A → B → A.
    let run_b = ok("switch-account", vec![json!(run_a_id), json!(b_id)]);
    let run_b_id = run_b["id"].as_str().unwrap().to_owned();
    eventually("B to start", || buffer(&run_b_id).contains("FIXTURE_READY"));
    let snapshot = ok("snapshot", vec![]);
    assert_eq!(status_of(&run_a_id), Some(json!("exited")));
    let copied = snapshot["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["accountId"] == json!(b_id))
        .expect("the copied session")
        .clone();
    assert_eq!(copied["messages"], 2);
    assert_eq!(copied["forkedFrom"], original["key"]);
    assert_ne!(copied["id"], original["id"]);
    let run_back = ok("switch-account", vec![json!(run_b_id), json!(a_id)]);
    let run_back_id = run_back["id"].as_str().unwrap().to_owned();
    eventually("A to start again", || {
        buffer(&run_back_id).contains("FIXTURE_READY")
    });
    ok("stop", vec![json!(run_back_id)]);
    let snapshot = ok("snapshot", vec![]);
    let sessions = snapshot["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 3, "three preserved branches");
    let messages = |key: &Value| {
        sessions
            .iter()
            .find(|s| &s["key"] == key)
            .map(|s| s["messages"].clone())
    };
    assert_eq!(messages(&original["key"]), Some(json!(1)));
    assert_eq!(messages(&run_back["sessionKey"]), Some(json!(3)));

    // Cooldown, the boundary again, and desktop consent.
    ok("cooldown", vec![json!(b_id), json!(5)]);
    assert!(
        rejects(
            "launch",
            vec![json!({ "accountId": b_id, "sessionKey": copied["key"] })]
        )
        .contains("on hold")
    );
    ok("cooldown", vec![json!(b_id), json!(0)]);
    assert!(
        rejects(
            "launch",
            vec![json!({ "accountId": work_id, "sessionKey": copied["key"] })]
        )
        .contains("sharing group")
    );
    assert!(
        rejects(
            "launch",
            vec![json!({
                "accountId": a_id,
                "cwd": project.to_string_lossy(),
                "desktop": true,
            })]
        )
        .contains("right account is open in the Claude app")
    );
    rejects(
        "launch",
        vec![json!({ "accountId": "../../invalid", "cwd": project.to_string_lossy() })],
    );
    STATE.set_quitting(true);
}
