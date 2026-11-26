//! Fixtures for the P4Fleet.FleetEvidence ports: transcripts, process censuses, the evidence
//! fixture of tests/desktop-continuation-evidence.test.ts and the fleet's `setup()` of
//! tests/fleet-continuation.test.ts.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use relay_core::continuation::SessionStatus;
use relay_core::desktop::{DesktopError, DesktopResult, DesktopSwitchOptions};
use relay_core::desktop_continuation::DesktopContinuationContext;
use relay_core::desktop_continuation_evidence::{
    DesktopEvidenceOptions, DesktopProcess, EvidenceDesktop, NativeDesktopContinuationEvidence,
    QuotaStop,
};
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationGuard, DesktopAutomationIssue, DesktopAutomationSnapshot,
    DesktopDraftGuard, DesktopHostError, DesktopSendResult, OpenSessionOptions, WriteDraftOptions,
};
use relay_core::fleet_continuation::{FleetDeps, FleetResult};
use relay_core::shared::types::js::{JsMap, date_parse, iso};
use relay_core::shared::types::{
    Account, AccountDesktop, AccountKind, AccountUsage, CreateAccount, DesktopState,
    default_settings,
};
use relay_core::store::{Store, StoreOptions};
use relay_core::transcript_scan::Row;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// `JSON.stringify(row) + "\n"`.
pub fn line(row: &Value) -> String {
    format!("{row}\n")
}

pub fn lines(rows: &[Value]) -> String {
    rows.iter().map(line).collect()
}

pub fn sha(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn row(value: Value) -> Row {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}

pub fn rows(values: &[Value]) -> Vec<Row> {
    values.iter().cloned().map(row).collect()
}

/// `{...base, ...extra}`.
pub fn spread(base: &Value, extra: Value) -> Value {
    let mut map = base.as_object().cloned().unwrap_or_default();
    for (key, value) in row(extra) {
        map.insert(key, value);
    }
    Value::Object(map)
}

/// `{...base}` without `key`.
pub fn without(base: &Value, key: &str) -> Value {
    let mut map = base.as_object().cloned().unwrap_or_default();
    map.shift_remove(key);
    Value::Object(map)
}

pub fn append(file: &Path, text: &str) {
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

pub fn issue_of<T: std::fmt::Debug>(result: Result<T, DesktopHostError>) -> String {
    result.expect_err("an error").to_string()
}

pub const UUID: &str = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
pub const USER_ID: &str = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
pub const ASSISTANT_ID: &str = "cccccccc-cccc-cccc-cccc-cccccccccccc";
pub const NEXT_ASSISTANT: &str = "dddddddd-dddd-dddd-dddd-dddddddddddd";
pub const ORG: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

pub fn app() -> DesktopProcess {
    DesktopProcess {
        pid: 456,
        ppid: 1,
        executable: "/Applications/Claude.app/Contents/MacOS/Claude".into(),
        args: "Claude".into(),
    }
}

pub fn source_engine() -> DesktopProcess {
    DesktopProcess {
        pid: 457,
        ppid: 456,
        executable: "/test/claude".into(),
        args: format!("claude --resume {UUID}"),
    }
}

pub fn process(pid: i64, ppid: i64, executable: &str, args: &str) -> DesktopProcess {
    DesktopProcess {
        pid,
        ppid,
        executable: executable.into(),
        args: args.into(),
    }
}

/// `JSON.stringify([app, ...extra])`.
pub fn roster(extra: &[DesktopProcess]) -> String {
    let mut all = vec![app()];
    all.extend(extra.iter().cloned());
    serde_json::to_string(&all).unwrap()
}

pub fn terminal() -> Value {
    json!({
        "type": "assistant",
        "uuid": ASSISTANT_ID,
        "timestamp": "2026-10-13T14:00:00.000Z",
        "error": "rate_limit",
        "message": { "content": "limited" },
    })
}

/// The Claude app as the evidence sees it: the signed-in account and its organizations.
pub struct FakeDesktop {
    pub active: Mutex<String>,
    pub organizations: Mutex<Vec<String>>,
    claude_root: PathBuf,
}

impl FakeDesktop {
    fn write_config(&self, active: &str) {
        fs::write(
            self.claude_root.join("config.json"),
            json!({ "lastKnownAccountUuid": active }).to_string(),
        )
        .unwrap();
    }
}

impl EvidenceDesktop for FakeDesktop {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        Ok(DesktopState {
            current_account_uuid: Some(lock(&self.active).clone()),
            organizations: lock(&self.organizations).clone(),
            recovery_required: false,
            pending_profile_id: None,
            ..DesktopState::default()
        })
    }
    fn switch_to(&self, profile_id: &str, options: DesktopSwitchOptions) -> DesktopResult<()> {
        if let Some(before_quit) = &options.before_quit {
            before_quit()?;
        }
        assert_eq!(options.can_proceed.as_ref().map(|c| c()), Some(true));
        *lock(&self.active) = profile_id.to_owned();
        self.write_config(profile_id);
        Ok(())
    }
}

/// `{} as DesktopManager`: never used.
pub struct NoDesktop;

impl EvidenceDesktop for NoDesktop {
    fn snapshot(&self) -> DesktopResult<DesktopState> {
        Err(DesktopError::new("not here"))
    }
    fn switch_to(&self, _: &str, _: DesktopSwitchOptions) -> DesktopResult<()> {
        Err(DesktopError::new("not here"))
    }
}

fn unsupported<T>() -> Result<T, DesktopHostError> {
    Err(DesktopAutomationIssue::DesktopUiUnsupported.into())
}

/// The UI automation of the fixture: it always shows `ui`.
pub struct FakeAutomation {
    pub ui: Arc<Mutex<DesktopAutomationSnapshot>>,
}

impl DesktopAutomation for FakeAutomation {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Ok(lock(&self.ui).clone())
    }
    fn open_session(&self, _: &str, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        Ok(())
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        Err(DesktopHostError::other(
            "openNewSession must not be called here",
        ))
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        mode: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        let mut ui = lock(&self.ui).clone();
        ui.permission_mode = Some(mode.to_owned());
        Ok(ui)
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        Ok(DesktopSendResult {
            accepted_visible: false,
            written: None,
            submitted: None,
            after: None,
        })
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        Ok(false)
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        _: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Err(DesktopHostError::other(
            "writeDraft must not be called here",
        ))
    }
}

/// `{} as DesktopAutomation`: never used.
pub struct NoAutomation;

impl DesktopAutomation for NoAutomation {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unsupported()
    }
    fn open_session(&self, _: &str, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        unsupported()
    }
    fn open_new_session(&self, _: Option<OpenSessionOptions>) -> Result<(), DesktopHostError> {
        unsupported()
    }
    fn set_permission(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unsupported()
    }
    fn send(
        &self,
        _: &DesktopAutomationGuard,
        _: &str,
        _: &str,
    ) -> Result<DesktopSendResult, DesktopHostError> {
        unsupported()
    }
    fn has_request_marker(&self, _: &str) -> Result<bool, DesktopHostError> {
        unsupported()
    }
    fn write_draft(
        &self,
        _: &DesktopDraftGuard,
        _: &str,
        _: Option<WriteDraftOptions>,
    ) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        unsupported()
    }
}

/// `fixture()` of tests/desktop-continuation-evidence.test.ts.
pub struct Fixture {
    pub root: TempDir,
    pub evidence: NativeDesktopContinuationEvidence,
    pub ui: Arc<Mutex<DesktopAutomationSnapshot>>,
    pub source: Account,
    pub target: Account,
    pub transcript_file: PathBuf,
    pub store: Arc<Store>,
    pub desktop: Arc<FakeDesktop>,
}

impl Fixture {
    pub fn path(&self) -> &Path {
        self.root.path()
    }
    pub fn ui(&self) -> DesktopAutomationSnapshot {
        lock(&self.ui).clone()
    }
    pub fn account(&self, id: &str) -> Account {
        self.store.account(id).unwrap()
    }
    pub fn metadata_file(&self, account_id: &str) -> PathBuf {
        self.path()
            .join("desktop")
            .join("claude-code-sessions")
            .join(account_id)
            .join(ORG)
            .join(format!("local_{UUID}.json"))
    }
    /// The required options of a second evidence reader on the same files; no Desktop or UI.
    pub fn options(&self) -> DesktopEvidenceOptions {
        DesktopEvidenceOptions::new(
            Arc::clone(&self.store),
            Arc::new(NoDesktop),
            Arc::new(NoAutomation),
            self.path().join("desktop"),
            self.path().join("transcripts"),
        )
    }
}

pub fn fixture() -> Fixture {
    let root = tempfile::Builder::new()
        .prefix("relay-evidence-test-")
        .tempdir()
        .unwrap();
    let store = Arc::new(Store::open(root.path().join("relay"), StoreOptions::default()).unwrap());
    let create = |name: &str| {
        store
            .create(&CreateAccount {
                name: name.into(),
                kind: AccountKind::Personal,
                group: None,
                provider: None,
            })
            .unwrap()
    };
    let (source, target) = (create("source"), create("target"));
    store
        .update(|s| {
            for account in &mut s.accounts {
                account.desktop = Some(AccountDesktop {
                    account_uuid: account.id.clone(),
                    org_id: ORG.into(),
                    saved_at: "2026-10-13T14:00:00.000Z".into(),
                    ..AccountDesktop::default()
                });
            }
        })
        .unwrap();
    let claude_root = root.path().join("desktop");
    let transcript_root = root.path().join("transcripts");
    let cwd = root.path().join("project");
    let transcript_file = transcript_root
        .join("projects")
        .join("-test")
        .join(format!("{UUID}.jsonl"));
    let metadata = json!({
        "cliSessionId": UUID,
        "cwd": cwd,
        "lastActivityAt": 1,
        "permissionMode": "auto",
    });
    for account in [&source, &target] {
        let file = claude_root
            .join("claude-code-sessions")
            .join(&account.id)
            .join(ORG)
            .join(format!("local_{UUID}.json"));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, metadata.to_string()).unwrap();
    }
    fs::create_dir_all(transcript_file.parent().unwrap()).unwrap();
    fs::write(
        &transcript_file,
        line(&spread(&terminal(), json!({ "cwd": cwd }))),
    )
    .unwrap();
    let desktop = Arc::new(FakeDesktop {
        active: Mutex::new(source.id.clone()),
        organizations: Mutex::new(vec![ORG.into()]),
        claude_root: claude_root.clone(),
    });
    desktop.write_config(&source.id);
    let ui: DesktopAutomationSnapshot = serde_json::from_value(json!({
        "observedAt": date_parse("2026-10-13T14:01:00.000Z") as i64,
        "pid": 456,
        "localSessionId": format!("local_{UUID}"),
        "accountLabel": "Test account",
        "permissionMode": "Auto",
        "status": SessionStatus::Stopped,
        "quotaStopped": true,
        "composerEmpty": true,
        "sendEnabled": true,
        "contextFingerprint": "a".repeat(64),
        "coverage": "active-conversation-only",
    }))
    .unwrap();
    let ui = Arc::new(Mutex::new(ui));
    let automation = Arc::new(FakeAutomation {
        ui: Arc::clone(&ui),
    });
    let clock = Arc::clone(&ui);
    let mut options = DesktopEvidenceOptions::new(
        Arc::clone(&store),
        Arc::clone(&desktop) as Arc<dyn EvidenceDesktop>,
        automation,
        claude_root,
        transcript_root,
    );
    options.processes = Some(Box::new(|| Ok(roster(&[]))));
    options.processes_sync = Some(Box::new(|| Ok(roster(&[]))));
    options.cpu_times = Some(Box::new(|| Ok("456 0:01.00\n".into())));
    options.now = Some(Box::new(move || lock(&clock).observed_at as f64));
    let evidence = NativeDesktopContinuationEvidence::new(options).unwrap();
    let source = store.account(&source.id).unwrap();
    let target = store.account(&target.id).unwrap();
    Fixture {
        root,
        evidence,
        ui,
        source,
        target,
        transcript_file,
        store,
        desktop,
    }
}

/// The fixture with its conversation active within the quota-stop window.
pub fn recent_fixture() -> Fixture {
    let f = fixture();
    let file = f.metadata_file(&f.source.id);
    let mut metadata: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    metadata["lastActivityAt"] = json!(date_parse("2026-10-13T14:00:00.000Z"));
    fs::write(&file, metadata.to_string()).unwrap();
    f
}

// ---- tests/fleet-continuation.test.ts ----

pub fn fleet_now() -> f64 {
    date_parse("2026-10-13T20:00:00.000Z")
}

pub fn random_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn fleet_account(name: &str, plan: &str) -> Account {
    let now = iso(fleet_now());
    serde_json::from_value(json!({
        "id": random_uuid(),
        "name": name,
        "kind": "personal",
        "group": "personal",
        "color": "blue",
        "createdAt": now,
        "planning": { "plan": plan, "capacityWeight": 1 },
        "desktop": { "accountUuid": random_uuid(), "orgId": random_uuid(), "savedAt": now },
        "auth": { "loggedIn": true, "checkedAt": now },
    }))
    .unwrap()
}

pub fn enroll(mut a: Account) -> Account {
    let desktop = a.desktop.clone().unwrap();
    let auth = a.auth.as_mut().unwrap();
    auth.account_uuid = Some(desktop.account_uuid);
    auth.org_id = Some(desktop.org_id);
    a
}

pub fn fleet_usage(a: &Account, five: f64) -> AccountUsage {
    serde_json::from_value(json!({
        "accountId": a.id,
        "status": "ready",
        "stale": false,
        "checkedAt": iso(fleet_now() - 60_000.0),
        "fiveHour": { "usedPercent": five, "resetsAt": iso(fleet_now() + 3_600_000.0) },
    }))
    .unwrap()
}

/// `{...usage(a, five), checkedAt}`.
pub fn usage_checked(a: &Account, five: f64, checked_at: f64) -> AccountUsage {
    AccountUsage {
        checked_at: Some(iso(checked_at)),
        ..fleet_usage(a, five)
    }
}

pub fn stop(index: u32) -> QuotaStop {
    let id = random_uuid();
    QuotaStop {
        local_session_id: format!("local_{}", random_uuid()),
        cli_session_id: id.clone(),
        project_key: "/project".into(),
        permission_mode: Some("Auto".into()),
        turn_id: random_uuid(),
        stopped_at: fleet_now() - f64::from(index) * 1000.0,
        transcript_relative: format!("projects/p/{id}.jsonl"),
        transcript_bytes: 10,
        transcript_sha256: "a".repeat(64),
        trigger: None,
    }
}

/// `state` of the fleet's `setup()`.
pub struct FleetState {
    pub active: String,
    pub stops: std::collections::HashMap<String, Vec<QuotaStop>>,
    pub usage: JsMap<AccountUsage>,
    pub busy: Option<String>,
    pub automation: Option<String>,
    pub switch_error: Option<String>,
    pub switches: Vec<String>,
    pub sent: Vec<String>,
    pub result: FleetResult,
    pub crash_before_result: bool,
}

pub struct FleetSetup {
    pub a: Account,
    pub b: Account,
    pub state: Arc<Mutex<FleetState>>,
    pub deps: FleetDeps,
    pub directory: TempDir,
}

impl FleetSetup {
    pub fn state(&self) -> MutexGuard<'_, FleetState> {
        lock(&self.state)
    }
    pub fn set_stops(&self, account: &Account, stops: Vec<QuotaStop>) {
        self.state().stops.insert(account.id.clone(), stops);
    }
    pub fn set_usage(&self, usage: AccountUsage) {
        let id = usage.account_id.clone();
        self.state().usage.insert(id, usage);
    }
    pub fn switches(&self) -> Vec<String> {
        self.state().switches.clone()
    }
    pub fn sent(&self) -> usize {
        self.state().sent.len()
    }
    /// `handled` of fleet-state.json.
    pub fn handled(&self) -> Vec<String> {
        let saved: Value = serde_json::from_slice(
            &fs::read(self.directory.path().join("fleet-state.json")).unwrap(),
        )
        .unwrap();
        serde_json::from_value(saved["handled"].clone()).unwrap()
    }
}

pub fn desktop_state(active: &str) -> DesktopState {
    DesktopState {
        available: true,
        running: true,
        organizations: Vec::new(),
        busy: false,
        recovery_required: false,
        error_revision: 0.0,
        active_profile_id: Some(active.to_owned()),
        ..DesktopState::default()
    }
}

pub const SWITCH_CANCELLED: &str = "Automatic Desktop switch was cancelled before restart.";

pub fn fleet_setup() -> FleetSetup {
    let directory = tempfile::Builder::new()
        .prefix("relay-fleet-")
        .tempdir()
        .unwrap();
    let a = enroll(fleet_account("A", "max5"));
    let b = enroll(fleet_account("B", "max5"));
    let mut usage = JsMap::new();
    usage.insert(a.id.clone(), fleet_usage(&a, 100.0));
    usage.insert(b.id.clone(), fleet_usage(&b, 10.0));
    let state = Arc::new(Mutex::new(FleetState {
        active: a.id.clone(),
        stops: [
            (a.id.clone(), vec![stop(0), stop(1)]),
            (b.id.clone(), vec![]),
        ]
        .into_iter()
        .collect(),
        usage,
        busy: None,
        automation: None,
        switch_error: None,
        switches: Vec::new(),
        sent: Vec::new(),
        result: FleetResult::Started,
        crash_before_result: false,
    }));
    let accounts = vec![a.clone(), b.clone()];
    let s = |state: &Arc<Mutex<FleetState>>| Arc::clone(state);
    let deps = FleetDeps {
        directory: directory.path().to_path_buf(),
        now: Some(Arc::new(fleet_now)),
        snapshot: {
            let state = s(&state);
            Arc::new(move || DesktopContinuationContext {
                accounts: accounts.clone(),
                settings: default_settings(),
                usage: lock(&state).usage.clone(),
                tempo_rate: None,
            })
        },
        desktop: {
            let state = s(&state);
            Arc::new(move || Ok(desktop_state(&lock(&state).active)))
        },
        busy: Arc::new(|| false),
        refresh_usage: None,
        stops: {
            let state = s(&state);
            Arc::new(move |account| {
                Ok(lock(&state)
                    .stops
                    .get(&account.id)
                    .cloned()
                    .unwrap_or_default())
            })
        },
        quiet: {
            let state = s(&state);
            Arc::new(move |_| Ok(lock(&state).busy.clone()))
        },
        quiet_sync: {
            let state = s(&state);
            Arc::new(move |_| lock(&state).busy.clone())
        },
        unchanged: Arc::new(|_| true),
        automation_ready: {
            let state = s(&state);
            Arc::new(move || Ok(lock(&state).automation.clone()))
        },
        switch_to: {
            let state = s(&state);
            Arc::new(move |target_id, guards| {
                // As DesktopManager.restart: every guard runs before Claude is asked to quit.
                let refused = || relay_core::desktop::desktop_switch_refused(SWITCH_CANCELLED);
                let can_proceed = guards.can_proceed.clone().unwrap();
                if !can_proceed() {
                    return Err(refused());
                }
                (guards.before_quit.clone().unwrap())()?;
                if !can_proceed() {
                    return Err(refused());
                }
                let mut state = lock(&state);
                if let Some(error) = state.switch_error.clone() {
                    return Err(DesktopError::new(error));
                }
                state.switches.push(target_id.to_owned());
                // History merge carries the stopped conversations to the target.
                state.active = target_id.to_owned();
                Ok(())
            })
        },
        continue_one: {
            let state = s(&state);
            Arc::new(move |stop, target, request_id, before_send| {
                assert_eq!(target.id, lock(&state).active);
                before_send()?;
                if lock(&state).crash_before_result {
                    return Err("relay stopped".into());
                }
                let mut state = lock(&state);
                state
                    .sent
                    .push(format!("{}:{request_id}", stop.local_session_id));
                // A continued conversation no longer ends with the quota error.
                Ok(state.result)
            })
        },
        with_desktop_lock: Arc::new(|action| action()),
        changed: Arc::new(|| {}),
        log: None,
        quiet_detail: None,
        finished: None,
        background_commands: None,
        stop_background: None,
        answer_quit_guard: None,
    };
    FleetSetup {
        a,
        b,
        state,
        deps,
        directory,
    }
}

/// A shared clock tests move forward.
#[derive(Clone)]
pub struct Clock(pub Arc<Mutex<f64>>);

impl Clock {
    pub fn new(at: f64) -> Clock {
        Clock(Arc::new(Mutex::new(at)))
    }
    pub fn get(&self) -> f64 {
        *lock(&self.0)
    }
    pub fn add(&self, ms: f64) {
        *lock(&self.0) += ms;
    }
    pub fn now(&self) -> relay_core::fleet_continuation::FleetClock {
        let clock = self.clone();
        Arc::new(move || clock.get())
    }
}

/// A list a closure appends to.
#[derive(Clone, Default)]
pub struct Recorder<T>(pub Arc<Mutex<VecDeque<T>>>);

impl<T: Clone> Recorder<T> {
    pub fn push(&self, item: T) {
        lock(&self.0).push_back(item);
    }
    pub fn all(&self) -> Vec<T> {
        lock(&self.0).iter().cloned().collect()
    }
    pub fn len(&self) -> usize {
        lock(&self.0).len()
    }
}
