//! Port of `electron/core/app-update.ts`: Relay's own updates. The GitHub release feed, version
//! order, `SHA256SUMS.txt`, and `AppUpdates`, which checks at start and every few hours, lets the
//! platform driver download and verify a newer release, says once per version when it is ready,
//! and installs it only when the user asks.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::continuation_journal::{MAX_BYTES, private_journal_directory, write_private_json};
use crate::shared::types::js::iso;
use crate::shared::types::{UpdateChannel, UpdateManualReason, UpdateState, UpdateStatus};

/// The public repository Relay's releases are published in.
pub const RELEASE_REPO: &str = "ahmetcankacar54/relay";

/// Where each channel looks: stable reads GitHub's newest release, which is never a draft or a
/// pre-release; beta reads the newest few releases of either kind and takes the highest version.
pub fn release_feed(channel: UpdateChannel) -> String {
    match channel {
        UpdateChannel::Stable => {
            format!("https://api.github.com/repos/{RELEASE_REPO}/releases/latest")
        }
        UpdateChannel::Beta => {
            format!("https://api.github.com/repos/{RELEASE_REPO}/releases?per_page=10")
        }
    }
}

/// A release's own page, for "What's new".
pub fn release_page(version: &str) -> String {
    format!("https://github.com/{RELEASE_REPO}/releases/tag/v{version}")
}

/// The first check after start, and the time between checks.
pub const FIRST_CHECK_MS: u64 = 30_000;
pub const CHECK_EVERY_MS: u64 = 6 * 3_600_000;
/// When a check encounters a transient missing asset or network error, retry much sooner.
pub const RETRY_CHECK_MS: u64 = 2 * 60_000;
const MAX_FEED_BYTES: u64 = 1024 * 1024;

pub const UPDATE_BUSY: &str = "Relay is busy with the Claude app. Update when it is done.";
pub const UPDATE_NOT_READY: &str = "No update is ready to install.";

/// Why an update step failed, as the message the Settings row shows.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct UpdateError(pub String);

impl UpdateError {
    pub fn new(message: impl Into<String>) -> Self {
        UpdateError(message.into())
    }
}

static SEMVER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$").expect("valid regex")
});

/// A version as numbers and its pre-release part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedVersion {
    pub parts: [u64; 3],
    pub pre: Option<String>,
}

/// A run of digits as `Number()` reads it, saturating where a JavaScript number would lose
/// precision anyway.
fn number(digits: &str) -> u64 {
    digits.parse().unwrap_or(u64::MAX)
}

/// `1.2.3` (an optional `v` and pre-release tag allowed) as numbers; None when it is not one.
pub fn parse_version(text: &str) -> Option<ParsedVersion> {
    let m = SEMVER.captures(crate::shared::types::js::trim(text))?;
    Some(ParsedVersion {
        parts: [number(&m[1]), number(&m[2]), number(&m[3])],
        pre: m.get(4).map(|p| p.as_str().to_owned()),
    })
}

/// Semver's pre-release order: identifier by identifier, numbers by value and below words.
fn compare_pre(a: &str, b: &str) -> Ordering {
    let x: Vec<&str> = a.split('.').collect();
    let y: Vec<&str> = b.split('.').collect();
    for i in 0..x.len().max(y.len()) {
        let (Some(xi), Some(yi)) = (x.get(i), y.get(i)) else {
            return if x.get(i).is_none() {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        };
        let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
        let (xn, yn) = (numeric(xi), numeric(yi));
        if xn && yn && number(xi) != number(yi) {
            return number(xi).cmp(&number(yi));
        }
        if xn != yn {
            return if xn {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        // JavaScript compares strings by UTF-16 unit; these are ASCII.
        if xi != yi {
            return xi.cmp(yi);
        }
    }
    Ordering::Equal
}

/// Not a version (`compareVersions` throws).
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid version.")]
pub struct InvalidVersion;

/// How `a` orders against `b`: Less when older. A pre-release is older than its release.
pub fn compare_versions(a: &str, b: &str) -> Result<Ordering, InvalidVersion> {
    let (Some(x), Some(y)) = (parse_version(a), parse_version(b)) else {
        return Err(InvalidVersion);
    };
    if x.parts != y.parts {
        return Ok(x.parts.cmp(&y.parts));
    }
    Ok(match (&x.pre, &y.pre) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => compare_pre(x, y),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub url: String,
    pub size: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes_url: String,
    pub assets: Vec<ReleaseAsset>,
}

/// Downloads come over https; plain http only from this computer, for a local test feed.
static DOWNLOAD_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:https://|http://(?:127\.0\.0\.1|localhost)(?::[0-9]+)?/)")
        .expect("valid regex")
});

/// `Number.isSafeInteger`.
fn safe_integer(value: &Value) -> Option<i64> {
    let n = value.as_f64()?;
    (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n as i64)
}

/// A GitHub release from its API JSON; None for a draft or a bad tag, and on the stable channel
/// also for a pre-release (by its flag or its tag). A pre-release keeps its tag's pre-release
/// part in its version, as its assets and its bundle name it.
pub fn release_from(json: &Value, channel: UpdateChannel) -> Option<Release> {
    let r = json.as_object()?;
    if r.get("draft") == Some(&Value::Bool(true)) {
        return None;
    }
    let tag = r.get("tag_name")?.as_str()?;
    if channel == UpdateChannel::Stable && r.get("prerelease") == Some(&Value::Bool(true)) {
        return None;
    }
    let parsed = parse_version(tag)?;
    if channel == UpdateChannel::Stable && parsed.pre.is_some() {
        return None;
    }
    let [major, minor, patch] = parsed.parts;
    let version = match &parsed.pre {
        Some(pre) => format!("{major}.{minor}.{patch}-{pre}"),
        None => format!("{major}.{minor}.{patch}"),
    };
    let assets = r
        .get("assets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?;
            let url = a.get("browser_download_url")?.as_str()?;
            let size = safe_integer(a.get("size")?)?;
            DOWNLOAD_URL.is_match(url).then(|| ReleaseAsset {
                name: name.to_owned(),
                url: url.to_owned(),
                size,
            })
        })
        .collect();
    Some(Release {
        notes_url: release_page(&version),
        version,
        assets,
    })
}

/// The highest usable release in a feed for `channel`: GitHub's release list, or one release
/// (the stable feed, or a local test feed).
pub fn newest_release(feed: &Value, channel: UpdateChannel) -> Option<Release> {
    let list = match feed {
        Value::Array(list) => list.iter().collect::<Vec<_>>(),
        one => vec![one],
    };
    let mut newest: Option<Release> = None;
    for json in list {
        if let Some(release) = release_from(json, channel)
            && newest.as_ref().is_none_or(|n| {
                compare_versions(&release.version, &n.version) == Ok(Ordering::Greater)
            })
        {
            newest = Some(release);
        }
    }
    newest
}

static CHECKSUM_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$").expect("valid regex"));

/// `SHA256SUMS.txt` (`<hex>  <name>` lines) as name → lower-case hex.
pub fn parse_checksums(text: &str) -> IndexMap<String, String> {
    let mut sums = IndexMap::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(m) = CHECKSUM_LINE.captures(line) {
            sums.insert(m[2].to_owned(), m[1].to_lowercase());
        }
    }
    sums
}

/// An answer: its status, its length when it says one, and the body to read.
pub struct UpdateResponse {
    pub status: u16,
    pub content_length: Option<u64>,
    pub body: Box<dyn Read + Send>,
}

impl UpdateResponse {
    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// One GET with these headers, the timeout covering the whole answer; an error when none came.
pub type UpdateRequest =
    Arc<dyn Fn(&str, &[(&str, &str)], Duration) -> Result<UpdateResponse, String> + Send + Sync>;

/// GETs as `fetch` makes them: redirects followed (GitHub's downloads redirect to its storage),
/// no proxy from the environment.
pub fn default_request() -> UpdateRequest {
    static CLIENT: LazyLock<reqwest::blocking::Client> = LazyLock::new(|| {
        reqwest::blocking::Client::builder()
            .tls_backend_preconfigured(crate::usage::tls_config())
            .no_proxy()
            .build()
            .expect("the HTTP client builds")
    });
    Arc::new(|url: &str, headers: &[(&str, &str)], timeout: Duration| {
        let mut request = CLIENT.get(url).timeout(timeout);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let response = request.send().map_err(|e| e.to_string())?;
        Ok(UpdateResponse {
            status: response.status().as_u16(),
            content_length: response.content_length(),
            body: Box::new(response),
        })
    })
}

/// A body as text, refusing one larger than `max_bytes`.
pub fn read_capped(body: &mut dyn Read, max_bytes: u64) -> Result<String, UpdateError> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = body
            .read(&mut chunk)
            .map_err(|e| UpdateError::new(e.to_string()))?;
        if read == 0 {
            break;
        }
        if (data.len() + read) as u64 > max_bytes {
            return Err(UpdateError::new("The update server sent too much data."));
        }
        data.extend_from_slice(&chunk[..read]);
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// Reads a JSON body of at most `max_bytes` (1 MiB), failing after `timeout` (15 s).
pub fn fetch_json(
    url: &str,
    request: Option<&UpdateRequest>,
    max_bytes: Option<u64>,
    timeout: Option<Duration>,
) -> Result<Value, UpdateError> {
    let request = request.cloned().unwrap_or_else(default_request);
    let mut response = request(
        url,
        &[
            ("Accept", "application/vnd.github+json"),
            ("User-Agent", "Relay"),
        ],
        timeout.unwrap_or(Duration::from_secs(15)),
    )
    .map_err(UpdateError)?;
    if !response.ok() {
        return Err(UpdateError(format!(
            "The update check failed (HTTP {}).",
            response.status
        )));
    }
    let text = read_capped(&mut response.body, max_bytes.unwrap_or(MAX_FEED_BYTES))?;
    serde_json::from_str(&text).map_err(|e| UpdateError::new(e.to_string()))
}

/// `Partial<UpdateState>`: each field absent (None), cleared (`Some(None)`, an explicit
/// `undefined`) or set.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UpdatePatch {
    pub status: Option<UpdateStatus>,
    pub version: Option<Option<String>>,
    pub notes_url: Option<Option<String>>,
    pub progress: Option<Option<f64>>,
    pub manual_reason: Option<Option<UpdateManualReason>>,
    pub error: Option<Option<String>>,
    pub checked_at: Option<Option<String>>,
    pub auto_check: Option<bool>,
}

impl UpdatePatch {
    pub fn status(status: UpdateStatus) -> Self {
        UpdatePatch {
            status: Some(status),
            ..UpdatePatch::default()
        }
    }
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(Some(version.into()));
        self
    }
    pub fn with_notes_url(mut self, url: impl Into<String>) -> Self {
        self.notes_url = Some(Some(url.into()));
        self
    }
    /// `progress: value`; None is `progress: undefined`, which clears it.
    pub fn with_progress(mut self, progress: Option<f64>) -> Self {
        self.progress = Some(progress);
        self
    }
    pub fn with_manual_reason(mut self, reason: UpdateManualReason) -> Self {
        self.manual_reason = Some(Some(reason));
        self
    }
    pub fn with_error(mut self, error: Option<String>) -> Self {
        self.error = Some(error);
        self
    }

    /// `{ ...base, ...patch }`.
    pub fn apply(&self, base: &UpdateState) -> UpdateState {
        fn pick<T: Clone>(patch: &Option<Option<T>>, base: &Option<T>) -> Option<T> {
            match patch {
                Some(value) => value.clone(),
                None => base.clone(),
            }
        }
        UpdateState {
            status: self.status.unwrap_or(base.status),
            current: base.current.clone(),
            auto_check: self.auto_check.unwrap_or(base.auto_check),
            version: pick(&self.version, &base.version),
            notes_url: pick(&self.notes_url, &base.notes_url),
            progress: pick(&self.progress, &base.progress),
            manual_reason: pick(&self.manual_reason, &base.manual_reason),
            error: pick(&self.error, &base.error),
            checked_at: pick(&self.checked_at, &base.checked_at),
        }
    }
}

/// How one platform finds, readies and installs a newer release: macOS by Relay itself
/// (`mac_update`), Windows and Linux by `win_linux_update`. `check` reports each step through
/// `report`.
pub trait UpdateDriver: Send + Sync {
    fn check(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError>;
    /// Starts the install; the caller quits Relay right after.
    fn install(&self) -> Result<(), UpdateError>;
}

/// A step logged: its event and fields.
pub type UpdateLog = Arc<dyn Fn(&str, &Value) + Send + Sync>;

/// `setTimeout`/`clearTimeout` for the check schedule; tests record them.
pub trait UpdateTimers: Send + Sync {
    fn set_timeout(&self, run: Box<dyn FnOnce() + Send>, ms: u64) -> u64;
    fn clear_timeout(&self, id: u64);
}

type TimerFlag = Arc<(Mutex<bool>, Condvar)>;

/// Timers on threads of their own; a cleared one wakes and ends at once.
#[derive(Default)]
pub struct ThreadTimers {
    next: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, TimerFlag>>>,
}

impl UpdateTimers for ThreadTimers {
    fn set_timeout(&self, run: Box<dyn FnOnce() + Send>, ms: u64) -> u64 {
        let id = self.next.fetch_add(1, AtomicOrdering::SeqCst);
        let flag: TimerFlag = Arc::new((Mutex::new(false), Condvar::new()));
        lock(&self.pending).insert(id, flag.clone());
        let pending = self.pending.clone();
        std::thread::spawn(move || {
            let (cleared, wake) = &*flag;
            let guard = lock(cleared);
            let (guard, _) = wake
                .wait_timeout_while(guard, Duration::from_millis(ms), |c| !*c)
                .unwrap_or_else(|e| e.into_inner());
            let cleared = *guard;
            drop(guard);
            lock(&pending).remove(&id);
            if !cleared {
                run();
            }
        });
        id
    }

    fn clear_timeout(&self, id: u64) {
        if let Some(flag) = lock(&self.pending).remove(&id) {
            *lock(&flag.0) = true;
            flag.1.notify_all();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// What `AppUpdates` runs with.
pub struct AppUpdatesDeps {
    /// `<data>/updates`: `state.json` and the downloads.
    pub folder: PathBuf,
    pub current: String,
    pub driver: Arc<dyn UpdateDriver>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// Told once per version when it is ready to install.
    pub notify: Arc<dyn Fn(&str) + Send + Sync>,
    /// Told whenever the state changes.
    pub changed: Arc<dyn Fn() + Send + Sync>,
    /// Why an install must wait now (a Claude app operation runs); None when it may run.
    pub busy: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// Quits Relay for the install; the app shell decides how.
    pub quit: Arc<dyn Fn() + Send + Sync>,
    /// `ThreadTimers` unless given.
    pub timers: Option<Arc<dyn UpdateTimers>>,
    pub log: Option<UpdateLog>,
}

/// The choice kept outside the registry: `<folder>/state.json`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    auto_check: bool,
    /// The last version a notification was shown for.
    #[serde(skip_serializing_if = "Option::is_none")]
    notified_version: Option<String>,
}

struct State {
    saved: Saved,
    current: UpdateState,
    timer: Option<u64>,
}

/// A check under way, shared by every caller that asks meanwhile.
type Running = Arc<(Mutex<Option<UpdateState>>, Condvar)>;

struct Inner {
    deps: AppUpdatesDeps,
    timers: Arc<dyn UpdateTimers>,
    state: Mutex<State>,
    running: Mutex<Option<Running>>,
}

/// Relay's own updates. Clones share them.
#[derive(Clone)]
pub struct AppUpdates(Arc<Inner>);

fn wait_for(running: &Running) -> UpdateState {
    let (slot, done) = &**running;
    let mut guard = lock(slot);
    loop {
        if let Some(state) = guard.as_ref() {
            return state.clone();
        }
        guard = done.wait(guard).unwrap_or_else(|e| e.into_inner());
    }
}

impl AppUpdates {
    pub fn new(deps: AppUpdatesDeps) -> Self {
        let saved = read_saved(&deps.folder);
        let current = UpdateState {
            status: UpdateStatus::Idle,
            current: deps.current.clone(),
            auto_check: saved.auto_check,
            version: None,
            notes_url: None,
            progress: None,
            manual_reason: None,
            error: None,
            checked_at: None,
        };
        let timers = deps
            .timers
            .clone()
            .unwrap_or_else(|| Arc::new(ThreadTimers::default()));
        AppUpdates(Arc::new(Inner {
            deps,
            timers,
            state: Mutex::new(State {
                saved,
                current,
                timer: None,
            }),
            running: Mutex::new(None),
        }))
    }

    fn file(&self) -> PathBuf {
        self.0.deps.folder.join("state.json")
    }

    fn write(&self, saved: &Saved) -> Result<(), UpdateError> {
        private_journal_directory(&self.0.deps.folder)
            .and_then(|()| write_private_json(&self.file(), saved, MAX_BYTES))
            .map_err(|e| UpdateError::new(e.to_string()))
    }

    pub fn state(&self) -> UpdateState {
        lock(&self.0.state).current.clone()
    }

    /// Applies a patch (over a fresh state when `replace`), says once per version when it is
    /// ready, and tells the app the state changed.
    fn set(&self, patch: UpdatePatch, replace: bool) {
        let announce = {
            let mut state = lock(&self.0.state);
            let base = if replace {
                UpdateState {
                    status: UpdateStatus::Idle,
                    current: self.0.deps.current.clone(),
                    auto_check: state.saved.auto_check,
                    version: None,
                    notes_url: None,
                    progress: None,
                    manual_reason: None,
                    error: None,
                    checked_at: None,
                }
            } else {
                state.current.clone()
            };
            state.current = patch.apply(&base);
            match (state.current.status, state.current.version.clone()) {
                (UpdateStatus::Ready, Some(version))
                    if state.saved.notified_version.as_ref() != Some(&version) =>
                {
                    state.saved.notified_version = Some(version.clone());
                    // Told again next time; never a reason to fail the update.
                    let _ = self.write(&state.saved);
                    Some(version)
                }
                _ => None,
            }
        };
        if let Some(version) = announce {
            (self.0.deps.notify)(&version);
        }
        (self.0.deps.changed)();
    }

    /// Checks first after FIRST_CHECK_MS, then every CHECK_EVERY_MS, while automatic checks
    /// are on.
    pub fn start(&self) {
        self.schedule(FIRST_CHECK_MS);
    }

    pub fn stop(&self) {
        if let Some(timer) = lock(&self.0.state).timer.take() {
            self.0.timers.clear_timeout(timer);
        }
    }

    fn schedule(&self, ms: u64) {
        self.stop();
        if !lock(&self.0.state).saved.auto_check {
            return;
        }
        let weak: Weak<Inner> = Arc::downgrade(&self.0);
        let timer = self.0.timers.set_timeout(
            Box::new(move || {
                let Some(inner) = weak.upgrade() else { return };
                let me = AppUpdates(inner);
                let state = me.check();
                let next = if (state.status == UpdateStatus::Manual
                    && state.manual_reason == Some(UpdateManualReason::NoAsset))
                    || state.status == UpdateStatus::Error
                {
                    RETRY_CHECK_MS
                } else {
                    CHECK_EVERY_MS
                };
                me.schedule(next);
            }),
            ms,
        );
        lock(&self.0.state).timer = Some(timer);
    }

    pub fn set_auto(&self, enabled: bool) -> Result<(), UpdateError> {
        let saved = {
            let mut state = lock(&self.0.state);
            state.saved.auto_check = enabled;
            state.saved.clone()
        };
        self.write(&saved)?;
        self.set(
            UpdatePatch {
                auto_check: Some(enabled),
                ..UpdatePatch::default()
            },
            false,
        );
        if enabled {
            self.schedule(FIRST_CHECK_MS);
        } else {
            self.stop();
        }
        Ok(())
    }

    /// Looks for a newer release now, sharing a check already running. A ready update stays
    /// ready.
    pub fn check(&self) -> UpdateState {
        let running: Running = {
            let mut slot = lock(&self.0.running);
            if let Some(running) = slot.as_ref() {
                let running = running.clone();
                drop(slot);
                return wait_for(&running);
            }
            if matches!(
                self.state().status,
                UpdateStatus::Ready | UpdateStatus::Installing
            ) {
                return self.state();
            }
            let running: Running = Arc::new((Mutex::new(None), Condvar::new()));
            *slot = Some(running.clone());
            running
        };
        self.set(UpdatePatch::status(UpdateStatus::Checking), true);
        let result = self
            .0
            .deps
            .driver
            .check(&mut |patch| self.set(patch, false));
        match result {
            Ok(()) => {
                if self.state().status == UpdateStatus::Checking {
                    self.set(UpdatePatch::status(UpdateStatus::UpToDate), false);
                }
            }
            Err(error) => {
                if let Some(log) = &self.0.deps.log {
                    let message: String = error.0.chars().take(200).collect();
                    log(
                        "update-error",
                        &json!({ "status": self.state().status, "error": message }),
                    );
                }
                self.set(
                    UpdatePatch::status(UpdateStatus::Error)
                        .with_error(Some(error.0))
                        .with_progress(None),
                    false,
                );
            }
        }
        self.set(
            UpdatePatch {
                checked_at: Some(Some(iso((self.0.deps.now)()))),
                ..UpdatePatch::default()
            },
            false,
        );
        let state = self.state();
        *lock(&running.0) = Some(state.clone());
        running.1.notify_all();
        let mut slot = lock(&self.0.running);
        if slot.as_ref().is_some_and(|r| Arc::ptr_eq(r, &running)) {
            *slot = None;
        }
        state
    }

    /// The update channel changed: what the old channel found no longer counts, so a beta
    /// ready to install is not offered after going back to stable. The new channel is checked
    /// at once while automatic checks are on. A check under way finishes first; an install
    /// under way is left alone.
    pub fn channel_changed(&self) -> UpdateState {
        let running = lock(&self.0.running).clone();
        if let Some(running) = running {
            wait_for(&running);
        }
        if self.state().status == UpdateStatus::Installing {
            return self.state();
        }
        self.set(UpdatePatch::status(UpdateStatus::Idle), true);
        if lock(&self.0.state).saved.auto_check {
            self.check()
        } else {
            self.state()
        }
    }

    /// Installs the ready update and quits Relay; the new version opens by itself.
    pub fn install(&self) -> Result<(), UpdateError> {
        if self.state().status != UpdateStatus::Ready {
            return Err(UpdateError::new(UPDATE_NOT_READY));
        }
        if let Some(busy) = (self.0.deps.busy)() {
            return Err(UpdateError(busy));
        }
        self.set(UpdatePatch::status(UpdateStatus::Installing), false);
        if let Err(error) = self.0.deps.driver.install() {
            self.set(
                UpdatePatch::status(UpdateStatus::Ready).with_error(Some(error.0.clone())),
                false,
            );
            return Err(error);
        }
        if let Some(log) = &self.0.deps.log {
            log(
                "update-install",
                &json!({ "version": self.state().version }),
            );
        }
        (self.0.deps.quit)();
        Ok(())
    }

    /// Said by the quit when it did not happen (the user cancelled): the update is ready again.
    pub fn quit_cancelled(&self) {
        if self.state().status == UpdateStatus::Installing {
            self.set(UpdatePatch::status(UpdateStatus::Ready), false);
        }
    }
}

fn read_saved(folder: &Path) -> Saved {
    let read = || -> Option<Saved> {
        let saved: Value =
            serde_json::from_slice(&std::fs::read(folder.join("state.json")).ok()?).ok()?;
        Some(Saved {
            auto_check: saved.get("autoCheck") != Some(&Value::Bool(false)),
            notified_version: saved
                .get("notifiedVersion")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    };
    read().unwrap_or(Saved {
        auto_check: true,
        notified_version: None,
    })
}
