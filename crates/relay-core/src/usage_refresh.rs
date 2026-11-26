//! Port of `electron/core/usage-refresh.ts`: renewing an account's official CLI sign-in through
//! the CLI's supported exchange (`CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES`,
//! `auth login`). A failed or uncertain rotation is never repeated for the same credential pair.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::cli_refresh_lock::{LockDir, cli_refresh_lock_paths, take_lock_dir};
use crate::clock::now_ms;
use crate::continuation_journal::{MAX_BYTES, read_private_json, write_private_json};
use crate::environment::{Env, process_env, profile_environment};
use crate::fs_util::{FileId, resolve, set_times};
use crate::profile_lock::ProfileLockError;
use crate::relay_paths::{Platform, home_dir};
use crate::shared::types::{Account, UsageIssue};
use crate::usage::{
    CredentialRead, UsageEndpoint, UsageRequest, default_request, network_detail, verify_identity,
};
use crate::usage_credentials::{UsageCredential, UsageError};

pub const USAGE_REFRESH_BEFORE_MS: f64 = 5.0 * 60_000.0;

/// Renews an account's credential: `(account, credential, force, allow_interaction)`.
pub type RefreshUsageCredential = Arc<
    dyn Fn(&Account, &UsageCredential, bool, bool) -> Result<UsageCredential, UsageError>
        + Send
        + Sync,
>;

pub fn needs_usage_credential_refresh(credential: &UsageCredential, now: f64) -> bool {
    credential
        .expires_at
        .is_some_and(|e| e <= now + USAGE_REFRESH_BEFORE_MS)
}

/// The hidden `auth login` run that exchanges the refresh token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRefreshCommand {
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Env,
    pub timeout_ms: u64,
}

/// Releases a profile lock.
pub type ProfileRelease = Box<dyn FnOnce() + Send>;

/// Finds the CLI to run the exchange with.
pub type ExecutableFn = Arc<dyn Fn() -> Result<String, UsageError> + Send + Sync>;
/// Whether the account's profile may be touched now.
pub type CanProceed = Arc<dyn Fn(&Account, &Path) -> bool + Send + Sync>;
/// Runs the exchange command.
pub type RunRefresh = Arc<dyn Fn(&UsageRefreshCommand) -> Result<(), UsageError> + Send + Sync>;
/// Takes an account's exclusive profile lock.
pub type ProfileLockFn =
    Arc<dyn Fn(&str) -> Result<ProfileRelease, ProfileLockError> + Send + Sync>;

/// What the refresher needs.
#[derive(Clone)]
pub struct UsageRefreshDeps {
    pub executable: ExecutableFn,
    pub read: CredentialRead,
    pub request: Option<UsageRequest>,
    pub can_proceed: Option<CanProceed>,
    pub run: Option<RunRefresh>,
    pub now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>,
    pub environment: Option<Env>,
    pub timeout_ms: Option<u64>,
    pub platform: Option<Platform>,
    /// Takes the account's exclusive profile lock, shared with Relay's other processes, and
    /// returns its release; fails with `ProfileLockError::Busy` while another process holds it.
    pub profile_lock: Option<ProfileLockFn>,
    /// Whether Anthropic cannot be reached at all right now. Asked when an exchange saved
    /// nothing new; without it such an exchange always counts as one that reached the server.
    pub unreachable: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl UsageRefreshDeps {
    /// The deps with only the required parts.
    pub fn new(executable: ExecutableFn, read: CredentialRead) -> UsageRefreshDeps {
        UsageRefreshDeps {
            executable,
            read,
            request: None,
            can_proceed: None,
            run: None,
            now: None,
            environment: None,
            timeout_ms: None,
            platform: None,
            profile_lock: None,
            unreachable: None,
        }
    }
}

/// An unconfirmed exchange is retried only after this delay, at most MAX times.
pub const USAGE_REFRESH_RETRY_MS: f64 = 30.0 * 60_000.0;
pub const USAGE_REFRESH_MAX_ATTEMPTS: f64 = 3.0;
/// An exchange made while Anthropic could not be reached is retried this soon, and not counted.
pub const USAGE_REFRESH_OFFLINE_RETRY_MS: f64 = 2.0 * 60_000.0;
/// The detail of the one "expired" that means the sign-in reached its ~30-day end.
pub const SIGN_IN_ENDED: &str = "refresh: sign-in reached its end date";

const ATTEMPT_FILE: &str = ".relay-usage-refresh.json";
const OWNER_FILE: &str = ".relay-usage-refresh.lock";
const OFFICIAL_LOCK: &str = ".oauth_refresh.lock";

/// A refresh under way: the refreshes asked meanwhile for the same profile wait for its answer.
struct Pending {
    account_id: String,
    identity: String,
    result: Mutex<Option<Result<UsageCredential, UsageError>>>,
    done: Condvar,
}

impl Pending {
    fn wait(&self) -> Result<UsageCredential, UsageError> {
        let mut result = self.result.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(r) = result.as_ref() {
                return r.clone();
            }
            result = self.done.wait(result).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// Shared by every refresher in the process, as the TS module-level map.
static PENDING: LazyLock<Mutex<HashMap<PathBuf, Arc<Pending>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn pending() -> std::sync::MutexGuard<'static, HashMap<PathBuf, Arc<Pending>>> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner())
}

fn fingerprint(credential: &UsageCredential) -> String {
    let mut hash = Sha256::new();
    hash.update(credential.access_token.as_bytes());
    hash.update(b"\0");
    hash.update(credential.refresh_token.as_deref().unwrap_or("").as_bytes());
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `JSON.stringify([accountUuid, orgId])`.
fn identity(account: &Account) -> String {
    let auth = account.auth.as_ref();
    let field = |v: Option<&String>| v.map_or(Value::Null, |s| Value::String(s.clone()));
    json!([
        field(auth.and_then(|a| a.account_uuid.as_ref())),
        field(auth.and_then(|a| a.org_id.as_ref()))
    ])
    .to_string()
}

fn fresh(credential: &UsageCredential, now: f64) -> bool {
    credential.expires_at.is_some_and(|e| e > now)
        && credential.scopes.iter().any(|s| s == "user:profile")
}

/// `/^[A-Za-z0-9:._/-]{1,150}$/`.
fn scope_ok(scope: &str) -> bool {
    (1..=150).contains(&scope.len())
        && scope
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'/' | b'-'))
}

/// How a probe of Anthropic's API ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOutcome {
    /// Any answer, a refusal included.
    Answered,
    /// fetch's TypeError: no network.
    Network,
    /// Timed out or aborted.
    Timeout,
    /// Anything else.
    Other,
}

/// A HEAD to `https://api.anthropic.com/` with an 8 s timeout, no redirects followed.
pub fn default_probe() -> ProbeOutcome {
    match crate::usage::http_client()
        .head("https://api.anthropic.com/")
        .timeout(Duration::from_secs(8))
        .send()
    {
        Ok(_) => ProbeOutcome::Answered,
        Err(e) if e.is_timeout() => ProbeOutcome::Timeout,
        Err(_) => ProbeOutcome::Network,
    }
}

/// Whether Anthropic's API cannot be reached now: a request that gets no answer at all (no
/// network, or 8 s without one). Any answer, a refusal included, means it can. No credential
/// travels with it.
pub fn anthropic_unreachable(probe: &dyn Fn() -> ProbeOutcome) -> bool {
    matches!(probe(), ProbeOutcome::Network | ProbeOutcome::Timeout)
}

/// No terminal, model request, callback browser, renderer output or shell.
fn run_refresh(command: &UsageRefreshCommand) -> Result<(), UsageError> {
    let expired = || UsageError::new(UsageIssue::Expired);
    let mut child = Command::new(&command.executable)
        .args(&command.args)
        .current_dir(&command.cwd)
        .env_clear()
        .envs(&command.env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| expired())?;
    let deadline = Instant::now() + Duration::from_millis(command.timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(expired()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(expired());
            }
        }
    }
}

/// An I/O failure, as the readers report a non-usage error.
fn io_failure() -> UsageError {
    UsageError::with_detail(UsageIssue::Unavailable, network_detail(Some("Error"), None))
}

fn sync_directory(directory: &Path) -> Result<(), UsageError> {
    crate::fs_util::sync_directory(directory).map_err(|_| io_failure())
}

/// Whether `pid` is gone for sure (`kill(pid, 0)` says ESRCH).
fn pid_gone(pid: i64) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return false;
        }
        io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let Ok(pid) = u32::try_from(pid) else {
            return false;
        };
        let pid = Pid::from_u32(pid);
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing(),
        );
        system.process(pid).is_none()
    }
}

fn is_not_found(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound
}

/// Supported CLI exchange: https://code.claude.com/docs/en/env-vars. A failed or uncertain
/// rotation is never repeated for the same credential pair.
#[derive(Clone)]
pub struct UsageCredentialRefresher {
    deps: UsageRefreshDeps,
}

impl UsageCredentialRefresher {
    pub fn new(deps: UsageRefreshDeps) -> UsageCredentialRefresher {
        UsageCredentialRefresher { deps }
    }

    fn now(&self) -> f64 {
        self.deps.now.as_ref().map_or_else(now_ms, |n| n()) as f64
    }

    pub fn any_active(&self) -> bool {
        !pending().is_empty()
    }

    pub fn is_refreshing(&self, account_id_or_profile: &str) -> bool {
        pending().iter().any(|(profile, job)| {
            job.account_id == account_id_or_profile || profile.as_os_str() == account_id_or_profile
        })
    }

    pub fn has_pending(&self, profile: &Path) -> bool {
        profile.join(ATTEMPT_FILE).exists()
    }

    pub fn refresh(
        &self,
        account: &Account,
        profile: &Path,
        credential: &UsageCredential,
        force: bool,
        allow_interaction: bool,
    ) -> Result<UsageCredential, UsageError> {
        if !profile.is_absolute() {
            return Err(UsageError::new(UsageIssue::CredentialsMissing));
        }
        let key = resolve(profile);
        let job = {
            let mut map = pending();
            if let Some(existing) = map.get(&key).cloned() {
                drop(map);
                if existing.identity != identity(account) {
                    return Err(UsageError::new(UsageIssue::IdentityMismatch));
                }
                return existing.wait();
            }
            let job = Arc::new(Pending {
                account_id: account.id.clone(),
                identity: identity(account),
                result: Mutex::new(None),
                done: Condvar::new(),
            });
            map.insert(key.clone(), job.clone());
            job
        };
        let result = self.run(account, &key, credential, force, allow_interaction);
        {
            let mut map = pending();
            if map.get(&key).is_some_and(|j| Arc::ptr_eq(j, &job)) {
                map.remove(&key);
            }
        }
        *job.result.lock().unwrap_or_else(|e| e.into_inner()) = Some(result.clone());
        job.done.notify_all();
        result
    }

    fn verified(
        &self,
        account: &Account,
        credential: UsageCredential,
    ) -> Result<UsageCredential, UsageError> {
        if !fresh(&credential, self.now()) {
            return Err(UsageError::new(UsageIssue::Expired));
        }
        let request = self.deps.request.clone().unwrap_or_else(default_request);
        verify_identity(
            account,
            &request(UsageEndpoint::Profile, &credential.access_token)?,
        )?;
        Ok(credential)
    }

    fn allowed(&self, account: &Account, profile: &Path) -> Result<(), UsageError> {
        if let Some(can) = &self.deps.can_proceed
            && !can(account, profile)
        {
            return Err(UsageError::new(UsageIssue::Unavailable));
        }
        Ok(())
    }

    fn run(
        &self,
        account: &Account,
        profile: &Path,
        supplied: &UsageCredential,
        force: bool,
        allow_interaction: bool,
    ) -> Result<UsageCredential, UsageError> {
        let missing = || UsageError::new(UsageIssue::CredentialsMissing);
        let mismatch = || UsageError::new(UsageIssue::IdentityMismatch);
        let home_default = resolve(&home_dir().join(".claude"));
        // Refused before it is looked at: the default profile need not exist.
        if !profile.is_absolute() || profile == home_default {
            return Err(missing());
        }
        let info = fs::symlink_metadata(profile).map_err(|_| io_failure())?;
        if !info.is_dir()
            || info.is_symlink()
            || crate::fs_util::real_path(profile).map_err(|_| io_failure())? != profile
        {
            return Err(missing());
        }
        let Some(auth) = account.auth.as_ref().filter(|a| {
            a.logged_in
                && a.account_uuid.as_deref().is_some_and(|u| !u.is_empty())
                && a.org_id.as_deref().is_some_and(|o| !o.is_empty())
        }) else {
            return Err(mismatch());
        };
        if let Some(desktop) = &account.desktop
            && (Some(&desktop.account_uuid) != auth.account_uuid.as_ref()
                || Some(&desktop.org_id) != auth.org_id.as_ref())
        {
            return Err(mismatch());
        }
        self.allowed(account, profile)?;
        let release = match &self.deps.profile_lock {
            None => None,
            Some(lock) => match lock(&account.id) {
                Ok(release) => Some(release),
                Err(ProfileLockError::Busy(_)) => {
                    return Err(UsageError::new(UsageIssue::Unavailable));
                }
                Err(_) => return Err(io_failure()),
            },
        };
        let result = self.locked(account, profile, supplied, force, allow_interaction);
        if let Some(release) = release {
            release();
        }
        result
    }

    fn read_attempt(&self, file: &Path) -> Result<Option<Map<String, Value>>, UsageError> {
        let saved = match read_private_json(file, MAX_BYTES) {
            Ok(value) => value,
            Err(e) if e.is_not_found() => return Ok(None),
            Err(_) => return Err(UsageError::new(UsageIssue::Expired)),
        };
        let unreadable =
            || UsageError::with_detail(UsageIssue::Expired, "refresh: unreadable attempt record");
        let obj = saved.as_object().ok_or_else(unreadable)?;
        let text = |k: &str| obj.get(k).and_then(Value::as_str);
        let generation_ok = text("generation").is_some_and(|g| {
            g.len() == 64
                && g.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
        let scopes = obj.get("scopes").and_then(Value::as_array);
        let scopes_ok = scopes.is_some_and(|s| {
            s.iter().all(|v| v.as_str().is_some_and(scope_ok))
                && s.iter().any(|v| v.as_str() == Some("user:profile"))
                && s.iter().any(|v| v.as_str() == Some("user:inference"))
        });
        let offline_ok = matches!(obj.get("offline"), None | Some(Value::Bool(_)));
        if obj.get("version").and_then(Value::as_f64) != Some(1.0)
            || text("id").is_none()
            || text("accountUuid").is_none()
            || text("orgId").is_none()
            || !generation_ok
            || obj.get("attemptedAt").and_then(Value::as_f64).is_none()
            || !scopes_ok
            || !offline_ok
        {
            return Err(unreadable());
        }
        Ok(Some(obj.clone()))
    }

    fn locked(
        &self,
        account: &Account,
        profile: &Path,
        supplied: &UsageCredential,
        mut force: bool,
        allow_interaction: bool,
    ) -> Result<UsageCredential, UsageError> {
        self.with_profile_lock(profile, || {
            let auth = account.auth.as_ref().expect("checked by run");
            let account_uuid = auth.account_uuid.clone().unwrap_or_default();
            let org_id = auth.org_id.clone().unwrap_or_default();
            let file = profile.join(ATTEMPT_FILE);
            let current = (self.deps.read)(profile, false)?;
            let generation = fingerprint(&current);
            let mut attempt = self.read_attempt(&file)?;
            // A replacement saved by a prior CLI/browser login can reconcile an uncertain
            // attempt. Presence alone never clears the rotation barrier.
            let mut previous_attempts = 0.0;
            if let Some(a) = attempt
                .as_ref()
                .filter(|a| a.get("generation").and_then(Value::as_str) == Some(&generation))
            {
                // Nothing new was saved: retry after a delay (or when the user asks), then
                // require a browser reconnect.
                previous_attempts = match a.get("attempts") {
                    None | Some(Value::Null) => 1.0,
                    Some(v) => v.as_f64().unwrap_or(f64::NAN),
                };
                if previous_attempts >= USAGE_REFRESH_MAX_ATTEMPTS {
                    return Err(UsageError::with_detail(
                        UsageIssue::Expired,
                        format!(
                            "refresh: {} exchanges without a new sign-in",
                            crate::shared::types::js::number_string(previous_attempts)
                        ),
                    ));
                }
                let offline = a.get("offline") == Some(&Value::Bool(true));
                let wait = if offline {
                    USAGE_REFRESH_OFFLINE_RETRY_MS
                } else {
                    USAGE_REFRESH_RETRY_MS
                };
                let attempted_at = a
                    .get("attemptedAt")
                    .and_then(Value::as_f64)
                    .unwrap_or_default();
                if !allow_interaction && self.now() - attempted_at < wait {
                    return Err(if offline {
                        UsageError::with_retry(
                            UsageIssue::Unavailable,
                            Some(attempted_at + wait),
                            Some("refresh: waiting for the network".into()),
                        )
                    } else {
                        UsageError::with_detail(
                            UsageIssue::Expired,
                            "refresh: waiting to retry an unconfirmed exchange",
                        )
                    });
                }
                attempt = None;
                force = true;
            }
            if let Some(attempt) = attempt {
                if attempt.get("accountUuid").and_then(Value::as_str) != Some(&account_uuid)
                    || attempt.get("orgId").and_then(Value::as_str) != Some(&org_id)
                {
                    return Err(UsageError::new(UsageIssue::IdentityMismatch));
                }
                let scopes = attempt
                    .get("scopes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if scopes.iter().any(|s| {
                    !current
                        .scopes
                        .iter()
                        .any(|c| Some(c.as_str()) == s.as_str())
                }) {
                    return Err(UsageError::new(UsageIssue::Scope));
                }
                let verified = self.verified(account, current)?;
                fs::remove_file(&file).map_err(|_| io_failure())?;
                self.sync_directory(profile)?;
                return Ok(verified);
            }
            if fingerprint(supplied) != generation
                || (!force && !needs_usage_credential_refresh(&current, self.now()))
            {
                if supplied.scopes.iter().any(|s| !current.scopes.contains(s)) {
                    return Err(UsageError::new(UsageIssue::Scope));
                }
                return self.verified(account, current);
            }
            // Each browser sign-in lasts about 30 days; renewals keep that end.
            if current.refresh_token.is_some()
                && current
                    .refresh_token_expires_at
                    .is_some_and(|e| e <= self.now())
            {
                return Err(UsageError::with_detail(UsageIssue::Expired, SIGN_IN_ENDED));
            }
            let has = |s: &str| current.scopes.iter().any(|c| c == s);
            let Some(refresh_token) = current.refresh_token.clone().filter(|_| {
                has("user:profile")
                    && has("user:inference")
                    && current.scopes.iter().all(|s| scope_ok(s))
            }) else {
                return Err(UsageError::with_detail(
                    UsageIssue::Expired,
                    "refresh: saved sign-in cannot be renewed",
                ));
            };
            // The vendor CLI updates its own Keychain item through `/usr/bin/security`, exactly
            // as it does during normal use, so a background renewal needs no consent dialog.
            let executable = (self.deps.executable)()?;
            if !Path::new(&executable).is_absolute() {
                return Err(UsageError::new(UsageIssue::Unavailable));
            }
            self.allowed(account, profile)?;
            self.with_official_refresh_lock(profile, |assert_owned| {
                self.allowed(account, profile)?;
                let locked_current = (self.deps.read)(profile, false)?;
                if fingerprint(&locked_current) != generation {
                    if current
                        .scopes
                        .iter()
                        .any(|s| !locked_current.scopes.contains(s))
                    {
                        return Err(UsageError::new(UsageIssue::Scope));
                    }
                    return self.verified(account, locked_current);
                }
                let source = self.deps.environment.clone().unwrap_or_else(process_env);
                let mut env = profile_environment(&profile.to_string_lossy(), &source);
                env.insert(
                    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN".into(),
                    refresh_token.clone(),
                );
                env.insert("CLAUDE_CODE_OAUTH_SCOPES".into(), current.scopes.join(" "));
                // Auth subcommands initialize an unawaited refresh; this child-only access
                // source has no refresh token, suppressing that race.
                env.insert(
                    "CLAUDE_CODE_OAUTH_TOKEN".into(),
                    current.access_token.clone(),
                );
                if let Some(client) = &current.client_id {
                    env.insert("CLAUDE_CODE_OAUTH_CLIENT_ID".into(), client.clone());
                }
                let record = |attempts: f64, attempted_at: f64, offline: bool| {
                    let mut r = Map::new();
                    r.insert("version".into(), 1.into());
                    r.insert("id".into(), uuid::Uuid::new_v4().to_string().into());
                    r.insert("accountUuid".into(), account_uuid.clone().into());
                    r.insert("orgId".into(), org_id.clone().into());
                    r.insert("generation".into(), generation.clone().into());
                    r.insert("attemptedAt".into(), number(attempted_at));
                    r.insert("scopes".into(), json!(current.scopes));
                    r.insert("attempts".into(), number(attempts));
                    if offline {
                        r.insert("offline".into(), true.into());
                    }
                    r
                };
                let first = record(previous_attempts + 1.0, self.now(), false);
                write_private_json(&file, &first, MAX_BYTES).map_err(|_| io_failure())?;
                assert_owned()?;
                let run = self.deps.run.clone();
                let command = UsageRefreshCommand {
                    executable: executable.clone(),
                    args: [
                        "--safe-mode",
                        "--settings",
                        "{\"disableAllHooks\":true}",
                        "auth",
                        "login",
                        "--claudeai",
                    ]
                    .map(String::from)
                    .to_vec(),
                    cwd: profile.to_path_buf(),
                    env,
                    timeout_ms: self.deps.timeout_ms.unwrap_or(90_000),
                };
                // The authoritative saved credential below may positively reconcile an error
                // after exchange/save. Never execute a second command.
                let _ = match run {
                    Some(run) => run(&command),
                    None => run_refresh(&command),
                };
                // Even a successful CLI exit is insufficient; only persisted fresh replacement
                // credentials plus server UUID/org proof complete it.
                let saved = (self.deps.read)(profile, false)?;
                if fingerprint(&saved) == generation
                    && self.deps.unreachable.as_ref().is_some_and(|u| u())
                {
                    // The CLI could not reach Anthropic: nothing was exchanged.
                    let mut offline = first.clone();
                    offline.insert("attempts".into(), number(previous_attempts));
                    offline.insert("attemptedAt".into(), number(self.now()));
                    offline.insert("offline".into(), true.into());
                    write_private_json(&file, &offline, MAX_BYTES).map_err(|_| io_failure())?;
                    return Err(UsageError::with_retry(
                        UsageIssue::Unavailable,
                        Some(self.now() + USAGE_REFRESH_OFFLINE_RETRY_MS),
                        Some("refresh: no network".into()),
                    ));
                }
                if fingerprint(&saved) == generation || !fresh(&saved, self.now()) {
                    return Err(UsageError::with_detail(
                        UsageIssue::Expired,
                        "refresh: no new sign-in saved",
                    ));
                }
                if current.scopes.iter().any(|s| !saved.scopes.contains(s)) {
                    return Err(UsageError::new(UsageIssue::Scope));
                }
                let verified = self.verified(account, saved)?;
                self.allowed(account, profile)?;
                // A timeout can occur after an atomic save. That positive saved+server receipt
                // reconciles it without making a second exchange.
                assert_owned()?;
                fs::remove_file(&file).map_err(|_| io_failure())?;
                self.sync_directory(profile)?;
                Ok(verified)
            })
        })
    }

    fn sync_directory(&self, directory: &Path) -> Result<(), UsageError> {
        if cfg!(windows) {
            return Ok(());
        }
        sync_directory(directory)
    }

    fn remove_owned_official(&self, profile: &Path, official: FileId) -> Result<(), UsageError> {
        let file = profile.join(OFFICIAL_LOCK);
        match fs::symlink_metadata(&file) {
            Ok(stat) => {
                if stat.is_dir()
                    && !stat.is_symlink()
                    && FileId::of_path(&file).is_ok_and(|id| id == official)
                {
                    fs::remove_dir(&file).map_err(|_| io_failure())?;
                }
                Ok(())
            }
            Err(e) if is_not_found(&e) => Ok(()),
            Err(_) => Err(io_failure()),
        }
    }

    fn with_profile_lock<T>(
        &self,
        profile: &Path,
        action: impl FnOnce() -> Result<T, UsageError>,
    ) -> Result<T, UsageError> {
        let file = profile.join(OWNER_FILE);
        let unavailable = || UsageError::new(UsageIssue::Unavailable);
        let mut handle: Option<fs::File> = None;
        for _ in 0..2 {
            match crate::fs_util::create_new_private(&file) {
                Ok(h) => {
                    handle = Some(h);
                    break;
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(unavailable()),
            }
            let before = FileId::of_path(&file).map_err(|_| io_failure())?;
            let previous = read_private_json(&file, MAX_BYTES).map_err(|_| io_failure())?;
            let pid = crate::fs_util::safe_integer(previous.get("pid").unwrap_or(&Value::Null));
            let Some(pid) = pid.filter(|p| *p > 0) else {
                return Err(UsageError::new(UsageIssue::Expired));
            };
            let Some(token) = previous.get("token").and_then(Value::as_str) else {
                return Err(UsageError::new(UsageIssue::Expired));
            };
            if !pid_gone(pid) {
                return Err(unavailable());
            }
            let named = fs::symlink_metadata(&file).map_err(|_| io_failure())?;
            let retained = read_private_json(&file, MAX_BYTES).map_err(|_| io_failure())?;
            if named.is_symlink()
                || FileId::of_path(&file).map_err(|_| io_failure())? != before
                || retained.get("token").and_then(Value::as_str) != Some(token)
                || crate::fs_util::safe_integer(retained.get("pid").unwrap_or(&Value::Null))
                    != Some(pid)
            {
                return Err(unavailable());
            }
            fs::remove_file(&file).map_err(|_| io_failure())?;
        }
        let Some(mut handle) = handle else {
            return Err(unavailable());
        };
        let stat = FileId::of_file(&handle).map_err(|_| io_failure())?;
        let owner = json!({ "pid": std::process::id(), "token": uuid::Uuid::new_v4().to_string() });
        let result = (|| {
            handle
                .write_all(owner.to_string().as_bytes())
                .and_then(|()| handle.sync_all())
                .map_err(|_| io_failure())?;
            self.sync_directory(profile)?;
            action()
        })();
        drop(handle);
        match fs::symlink_metadata(&file) {
            Ok(named) => {
                if !named.is_symlink() && FileId::of_path(&file).is_ok_and(|id| id == stat) {
                    fs::remove_file(&file).map_err(|_| io_failure())?;
                    self.sync_directory(profile)?;
                }
            }
            // A lock file left behind must surface, over the action's result.
            Err(e) if !is_not_found(&e) => return Err(io_failure()),
            Err(_) => {}
        }
        result
    }

    fn with_official_refresh_lock<T>(
        &self,
        profile: &Path,
        action: impl FnOnce(&dyn Fn() -> Result<(), UsageError>) -> Result<T, UsageError>,
    ) -> Result<T, UsageError> {
        let directory = profile.join(OFFICIAL_LOCK);
        crate::fs_util::create_private_dir(&directory)
            .map_err(|_| UsageError::new(UsageIssue::Unavailable))?;
        let stat = FileId::of_path(&directory).map_err(|_| io_failure())?;
        let owner_file = profile.join(OWNER_FILE);
        let mut legacy: Option<Arc<LockDir>> = None;
        let mut toucher: Option<(mpsc::Sender<()>, std::thread::JoinHandle<()>)> = None;
        let result = (|| {
            legacy = Some(Arc::new(
                take_lock_dir(&cli_refresh_lock_paths(profile).legacy, 0, &now_ms)
                    .map_err(|_| UsageError::new(UsageIssue::Unavailable))?,
            ));
            let owner = read_private_json(&owner_file, MAX_BYTES).map_err(|_| io_failure())?;
            let mut owner = owner.as_object().cloned().unwrap_or_default();
            owner.insert(
                "official".into(),
                json!({ "dev": stat.dev, "ino": stat.ino }),
            );
            // Rewrite the existing inode: the live owner descriptor remains valid.
            let mut options = fs::OpenOptions::new();
            options.write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW);
            }
            let mut handle = options.open(&owner_file).map_err(|_| io_failure())?;
            handle
                .set_len(0)
                .and_then(|()| handle.write_all(Value::Object(owner).to_string().as_bytes()))
                .and_then(|()| handle.sync_all())
                .map_err(|_| io_failure())?;
            drop(handle);
            self.sync_directory(profile)?;
            let (stop, stopped) = mpsc::channel::<()>();
            let touched_dir = directory.clone();
            let touched_legacy = legacy.clone();
            let thread = std::thread::spawn(move || {
                while let Err(mpsc::RecvTimeoutError::Timeout) =
                    stopped.recv_timeout(Duration::from_secs(5))
                {
                    if let Ok(named) = fs::symlink_metadata(&touched_dir)
                        && !named.is_symlink()
                        && FileId::of_path(&touched_dir).is_ok_and(|id| id == stat)
                    {
                        let _ = set_times(&touched_dir, SystemTime::now());
                    }
                    if let Some(legacy) = &touched_legacy {
                        legacy.touch();
                    }
                }
            });
            toucher = Some((stop, thread));
            let assert_owned = || -> Result<(), UsageError> {
                let expired = || UsageError::new(UsageIssue::Expired);
                let named = fs::symlink_metadata(&directory).map_err(|_| io_failure())?;
                if !named.is_dir()
                    || named.is_symlink()
                    || FileId::of_path(&directory).map_err(|_| io_failure())? != stat
                {
                    return Err(expired());
                }
                Ok(())
            };
            let result = action(&assert_owned)?;
            assert_owned()?;
            Ok(result)
        })();
        if let Some((stop, thread)) = toucher {
            drop(stop);
            let _ = thread.join();
        }
        if let Some(legacy) = legacy.and_then(|l| Arc::try_unwrap(l).ok()) {
            legacy.release();
        }
        let removed = self.remove_owned_official(profile, stat);
        let synced = self.sync_directory(profile);
        removed?;
        synced?;
        result
    }
}

/// A JSON number as JS writes it: integral values without a fraction.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}
