//! Port of tests/routine-runner.test.ts. The injected `execute` records each call instead of
//! running `claude`, as the TS test does. `options.shell === false` has no Rust counterpart: the
//! runner never starts a shell.

use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use relay_core::environment::{CommandError, CommandOutput, Env};
use relay_core::routine_runner::{
    ExecRequest, QuotaStarterOptions, RoutineError, quota_starter_args, routine_environment,
    run_quota_starter, window_start_eligible,
};
use relay_core::shared::types::Account;
use relay_core::store::{Store, StoreOptions};
use relay_core::usage_credentials::{UsageCredential, UsageError};
use serde_json::json;

/// `Date.parse("2026-10-13T06:00:00Z")`.
const NOW: i64 = 1_791_871_200_000;
const FULL_HELP: &str = "--safe-mode --tools --strict-mcp-config --setting-sources --no-session-persistence --permission-prompts";

/// `planningAccount(id)` of tests/planning-fixtures.ts.
fn planning_account(id: &str) -> Account {
    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "kind": "personal",
        "group": "personal",
        "color": "olive",
        "createdAt": "2026-10-13T05:59:45.000Z",
        "planning": { "plan": "pro", "capacityWeight": 1 },
        "auth": {
            "loggedIn": true,
            "accountUuid": id,
            "orgId": format!("org-{id}"),
            "subscription": "pro",
            "checkedAt": "2026-10-13T05:59:45.000Z",
        },
    }))
    .unwrap()
}

#[allow(dead_code)]
struct Command {
    file: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: Option<Env>,
}

type Answer = Result<CommandOutput, CommandError>;

struct Fixture {
    _tmp: tempfile::TempDir,
    store: Store,
    account: Account,
    profile: PathBuf,
    commands: RefCell<Vec<Command>>,
    help: RefCell<String>,
    model_error: RefCell<Option<String>>,
    defaults: RefCell<Option<Box<dyn Fn() -> Answer>>>,
    credential_calls: Cell<usize>,
    guard: Cell<bool>,
    revoke_during_credentials: Cell<bool>,
    policy_paths: RefCell<Vec<PathBuf>>,
}

fn failure(code: Option<i32>, text: &str, stderr: &str) -> CommandError {
    CommandError {
        program: text.into(),
        code,
        stdout: String::new(),
        stderr: stderr.into(),
    }
}

fn output(stdout: &str) -> Answer {
    Ok(CommandOutput {
        stdout: stdout.into(),
        stderr: String::new(),
    })
}

fn fixture() -> Fixture {
    let tmp = tempfile::Builder::new()
        .prefix("relay-starter-test-")
        .tempdir()
        .unwrap();
    let store = Store::open(tmp.path(), StoreOptions::default()).unwrap();
    let mut account = planning_account(&uuid::Uuid::new_v4().to_string());
    let auth = account.auth.as_mut().unwrap();
    auth.account_uuid = Some(uuid::Uuid::new_v4().to_string());
    auth.org_id = Some(uuid::Uuid::new_v4().to_string());
    let stored = account.clone();
    let exec = std::env::current_exe().unwrap();
    store
        .update(|state| {
            state.accounts = vec![stored];
            state.executable = Some(exec.to_string_lossy().into_owned());
        })
        .unwrap();
    let profile = store.profile(&account.id).unwrap();
    fs::create_dir_all(&profile).unwrap();
    let auth = account.auth.as_ref().unwrap();
    fs::write(
        profile.join(".config.json"),
        json!({
            "oauthAccount": {
                "accountUuid": auth.account_uuid,
                "organizationUuid": auth.org_id,
                "emailAddress": "fixture@example.test",
            },
        })
        .to_string(),
    )
    .unwrap();
    Fixture {
        _tmp: tmp,
        store,
        account,
        profile,
        commands: RefCell::new(Vec::new()),
        help: RefCell::new(FULL_HELP.into()),
        model_error: RefCell::new(None),
        defaults: RefCell::new(None),
        credential_calls: Cell::new(0),
        guard: Cell::new(true),
        revoke_during_credentials: Cell::new(false),
        policy_paths: RefCell::new(Vec::new()),
    }
}

impl Fixture {
    fn execute(&self, request: &ExecRequest) -> Answer {
        if request.file == "/usr/bin/defaults"
            && let Some(defaults) = self.defaults.borrow().as_ref()
        {
            return defaults();
        }
        self.commands.borrow_mut().push(Command {
            file: request.file.into(),
            args: request.args.to_vec(),
            cwd: request.cwd.map(Path::to_path_buf),
            env: request.env.cloned(),
        });
        if request.file == "/usr/bin/defaults" {
            return Err(failure(
                Some(1),
                "Fixture absent preferences",
                "Domain com.anthropic.claudecode does not exist",
            ));
        }
        if request.args.first().map(String::as_str) == Some("--help") {
            return output(&self.help.borrow());
        }
        if let Some(message) = self.model_error.borrow().as_ref() {
            return Err(failure(None, message, message));
        }
        output(&json!({ "subtype": "success", "result": "OK", "is_error": false }).to_string())
    }

    fn credentials(&self, dir: &Path, prompt: bool) -> Result<UsageCredential, UsageError> {
        self.credential_calls.set(self.credential_calls.get() + 1);
        assert_eq!(dir, self.profile);
        assert!(!prompt);
        if self.revoke_during_credentials.get() {
            self.guard.set(false);
        }
        Ok(UsageCredential {
            access_token: "fixture-only-token".into(),
            expires_at: Some((NOW + 60_000) as f64),
            scopes: vec!["user:inference".into()],
            ..Default::default()
        })
    }

    fn run(&self, signal: Option<&AtomicBool>) -> Result<(), RoutineError> {
        let execute = |request: &ExecRequest| self.execute(request);
        let guard = || self.guard.get();
        let now = || NOW;
        let credentials = |dir: &Path, prompt: bool| self.credentials(dir, prompt);
        run_quota_starter(
            &self.store,
            &self.account,
            &credentials,
            &QuotaStarterOptions {
                execute: Some(&execute),
                policy_paths: Some(self.policy_paths.borrow().clone()),
                now: Some(&now),
                guard: Some(&guard),
                signal,
            },
        )
    }

    fn model(&self) -> Option<usize> {
        self.commands
            .borrow()
            .iter()
            .position(|c| c.args.first().map(String::as_str) == Some("--print"))
    }
}

#[cfg(not(windows))] // routines run on macOS and Linux only
#[test]
fn starter_fake_process_uses_isolated_temporary_cwd_token_environment_only_and_removes_cwd() {
    let f = fixture();
    f.run(None).unwrap();
    let commands = f.commands.borrow();
    let model = &commands[f.model().unwrap()];
    let cwd = model.cwd.clone().unwrap();
    assert_ne!(cwd, f.profile);
    assert_ne!(cwd, f.store.root);
    assert!(
        cwd.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("relay-quota-starter-")
    );
    let env = model.env.as_ref().unwrap();
    assert_eq!(
        env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some(f.profile.to_string_lossy().as_ref())
    );
    assert_eq!(
        env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str),
        Some("fixture-only-token")
    );
    assert!(!model.args.iter().any(|a| a.contains("fixture-only-token")));
    assert_eq!(f.credential_calls.get(), 1);
    assert!(fs::metadata(&cwd).is_err());
}

#[cfg(not(windows))]
#[test]
fn unsupported_cli_refuses_before_credentials_and_never_attempts_a_model_fallback() {
    let f = fixture();
    *f.help.borrow_mut() = "--tools".into();
    assert_eq!(f.run(None), Err(RoutineError::CliUnsupported));
    assert_eq!(f.credential_calls.get(), 0);
    assert_eq!(f.model(), None);
}

#[cfg(not(windows))]
#[test]
fn company_and_unknown_subscriptions_may_start_a_window_local_administrator_policy_still_refuses() {
    for subscription in ["team", "unknown"] {
        let mut f = fixture();
        f.account.auth.as_mut().unwrap().subscription = Some(subscription.into());
        f.run(None).unwrap();
        assert!(f.model().is_some());
    }
    let f = fixture();
    let file = f.store.root.join("fixture-policy.json");
    fs::write(&file, "{}").unwrap();
    *f.policy_paths.borrow_mut() = vec![file];
    assert_eq!(f.run(None), Err(RoutineError::PolicyUnverified));
    assert_eq!(f.commands.borrow().len(), 0);
    assert_eq!(f.credential_calls.get(), 0);
}

#[cfg(not(windows))]
#[test]
fn revoked_settings_before_or_during_credential_acquisition_never_send_a_prompt() {
    for phase in ["before", "during"] {
        let f = fixture();
        if phase == "before" {
            f.guard.set(false);
        }
        f.revoke_during_credentials.set(true);
        assert_eq!(f.run(None), Err(RoutineError::SettingsChanged));
        assert_eq!(f.model(), None);
    }
}

#[cfg(not(windows))]
#[test]
fn child_process_failures_never_expose_credential_or_cli_output_strings() {
    let f = fixture();
    *f.model_error.borrow_mut() =
        Some("fake credential fixture-only-token and private output".into());
    let error = f.run(None).unwrap_err();
    assert_eq!(error.to_string(), "routine-request-failed");
    assert!(!error.to_string().contains("fixture-only-token"));
}

#[test]
fn aborting_relay_owned_routine_startup_never_touches_other_process_ids() {
    let f = fixture();
    let signal = AtomicBool::new(true);
    assert_eq!(f.run(Some(&signal)), Err(RoutineError::SettingsChanged));
    assert_eq!(f.commands.borrow().len(), 0);
}

#[test]
fn isolated_starter_disables_every_tool_mcp_customization_and_persistence_without_resume_or_bypass()
{
    let args = quota_starter_args();
    let after = |flag: &str| {
        let i = args.iter().position(|a| a == flag).unwrap();
        args[i + 1].clone()
    };
    for flag in [
        "--safe-mode",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--disable-slash-commands",
    ] {
        assert!(args.iter().any(|a| a == flag));
    }
    assert_eq!(after("--tools"), "");
    assert_eq!(after("--disallowedTools"), "*");
    assert_eq!(after("--max-turns"), "1");
    for flag in [
        "--resume",
        "--continue",
        "--desktop",
        "--bare",
        "--dangerously-skip-permissions",
    ] {
        assert!(!args.iter().any(|a| a == flag));
    }
    let source: Env = [
        ("PATH", "/bin"),
        ("ANTHROPIC_API_KEY", "unexpected"),
        ("CLAUDE_CONFIG_DIR", "wrong"),
        ("OTEL_EXPORTER_OTLP_HEADERS", "secret"),
        ("DEBUG", "1"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect();
    let env = routine_environment("/fixture/profile", "fake-token", &source);
    assert_eq!(env.get("ANTHROPIC_API_KEY"), None);
    assert_eq!(
        env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
        Some("/fixture/profile")
    );
    assert_eq!(
        env.get("CLAUDE_CODE_OAUTH_TOKEN").map(String::as_str),
        Some("fake-token")
    );
    assert_eq!(env.get("OTEL_EXPORTER_OTLP_HEADERS"), None);
    assert_eq!(env.get("DEBUG"), None);
    let mut a = planning_account("a");
    assert!(window_start_eligible(&a));
    a.auth.as_mut().unwrap().subscription = Some("team".into());
    assert!(window_start_eligible(&a));
    a.auth.as_mut().unwrap().account_uuid = None;
    assert!(!window_start_eligible(&a));
}

#[cfg(not(windows))]
#[test]
fn claude_codes_empty_server_settings_cache_is_no_policy_any_setting_in_it_is() {
    let f = fixture();
    let file = f.profile.join("remote-settings.json");
    *f.policy_paths.borrow_mut() = vec![file.clone()];
    // Claude Code writes {} on every run for an organization without server settings.
    fs::write(&file, "{}").unwrap();
    f.run(None).unwrap();
    assert!(f.model().is_some());
    for content in [r#"{"permissions":{"deny":["Bash"]}}"#, "not json"] {
        let g = fixture();
        let other = g.profile.join("remote-settings.json");
        *g.policy_paths.borrow_mut() = vec![other.clone()];
        fs::write(&other, content).unwrap();
        assert_eq!(g.run(None), Err(RoutineError::PolicyUnverified));
        assert_eq!(g.credential_calls.get(), 0);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn a_policy_check_that_ends_without_an_answer_is_retried_later_never_read_as_a_policy() {
    let cases: [(Box<dyn Fn() -> Answer>, RoutineError); 3] = [
        (
            Box::new(|| Err(failure(None, "defaults", ""))),
            RoutineError::PolicyCheckFailed,
        ),
        (
            Box::new(|| Err(failure(Some(1), "defaults", "something else"))),
            RoutineError::PolicyUnverified,
        ),
        // The domain exists, so `defaults` prints it.
        (
            Box::new(|| output("{ x = 1; }")),
            RoutineError::PolicyUnverified,
        ),
    ];
    for (answer, reason) in cases {
        let f = fixture();
        *f.defaults.borrow_mut() = Some(answer);
        assert_eq!(f.run(None), Err(reason));
        assert_eq!(f.credential_calls.get(), 0);
    }
}
