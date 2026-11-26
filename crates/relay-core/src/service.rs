//! The app's account service: the registry, terminals, usage sign-ins (the account's and the
//! terminal's), the session catalog and the CLI diagnosis.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, LazyLock, Mutex, RwLock, Weak};
use std::thread;

use serde_json::Value;

use crate::account_removal::{AccountRemoval, AccountRemovalError, DesktopFacts, remove_account};
use crate::auth::{AuthError, AuthManager, BackgroundSignIn, OpenUrl, Verdict, auth_pending};
use crate::cli_diagnostics::diagnose_cli;
use crate::clock::now_ms;
use crate::desktop_files::is_uuid;
use crate::environment::{Env, command, process_env, profile_environment};
use crate::fs_util::{iso_timestamp, parse_iso_ms};
use crate::profile_auth::{read_profile_auth, signed_out};
use crate::profile_identity::read_profile_identity;
use crate::profile_lock::{ProfileLockError, ProfileLockGuard, ProfileLockKind};
use crate::relay_paths::{Platform, home_dir};
use crate::runner::{EmitTerminal, RunInput, Runner, RunnerError};
use crate::sessions::{
    IndexedSession, SessionError, copy_transcript, read_transcript, scan_sessions,
};
use crate::shared::cli_version::reads_usage;
use crate::shared::types::js::JsMap;
use crate::shared::types::{
    Account, AccountPlanning, AccountProvider, AccountRemoved, AuthFlow, AuthFlowStatus,
    Diagnostics, LaunchRequest, Run, RunKind, RunStatus, Snapshot, TranscriptMessage,
};
use crate::store::schema::{Schema, StringRule, boolean, strict, string, uuid};
use crate::store::{Store, StoreError, StoreOptions, parse_as};

static LAUNCH_SCHEMA: LazyLock<Schema> = LazyLock::new(|| {
    let max = |max| {
        string(StringRule {
            max: Some(max),
            ..Default::default()
        })
    };
    strict(vec![
        ("accountId", uuid()),
        ("cwd", max(4096).optional()),
        ("sessionKey", max(100).optional()),
        ("importConsent", boolean().optional()),
        ("desktop", boolean().optional()),
        ("desktopConsent", boolean().optional()),
    ])
});

/// `launchSchema.parse`: a launch request from the window.
pub fn parse_launch(raw: &Value) -> Result<LaunchRequest, StoreError> {
    Ok(parse_as(&LAUNCH_SCHEMA, raw)?)
}

fn has_verified_stored_identity(account: &Account) -> bool {
    let Some(auth) = &account.auth else {
        return false;
    };
    let (Some(account_uuid), Some(org_id)) = (&auth.account_uuid, &auth.org_id) else {
        return false;
    };
    if !auth.logged_in || auth.error.is_some() || !is_uuid(account_uuid) || !is_uuid(org_id) {
        return false;
    }
    account.desktop.as_ref().is_none_or(|desktop| {
        account_uuid.to_lowercase() == desktop.account_uuid.to_lowercase()
            && org_id.to_lowercase() == desktop.org_id.to_lowercase()
    })
}

/// A diagnosis that found a CLI recent enough to read limits; Relay keeps it for the process.
fn usable_diagnostics(d: &Diagnostics) -> bool {
    d.executable.is_some() && d.error.is_none() && d.version.as_deref().is_some_and(reads_usage)
}

fn is_claude(account: &Account) -> bool {
    account.provider.unwrap_or(AccountProvider::Claude) == AccountProvider::Claude
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Runner(#[from] RunnerError),
    #[error(transparent)]
    Session(#[from] SessionError),
    #[error(transparent)]
    Removal(#[from] AccountRemovalError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

fn fail<T>(message: &str) -> Result<T, ServiceError> {
    Err(ServiceError::Message(message.to_owned()))
}

/// Takes an account's profile lock, shared with Relay's other processes.
pub type ServiceProfileLock =
    dyn Fn(&str, ProfileLockKind) -> Result<ProfileLockGuard, ProfileLockError> + Send + Sync;
pub type EmitAuth = dyn Fn(AuthFlow) + Send + Sync;
/// Whether a usage sign-in that just finished belongs to the profile's Claude app sign-in:
/// the reason it does not, or `None`.
pub type SignInFit = dyn Fn(&Account) -> Option<String> + Send + Sync;
/// Keeps the sign-in a finished terminal link left in `dir` for the account: `Ok`, or why it
/// was not kept.
pub type TerminalLinkFit = dyn Fn(&str, &Path) -> Result<(), String> + Send + Sync;

pub struct ServiceOptions {
    pub root: PathBuf,
    pub emit: Box<EmitTerminal>,
    /// The default Claude Code folder sessions are imported from (`~/.claude`).
    pub imported_root: Option<PathBuf>,
    pub emit_auth: Option<Arc<EmitAuth>>,
    pub open_browser: Option<Arc<OpenUrl>>,
    pub profile_lock: Option<Arc<ServiceProfileLock>>,
    pub store_options: StoreOptions,
}

impl ServiceOptions {
    /// A service on `root` that tells nobody anything: what tests and the CLI start from.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            emit: Box::new(|_| {}),
            imported_root: None,
            emit_auth: None,
            open_browser: None,
            profile_lock: None,
            store_options: StoreOptions::default(),
        }
    }
}

/// One in-flight auth check, shared by everyone who asks meanwhile.
#[derive(Default)]
struct Flight {
    result: Mutex<Option<Result<Account, String>>>,
    done: Condvar,
}

impl Flight {
    fn wait(&self) -> Result<Account, String> {
        let guard = self.result.lock().unwrap_or_else(|e| e.into_inner());
        let guard = self
            .done
            .wait_while(guard, |r| r.is_none())
            .unwrap_or_else(|e| e.into_inner());
        guard.clone().expect("finished")
    }
}

struct DiagnosisCache {
    diagnostics: Option<Diagnostics>,
    at: i64,
}

pub struct Service {
    pub store: Arc<Store>,
    pub runner: Runner,
    pub auth: AuthManager,
    /// Sign-ins made for the terminal: `claude auth login` in a scratch folder per account, so
    /// the sign-in the terminal holds is not touched. Relay keeps the result for the next switch.
    pub terminal_auth: AuthManager,
    pub imported_root: PathBuf,
    sign_in_fit: RwLock<Option<Arc<SignInFit>>>,
    terminal_link_fit: RwLock<Option<Arc<TerminalLinkFit>>>,
    index: Mutex<HashMap<String, IndexedSession>>,
    diagnosis: Mutex<DiagnosisCache>,
    now: RwLock<Box<dyn Fn() -> i64 + Send + Sync>>,
    pending: Mutex<()>,
    auth_checks: Mutex<HashMap<String, Arc<Flight>>>,
}

/// Where a removal looks and what it asks Desktop (`AccountRemoval` without store and sign-out).
pub struct ServiceRemoval<'a> {
    pub vault: &'a Path,
    pub locks: &'a Path,
    pub desktop: &'a dyn Fn() -> Result<DesktopFacts, String>,
}

impl Service {
    /// How long an unusable diagnosis stands before a snapshot runs it again.
    pub const REDIAGNOSE_MS: i64 = 20_000;

    pub fn new(options: ServiceOptions) -> Result<Arc<Self>, StoreError> {
        // Shared: the app's managers (Desktop, usage, auto-switch) hold the same store.
        let store = Arc::new(Store::open(options.root, options.store_options)?);
        let emit_auth: Arc<EmitAuth> = options.emit_auth.unwrap_or_else(|| Arc::new(|_| {}));
        let open: Arc<OpenUrl> = options.open_browser.unwrap_or_else(|| Arc::new(|_| Ok(())));
        let lock = options.profile_lock;
        let runner = Runner::new(
            options.emit,
            lock.clone()
                .map(|lock| Box::new(move |id: &str| lock(id, ProfileLockKind::Shared)) as Box<_>),
        );
        Ok(Arc::new_cyclic(|this: &Weak<Service>| {
            let auth = AuthManager::new(
                Box::new({
                    let this = this.clone();
                    move |id| {
                        let Some(service) = this.upgrade() else {
                            return Err("Relay is closing.".into());
                        };
                        service.verify_sign_in(id)
                    }
                }),
                Box::new({
                    let emit = emit_auth.clone();
                    move |flow| emit(flow)
                }),
                Box::new({
                    let open = open.clone();
                    move |url| open(url)
                }),
                None,
                lock.map(|lock| {
                    Box::new(move |id: &str| lock(id, ProfileLockKind::Exclusive)) as Box<_>
                }),
            );
            let terminal_auth = AuthManager::new(
                Box::new({
                    let this = this.clone();
                    move |id| {
                        let Some(service) = this.upgrade() else {
                            return Err("Relay is closing.".into());
                        };
                        Ok(service.verify_terminal_link(id))
                    }
                }),
                Box::new(move |flow| emit_auth(flow)),
                Box::new(move |url| open(url)),
                None,
                None,
            );
            Service {
                store,
                runner,
                auth,
                terminal_auth,
                imported_root: options
                    .imported_root
                    .unwrap_or_else(|| home_dir().join(".claude")),
                sign_in_fit: RwLock::new(None),
                terminal_link_fit: RwLock::new(None),
                index: Mutex::new(HashMap::new()),
                diagnosis: Mutex::new(DiagnosisCache {
                    diagnostics: None,
                    at: 0,
                }),
                now: RwLock::new(Box::new(now_ms)),
                pending: Mutex::new(()),
                auth_checks: Mutex::new(HashMap::new()),
            }
        }))
    }

    /// Set by the app: whether a finished usage sign-in fits the profile's Claude app sign-in.
    pub fn set_sign_in_fit(&self, fit: Option<Arc<SignInFit>>) {
        *self.sign_in_fit.write().unwrap_or_else(|e| e.into_inner()) = fit;
    }

    /// Set by the app: keeps the sign-in a finished terminal link left in its folder.
    pub fn set_terminal_link_fit(&self, fit: Option<Arc<TerminalLinkFit>>) {
        *self
            .terminal_link_fit
            .write()
            .unwrap_or_else(|e| e.into_inner()) = fit;
    }

    /// The clock of the rediagnosis throttle; tests replace it.
    pub fn set_now(&self, now: Box<dyn Fn() -> i64 + Send + Sync>) {
        *self.now.write().unwrap_or_else(|e| e.into_inner()) = now;
    }

    fn now(&self) -> i64 {
        (self.now.read().unwrap_or_else(|e| e.into_inner()))()
    }

    fn verify_sign_in(&self, id: &str) -> Result<Verdict, String> {
        // A startup/status request started before login must not decide its result.
        let running = self
            .auth_checks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned();
        if let Some(running) = running {
            let _ = running.wait();
        }
        let account = self.check_auth(id).map_err(|e| e.to_string())?;
        if !account.auth.as_ref().is_some_and(|a| a.logged_in) {
            return Ok(Verdict::No);
        }
        let fit = self
            .sign_in_fit
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        Ok(match fit.and_then(|fit| fit(&account)) {
            Some(reason) => Verdict::Reason(reason),
            None => Verdict::Yes,
        })
    }

    fn verify_terminal_link(&self, id: &str) -> Verdict {
        let dir = self.terminal_link_dir(id);
        let fit = self
            .terminal_link_fit
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let verdict = match fit {
            None => Verdict::Reason("Terminal sign-ins cannot be kept on this system.".into()),
            Some(fit) => match fit(id, &dir) {
                Ok(()) => Verdict::Yes,
                Err(reason) => Verdict::Reason(reason),
            },
        };
        let _ = fs::remove_dir_all(&dir);
        verdict
    }

    /// The scratch folder of an account's terminal link.
    pub fn terminal_link_dir(&self, id: &str) -> PathBuf {
        self.store.root().join("terminal-link").join(id)
    }

    /// Starts a sign-in for the terminal with the account: the page opens in the browser, and the
    /// approval there is all it needs. Asked again while its page waits, the page comes back.
    pub fn link_terminal(&self, id: &str) -> Result<AuthFlow, ServiceError> {
        let account = self.store.account(id)?;
        if !is_claude(&account) {
            return fail(
                "This account is not a Claude account; it connects through its own provider.",
            );
        }
        let identified = account
            .auth
            .as_ref()
            .is_some_and(|a| a.account_uuid.is_some() && a.org_id.is_some());
        if account.desktop.is_none() && !identified {
            return fail("Save the Claude app sign-in first.");
        }
        let flows = self.terminal_auth.list();
        if let Some(waiting) = flows
            .iter()
            .find(|f| f.account_id == id && f.status == AuthFlowStatus::Waiting && f.browser_ready)
        {
            let _ = self.terminal_auth.reopen(id, &waiting.id, false);
            return Ok(waiting.clone());
        }
        if self.terminal_auth.active(id)
            && let Some(flow) = flows.into_iter().find(|f| f.account_id == id)
        {
            return Ok(flow);
        }
        let dir = self.terminal_link_dir(id);
        let _ = fs::remove_dir_all(&dir);
        crate::fs_util::create_private_dir_all(&dir)?;
        let executable = self.executable()?;
        let env = profile_environment(&dir.to_string_lossy(), &process_env());
        Ok(self
            .terminal_auth
            .start(id, &executable, &dir, &env, None)?)
    }

    /// Runs `f` alone: operations whose checks and writes must be a single transaction.
    pub fn transaction<T>(&self, f: impl FnOnce() -> T) -> T {
        let _turn = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        f()
    }

    /// The cached diagnosis. While it is unusable (no CLI, an error, or a CLI too old to read
    /// limits) it runs again, at most once per `REDIAGNOSE_MS`, so a CLI installed or updated
    /// after Relay started is noticed without a restart.
    fn current_diagnostics(&self) -> Diagnostics {
        {
            let cache = self.diagnosis.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached) = &cache.diagnostics
                && (usable_diagnostics(cached) || self.now() - cache.at < Self::REDIAGNOSE_MS)
            {
                return cached.clone();
            }
        }
        self.diagnose()
    }

    pub fn diagnose(&self) -> Diagnostics {
        let at = self.now();
        let explicit = self.store.with_state(|s| s.executable.clone());
        let diagnostics = diagnose_cli(explicit.as_deref(), self.store.root());
        let mut cache = self.diagnosis.lock().unwrap_or_else(|e| e.into_inner());
        cache.at = at;
        cache.diagnostics = Some(diagnostics.clone());
        diagnostics
    }

    fn base_snapshot(&self, diagnostics: Diagnostics) -> Snapshot {
        let state = self.store.state();
        Snapshot {
            settings: state.settings,
            auto_switch: None,
            continuation: None,
            fleet: None,
            planning: None,
            drafts: None,
            sidebar: None,
            extension: None,
            windows: None,
            update: None,
            shortcuts: None,
            antigravity: None,
            meters: None,
            usage: JsMap::new(),
            auth_flows: self
                .auth
                .list()
                .into_iter()
                .filter(|f| f.background != Some(true))
                .collect(),
            terminal_flows: Some(self.terminal_auth.list()),
            accounts: state.accounts,
            sessions: Vec::new(),
            runs: self.runner.list(),
            diagnostics,
            import_enabled: state.import_enabled,
            warnings: Vec::new(),
        }
    }

    /// The panel's snapshot: no session scan.
    pub fn panel_snapshot(&self) -> Snapshot {
        let diagnostics = self.current_diagnostics();
        self.base_snapshot(diagnostics)
    }

    pub fn snapshot(&self) -> Snapshot {
        let diagnostics = self.current_diagnostics();
        let state = self.store.state();
        let mut sources: Vec<(PathBuf, String)> = state
            .accounts
            .iter()
            .map(|a| (self.store.root().join("profiles").join(&a.id), a.id.clone()))
            .collect();
        if state.import_enabled {
            sources.push((self.imported_root.clone(), "imported".into()));
        }
        let found: Vec<_> = thread::scope(|scope| {
            let scans: Vec<_> = sources
                .iter()
                .map(|(root, id)| {
                    let (pinned, lineage) = (&state.pinned, &state.lineage);
                    scope.spawn(move || scan_sessions(root, id, pinned, lineage))
                })
                .collect();
            scans
                .into_iter()
                .map(|s| s.join().unwrap_or_default())
                .collect()
        });
        let mut index = HashMap::new();
        let mut ordered: Vec<IndexedSession> = Vec::new();
        for session in found.iter().flat_map(|f| f.sessions.iter()) {
            if index.insert(session.key.clone(), session.clone()).is_none() {
                ordered.push(session.clone());
            } else if let Some(slot) = ordered.iter_mut().find(|s| s.key == session.key) {
                *slot = session.clone();
            }
        }
        *self.index.lock().unwrap_or_else(|e| e.into_inner()) = index;
        ordered.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        let mut warnings: Vec<String> = Vec::new();
        for warning in found.iter().flat_map(|f| f.warnings.iter()) {
            if !warnings.contains(warning) {
                warnings.push(warning.clone());
            }
        }
        let mut snapshot = self.base_snapshot(diagnostics);
        snapshot.sessions = ordered.into_iter().map(|s| s.session).collect();
        snapshot.warnings = warnings;
        snapshot
    }

    /// Reads the account's Claude Code sign-in; calls made while one runs share its answer.
    pub fn check_auth(&self, id: &str) -> Result<Account, ServiceError> {
        let (flight, owner) = {
            let mut checks = self.auth_checks.lock().unwrap_or_else(|e| e.into_inner());
            match checks.get(id) {
                Some(flight) => (flight.clone(), false),
                None => {
                    let flight = Arc::new(Flight::default());
                    checks.insert(id.to_owned(), flight.clone());
                    (flight, true)
                }
            }
        };
        if !owner {
            return flight.wait().map_err(ServiceError::Message);
        }
        let result = self.read_auth(id);
        self.auth_checks
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        *flight.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(
            result
                .as_ref()
                .map(Clone::clone)
                .map_err(ToString::to_string),
        );
        flight.done.notify_all();
        result
    }

    fn read_auth(&self, id: &str) -> Result<Account, ServiceError> {
        let account = self.store.account(id)?;
        // Only a Claude profile has a Claude Code sign-in to ask about; another provider's
        // sign-in is set when it is connected, and the Claude CLI would only call it signed out.
        if !is_claude(&account) {
            return Ok(account);
        }
        let auth = match self.executable() {
            Ok(executable) => read_profile_auth(
                &executable,
                &self.store.profile(id)?,
                account.auth.as_ref(),
                None,
            ),
            Err(_) => signed_out(account.auth.as_ref(), &iso_timestamp(now_ms())),
        };
        self.store.update(|s| {
            let Some(stored) = s.accounts.iter_mut().find(|a| a.id == id) else {
                return;
            };
            // The plan comes from the sign-in, not a choice: a read plan replaces the saved one
            // and keeps the relative capacity set for a Team seat.
            if auth.logged_in
                && let Some(plan) = auth.plan
                && stored.planning.as_ref().map(|p| p.plan) != Some(plan)
            {
                stored.planning = Some(AccountPlanning {
                    plan,
                    capacity_weight: stored.planning.as_ref().map_or(1.0, |p| p.capacity_weight),
                });
            }
            stored.auth = Some(auth);
        })?;
        Ok(self.store.account(id)?)
    }

    fn profile_env(&self, id: &str) -> Result<(PathBuf, Env), ServiceError> {
        let profile = self.store.profile(id)?;
        let env = profile_environment(&profile.to_string_lossy(), &process_env());
        Ok((profile, env))
    }

    pub fn login(&self, id: &str) -> Result<AuthFlow, ServiceError> {
        // The Claude Code sign-in is a Claude account's: a Codex or Antigravity account signs in
        // with its own provider, never through Claude's.
        if !is_claude(&self.store.account(id)?) {
            return fail(
                "This account is not a Claude account; it connects through its own provider.",
            );
        }
        if self.running_on(id) {
            return fail("Stop the running session for this account first.");
        }
        // Resolved before anything is looked at: nothing may change between the checks and the start.
        let executable = self.executable()?;
        // A renewal Relay runs by itself in the background gives way to the user's own sign-in.
        self.cancel_background_sign_in(id);
        // Asked again while its page waits for approval: the page comes back, where the user
        // last had it. Starting returns the same attempt, which alone shows nothing new.
        if let Some(waiting) =
            self.auth.list().into_iter().find(|f| {
                f.account_id == id && f.status == AuthFlowStatus::Waiting && f.browser_ready
            })
        {
            let _ = self
                .auth
                .reopen(id, &waiting.id, waiting.in_window == Some(true));
            return Ok(waiting);
        }
        let (profile, env) = self.profile_env(id)?;
        Ok(self.auth.start(id, &executable, &profile, &env, None)?)
    }

    fn running_on(&self, id: &str) -> bool {
        self.runner
            .list()
            .iter()
            .any(|r| r.account_id == id && r.status == RunStatus::Running)
    }

    /// Stops a renewal Relay runs by itself on this account, if one runs: the user's action wins.
    fn cancel_background_sign_in(&self, id: &str) {
        if let Some(quiet) = self
            .auth
            .list()
            .into_iter()
            .find(|f| f.account_id == id && f.background == Some(true) && auth_pending(Some(f)))
        {
            let _ = self.auth.cancel(id, &quiet.id);
        }
    }

    /// Starts a Claude Code sign-in Relay runs by itself: the CLI's page goes to `background`, a
    /// hidden window holding the account's claude.ai session, never to the user's browser.
    /// Refused while the account is in use or already signing in.
    pub fn login_in_background(
        &self,
        id: &str,
        background: BackgroundSignIn,
    ) -> Result<AuthFlow, ServiceError> {
        let account = self.store.account(id)?;
        if !is_claude(&account) || !account.auth.as_ref().is_some_and(|a| a.logged_in) {
            return fail("not a signed-in Claude account");
        }
        // Resolved first: the checks below and the start run with no wait between them, so a
        // sign-in the user starts meanwhile is seen (and `start` refuses to hand back another's flow).
        let executable = self.executable()?;
        if self.auth.active(id) {
            return Err(AuthError::Busy("a sign-in is already running".into()).into());
        }
        if self.running_on(id) {
            return Err(AuthError::Busy("a session runs on this account".into()).into());
        }
        let (profile, env) = self.profile_env(id)?;
        Ok(self
            .auth
            .start(id, &executable, &profile, &env, Some(background))?)
    }

    /// Fills each signed-in Claude account's plan from the sign-in metadata Claude Code saved in
    /// its profile. Only that file is read (no CLI, no Keychain), and only for the sign-in it matches.
    pub fn sync_detected_plans(&self) -> Result<(), ServiceError> {
        for account in self.store.state().accounts {
            let Some(auth) = account
                .auth
                .as_ref()
                .filter(|a| is_claude(&account) && a.logged_in)
            else {
                continue;
            };
            let Some(metadata) =
                read_profile_identity(&self.store.root().join("profiles").join(&account.id))
            else {
                continue;
            };
            let (Some(plan), Some(email), Some(org_id)) =
                (metadata.plan, &auth.email, &auth.org_id)
            else {
                continue;
            };
            if metadata.email.to_lowercase() != email.to_lowercase() || &metadata.org_id != org_id {
                continue;
            }
            self.store.update(|state| {
                let Some(stored) = state.accounts.iter_mut().find(|a| a.id == account.id) else {
                    return;
                };
                let Some(stored_auth) = stored.auth.as_mut() else {
                    return;
                };
                if !stored_auth.logged_in
                    || stored_auth.email.as_ref() != Some(email)
                    || stored_auth.org_id.as_ref() != Some(org_id)
                {
                    return;
                }
                stored_auth.plan = Some(plan);
                if stored.planning.as_ref().map(|p| p.plan) != Some(plan) {
                    stored.planning = Some(AccountPlanning {
                        plan,
                        capacity_weight: stored
                            .planning
                            .as_ref()
                            .map_or(1.0, |p| p.capacity_weight),
                    });
                }
            })?;
        }
        Ok(())
    }

    pub fn reconcile_auth(&self, platform: Platform) {
        let _ = self.sync_detected_plans();
        // Official CLI status can prompt for legacy Keychain access and initialize an OAuth
        // rotation. Startup is never an interactive authentication action.
        if platform == Platform::MacOs {
            return;
        }
        let ids: VecDeque<String> = self
            .store
            .state()
            .accounts
            .iter()
            .filter(|a| is_claude(a))
            .map(|a| a.id.clone())
            .collect();
        let workers = ids.len().min(3);
        let ids = Mutex::new(ids);
        thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    loop {
                        let Some(id) = ids.lock().unwrap_or_else(|e| e.into_inner()).pop_front()
                        else {
                            break;
                        };
                        // CLI status may rotate OAuth credentials before exiting. Keep an
                        // enrolled identity across restarts instead of launching that command
                        // just to rediscover it. This is not live quota verification: usage
                        // checks independently corroborate the current profile and account.
                        if !self.auth.active(&id)
                            && self
                                .store
                                .account(&id)
                                .is_ok_and(|a| !has_verified_stored_identity(&a))
                        {
                            let _ = self.check_auth(&id);
                        }
                    }
                });
            }
        });
    }

    pub fn launch(&self, raw: &Value) -> Result<Run, ServiceError> {
        let input = parse_launch(raw)?;
        let account = self.store.account(&input.account_id)?;
        // A renewal the user cannot see never blocks what they do.
        self.cancel_background_sign_in(&account.id);
        if self.auth.active(&account.id) {
            return fail("Finish or cancel this account’s usage sign-in first.");
        }
        if on_hold(&account) {
            return fail(
                "This account is on hold. Remove the hold on Accounts, or select another account.",
            );
        }
        let source = match &input.session_key {
            Some(key) => Some(self.session(key)?),
            None => None,
        };
        let cwd = source
            .as_ref()
            .map(|s| s.project_dir.clone())
            .or(input.cwd.clone());
        let Some(cwd) = cwd.filter(|c| Path::new(c).is_absolute()) else {
            return fail("Relay cannot find the project folder. Select it again.");
        };
        if !fs::metadata(&cwd)?.is_dir() {
            return fail("Relay cannot find the project folder. Select it again.");
        }
        let actual_cwd = fs::canonicalize(&cwd)?.to_string_lossy().into_owned();
        if self
            .runner
            .list()
            .iter()
            .any(|r| r.status == RunStatus::Running && r.cwd == actual_cwd)
        {
            return fail("Stop this project’s running session on the Live tab first.");
        }
        let desktop = input.desktop == Some(true);
        if desktop && input.desktop_consent != Some(true) {
            return fail("Check that the right account is open in the Claude app.");
        }
        if desktop && !self.current_diagnostics().desktop_supported {
            return fail(
                "Sending to the Claude app is not supported on this platform or CLI version.",
            );
        }
        if desktop
            && let Some(source) = &source
            && source.account_id != account.id
            && source.account_id != "imported"
        {
            return fail(
                "Continue with the chosen account in Relay first, then send that session to the Claude app.",
            );
        }
        let checked = self.check_auth(&account.id)?;
        if !checked.auth.as_ref().is_some_and(|a| a.logged_in) {
            let error = checked.auth.and_then(|a| a.error).filter(|e| !e.is_empty());
            return Err(ServiceError::Message(
                error.unwrap_or_else(|| "Sign in with this account first.".into()),
            ));
        }
        let mut args: Vec<String> = Vec::new();
        let session_key;
        if let Some(source) = &source {
            let mut resume_id = source.id.clone();
            if source.account_id != account.id {
                if source.account_id == "imported" {
                    if input.import_consent != Some(true) {
                        return fail("An imported session needs the target account confirmed.");
                    }
                } else if self.store.account(&source.account_id)?.group != account.group {
                    return fail(
                        "These accounts are not in the same sharing group. Work sessions can move only to accounts in the same group.",
                    );
                }
                resume_id = copy_transcript(source, &self.store.profile(&account.id)?)?;
                let copied_key = format!("{}:{resume_id}", account.id);
                let from = source.key.clone();
                self.store.update(|s| {
                    s.lineage.insert(copied_key.clone(), from);
                })?;
                // Fresh branch per handoff, preserving both accounts' previous history.
                session_key = copied_key;
            } else {
                session_key = source.key.clone();
            }
            args.extend(["--resume".into(), resume_id]);
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            session_key = format!("{}:{id}", account.id);
            if !desktop {
                args.extend(["--session-id".into(), id]);
            }
        }
        if desktop {
            args.insert(0, "--desktop".into());
        }
        let executable = self.executable()?;
        let (_, env) = self.profile_env(&account.id)?;
        let title = source.as_ref().map(|s| s.title.clone()).unwrap_or_else(|| {
            Path::new(&actual_cwd)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
        Ok(self.runner.start(
            &executable,
            &args,
            &env,
            RunInput {
                account_id: account.id.clone(),
                title,
                cwd: actual_cwd,
                kind: if desktop {
                    RunKind::Desktop
                } else {
                    RunKind::Session
                },
                session_key: Some(session_key),
            },
        )?)
    }

    pub fn transcript(&self, key: &str) -> Result<Vec<TranscriptMessage>, ServiceError> {
        Ok(read_transcript(&self.session(key)?)?)
    }

    pub fn switch_account(&self, run_id: &str, target_id: &str) -> Result<Run, ServiceError> {
        let run = self.runner.list().into_iter().find(|r| r.id == run_id);
        let Some((run, session_key)) = run
            .filter(|r| r.kind == RunKind::Session)
            .and_then(|r| r.session_key.clone().map(|key| (r, key)))
        else {
            return fail("Only work sessions can change accounts.");
        };
        if run.account_id == target_id {
            return fail("Oturum zaten bu hesapta.");
        }
        let target = self.store.account(target_id)?;
        if self.store.account(&run.account_id)?.group != target.group {
            return fail("The accounts must be in the same sharing group.");
        }
        if on_hold(&target) {
            return fail("The target account is on hold. Remove the hold first.");
        }
        if !self
            .check_auth(target_id)?
            .auth
            .is_some_and(|a| a.logged_in)
        {
            return fail("Sign in to the target account. The current work was not stopped.");
        }
        self.snapshot();
        self.session(&session_key)?; // Do not stop an unsaved/new terminal.
        self.runner.stop(run_id)?;
        self.snapshot(); // Read final persisted transcript only after process exit.
        self.launch(&serde_json::json!({ "accountId": target_id, "sessionKey": session_key }))
    }

    pub fn pin(&self, key: &str, pinned: bool) -> Result<(), ServiceError> {
        self.session(key)?;
        self.store.update(|s| {
            s.pinned.retain(|k| k != key);
            if pinned {
                s.pinned.push(key.to_owned());
            }
        })?;
        Ok(())
    }

    /// Forgets an account (`remove_account`, shared with `relay remove`): refused while one of
    /// its terminals runs or its usage sign-in is in progress; its usage sign-in is signed out
    /// with the CLI in its profile when one is found.
    pub fn remove(
        &self,
        id: &str,
        options: &ServiceRemoval<'_>,
    ) -> Result<AccountRemoved, ServiceError> {
        self.store.account(id)?;
        if self.running_on(id) {
            return fail("Stop the running session for this account first.");
        }
        self.cancel_background_sign_in(id);
        if self.auth.active(id) {
            return fail("Finish or cancel this account’s usage sign-in first.");
        }
        let executable = self.executable().ok();
        let sign_out = executable.map(|executable| {
            move |profile: &Path| -> Result<bool, String> {
                let env = profile_environment(&profile.to_string_lossy(), &process_env());
                command(&executable, &["auth", "logout"], &env, profile)
                    .map(|_| true)
                    .map_err(|e| e.to_string())
            }
        });
        Ok(remove_account(
            id,
            &AccountRemoval {
                store: &self.store,
                vault: options.vault,
                locks: options.locks,
                desktop: options.desktop,
                sign_out: sign_out.as_ref().map(|f| f as &_),
            },
        )?)
    }

    pub fn cooldown(&self, id: &str, hours: f64) -> Result<(), ServiceError> {
        self.store.account(id)?;
        let until = (hours != 0.0 && !hours.is_nan())
            .then(|| iso_timestamp(now_ms() + (hours * 3_600_000.0) as i64));
        self.store.update(|s| {
            if let Some(account) = s.accounts.iter_mut().find(|a| a.id == id) {
                account.cooldown_until = until;
            }
        })?;
        Ok(())
    }

    fn session(&self, key: &str) -> Result<IndexedSession, ServiceError> {
        self.index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(key)
            .cloned()
            .ok_or_else(|| ServiceError::Message("Session not found. Refresh the catalog.".into()))
    }

    fn executable(&self) -> Result<String, ServiceError> {
        let result = self.current_diagnostics();
        match (result.executable, result.error) {
            (Some(executable), None) => Ok(executable),
            (_, error) => Err(ServiceError::Message(error.unwrap_or_else(|| {
                "Claude Code was not found. Open Code once in the Claude app (it downloads Claude Code itself) or pick it in Settings → Advanced → Claude Code CLI → Choose file.".into()
            }))),
        }
    }
}

fn on_hold(account: &Account) -> bool {
    account
        .cooldown_until
        .as_deref()
        .and_then(parse_iso_ms)
        .is_some_and(|until| until > now_ms())
}
