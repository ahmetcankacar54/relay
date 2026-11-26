//! Port of `electron/core/draft-restorer.ts`: types the drafts captured at a switch back into
//! the empty composers of their conversations once Desktop's own draft wipe is past.
//!
//! Blocking where the TS awaits; every wait and clock goes through the deps.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::continuation::SessionStatus;
use crate::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationIssue, DesktopAutomationSnapshot, DesktopDraftGuard,
    DesktopHostError, OpenSessionOptions, WriteDraftOptions, automation_guard, is_local_session_id,
    new_session_guard,
};
use crate::desktop_lock::DesktopLockError;
use crate::draft_diagnostics::{DraftLog, log_draft, short_id};
use crate::draft_vault::{DraftRecord, DraftState};
use crate::shared::types::literal_enum;

/// A file lock that fails passes through `with_lock` as an ordinary error.
impl From<DesktopLockError> for DesktopHostError {
    fn from(error: DesktopLockError) -> Self {
        DesktopHostError::other(error.to_string())
    }
}

/// What a restore tells the user: drafts restored, and drafts left for copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DraftCounts {
    pub restored: usize,
    pub left: usize,
}

/// What a restore needs from the app. Optional TS members are methods with the TS defaults.
pub trait RestorerDeps: Send + Sync {
    fn automation(&self) -> &dyn DesktopAutomation;
    /// Records with text, main process only.
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError>;
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError>;
    fn remove(&self, id: &str) -> Result<(), DesktopHostError>;
    /// Desktop's currentAccountUuid.
    fn current_account(&self) -> Result<Option<String>, DesktopHostError>;
    fn running(&self) -> Result<bool, DesktopHostError>;
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError>;
    /// When Desktop last finished its draft wipe (`chat-draft-wipe-completed-at`, ms since the
    /// epoch), as its Local Storage says; `None` when unknown. Without it, Claude is ready only
    /// once it has run 15 s.
    fn wiped_at(&self) -> Result<Option<i64>, DesktopHostError> {
        Ok(None)
    }
    /// Whether the running Claude's claude.ai page has booted, from Claude's own log; `None`
    /// when the log cannot tell. Until it has, Relay opens and types nothing.
    fn page_booted(&self) -> Result<Option<bool>, DesktopHostError> {
        Ok(None)
    }
    /// Runs `f` holding Relay's Desktop lock: `Ok(true)` once it ran, `Ok(false)` without
    /// running it when busy. Whatever `f` decides travels in its own captured state, so the
    /// restorer's stops pass through the lock.
    fn with_lock(&self, f: &mut dyn FnMut()) -> Result<bool, DesktopHostError>;
    /// True when another caller waits for the Desktop lock while the restore holds it.
    fn yielding(&self) -> bool;
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError>;
    fn sleep(&self, ms: u64) -> Result<(), DesktopHostError>;
    fn now(&self) -> i64;
    /// A diagnosis log: ids cut to 8 characters, states, reasons, issue codes, counts and
    /// booleans. Never a draft's text or title, and never an error's message.
    fn log(&self) -> Option<&DraftLog> {
        None
    }
}

literal_enum!(RestoreStatus {
    Idle = "idle",
    Waiting = "waiting",
    Done = "done",
});

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub status: RestoreStatus,
    /// Drafts typed into their composer and seen there 5 s later.
    pub restored: usize,
    /// This account's other drafts of the run: now left for copy, or still pending.
    pub left: usize,
    /// Why a run stopped with drafts still pending: `not-ready`, `busy`, `active`,
    /// `elsewhere`, `moved`, `changed`, `claude-not-running`, `budget` or `loading`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RestoreResult {
    fn new(status: RestoreStatus, restored: usize, left: usize, reason: Option<&str>) -> Self {
        RestoreResult {
            status,
            restored,
            left,
            reason: reason.map(str::to_owned),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOptions {
    /// Relay may take the user to a draft's place that is not on screen, and back; true unless
    /// said otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visits: Option<bool>,
    /// Right after a switch: Claude may still be starting, so the run waits up to 10 s for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launching: Option<bool>,
}

type Snapshot = DesktopAutomationSnapshot;

/// Code's new-session screen, where the draft of a session that does not exist yet goes.
const NEW_SESSION: &str = "new-session";

/// The place `view` shows: a conversation, the new-session screen, or `None`.
fn place_of(view: &Snapshot) -> Option<String> {
    view.local_session_id
        .clone()
        .or_else(|| (view.new_session == Some(true)).then(|| NEW_SESSION.to_owned()))
}

/// A place for the diagnosis log: a conversation's alias cut to 8 characters, or the screen.
fn place_label(place: Option<&str>) -> Value {
    match place {
        None => Value::Null,
        Some(NEW_SESSION) => json!(NEW_SESSION),
        Some(place) => json!(short_id(Some(
            place.strip_prefix("local_").unwrap_or(place)
        ))),
    }
}

/// Without Desktop's wipe marker, restore only once Claude has run this long.
const MIN_UPTIME_MS: i64 = 15_000;
/// `ps etime` counts whole seconds: a wipe this much before Claude's start still counts.
const WIPE_SLACK_MS: i64 = 1_000;
/// How long a run right after a switch waits for Claude to start.
const LAUNCH_MS: i64 = 10_000;
const POLL_MS: u64 = 500;
/// How long Desktop's UI may take to answer at all.
const READY_MS: i64 = 60_000;
/// How long an opened conversation may take to show, and how often its link is sent again.
const SHOWN_MS: i64 = 30_000;
const RESEND_MS: i64 = 5_000;
/// When a written draft is read again, to catch a wipe that came after it.
const RECHECK_MS: u64 = 5_000;
/// The longest a whole run may take before the drafts left wait for the next one.
const BUDGET_MS: i64 = 5 * 60_000;
/// The longest draft `write_draft` takes. Longer ones are left for Copy.
const MAX_TEXT: usize = 16_384;
/// How long the user must have left the keyboard and mouse alone before Relay takes them to
/// another place.
pub const IDLE_MS: i64 = 3_000;
/// How long no key may have been pressed before Relay types.
pub const QUIET_MS: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Leaves {
    Pending,
    Copy,
}

impl Leaves {
    fn as_str(self) -> &'static str {
        match self {
            Leaves::Pending => "pending",
            Leaves::Copy => "copy",
        }
    }
}

/// Ends a run. With `Pending`, the draft in hand and those after it stay pending; with `Copy`,
/// they are all left for copy with `reason`.
#[derive(Debug)]
struct Stop {
    leaves: Leaves,
    reason: &'static str,
}

/// A run's way out: a [`Stop`], or a failure the caller rethrows.
#[derive(Debug)]
enum Fail {
    Stop(Stop),
    Error(DesktopHostError),
}

impl From<DesktopHostError> for Fail {
    fn from(error: DesktopHostError) -> Self {
        Fail::Error(error)
    }
}

fn stop<T>(leaves: Leaves, reason: &'static str) -> Result<T, Fail> {
    Err(Fail::Stop(Stop { leaves, reason }))
}

fn issue_of(error: &DesktopHostError) -> DesktopAutomationIssue {
    error
        .issue()
        .unwrap_or(DesktopAutomationIssue::DesktopUiUnsupported)
}

/// A Stop when `error` ends the run. Any other failure is the caller's.
fn halt_on(error: &DesktopHostError) -> Result<(), Fail> {
    match issue_of(error) {
        DesktopAutomationIssue::AccessibilityPermissionRequired => {
            stop(Leaves::Copy, "accessibility")
        }
        DesktopAutomationIssue::ClaudeNotRunning => stop(Leaves::Pending, "claude-not-running"),
        _ => Ok(()),
    }
}

fn same_account(a: Option<&str>, b: &str) -> bool {
    a.is_some_and(|a| !a.is_empty() && a.to_lowercase() == b.to_lowercase())
}

/// Claude is in front and the user has not touched the keyboard or mouse for 3 s.
fn lets_act(view: &Snapshot) -> bool {
    view.frontmost == Some(true) && view.idle_ms.unwrap_or(0) >= IDLE_MS
}

/// Claude is in front and no key has been pressed for 1 s; a helper that does not tell keys
/// apart needs 3 s without any input.
fn lets_type(view: &Snapshot) -> bool {
    view.frontmost == Some(true)
        && match view.key_idle_ms {
            Some(keys) => keys >= QUIET_MS,
            None => view.idle_ms.unwrap_or(0) >= IDLE_MS,
        }
}

/// Why a draft is left for copy once a write was tried.
fn after_write(reason: &str) -> String {
    if reason == "lost" || reason == "composer-not-empty" {
        reason.to_owned()
    } else {
        "maybe-typed".to_owned()
    }
}

/// Another Desktop operation waits for the lock: let it go first.
fn yield_to(deps: &dyn RestorerDeps) -> Result<(), Fail> {
    if deps.yielding() {
        return stop(Leaves::Pending, "busy");
    }
    Ok(())
}

fn log(deps: &dyn RestorerDeps, event: &str, fields: Value) {
    if let Value::Object(fields) = fields {
        log_draft(deps.log(), event, Some(&fields));
    }
}

/// What a run holds to: Desktop's account and Claude's process, and where the user is.
struct Run {
    account: String,
    pid: i64,
    /// Desktop's wipe is known to be past from its marker.
    wiped: bool,
    /// Relay may take the user to a place not on screen, and back.
    visits: bool,
    /// Set by the first lock's look at the screen.
    anchored: bool,
    /// The place the user was on, to take them back to.
    return_to: Option<String>,
    /// The shape of the page the first lock's look found, for the diagnosis log.
    screen: Option<String>,
    /// The place Relay last saw on screen. Anything else means the user moved.
    last_seen: Option<String>,
}

/// The place a draft is typed into, or `None` when it can only be copied by hand.
pub fn draft_place(record: &DraftRecord) -> Option<String> {
    typeable(record)
}

/// Types the drafts captured for Desktop's current account back into the empty composers of
/// their conversations, and of Code's new-session screen, once Desktop's draft wipe is past,
/// and takes the user back to where they were. It never sends, and never writes into a
/// composer that is not empty. See the TS for the full contract.
pub fn restore_drafts(
    deps: &dyn RestorerDeps,
    options: RestoreOptions,
) -> Result<RestoreResult, DesktopHostError> {
    match restore(deps, options) {
        Ok(result) => {
            log(
                deps,
                "restore-end",
                json!({
                    "status": result.status.as_str(),
                    "restored": result.restored,
                    "left": result.left,
                    "reason": result.reason,
                }),
            );
            Ok(result)
        }
        Err(error) => {
            // Its name only: a message could hold anything, a draft's text included.
            let mut fields = json!({ "status": "threw", "error": "Error" });
            if let Some(issue) = error.issue() {
                fields["issue"] = json!(issue.as_str());
            }
            log(deps, "restore-end", fields);
            Err(error)
        }
    }
}

/// Claude is ready: `wiped` when its marker said so before 15 s; how long the run waited.
struct Ready {
    wiped: bool,
    waited_ms: i64,
}

/// What the start of a run found before Desktop's UI.
enum Begin {
    /// Nothing for this account.
    Idle,
    /// Claude ready, or not.
    Checked(Option<Ready>),
}

/// The restore-start entry's `ready`.
enum StartReady<'a> {
    Null,
    Failed,
    Checked(Option<&'a Ready>),
}

fn restore(
    deps: &dyn RestorerDeps,
    options: RestoreOptions,
) -> Result<RestoreResult, DesktopHostError> {
    let started = deps.now();
    let mut account: Option<String> = None;
    let mut records: Vec<DraftRecord> = Vec::new();
    // Every record read, whatever its account or state; None before they are read.
    let mut all: Option<usize> = None;
    let start = |account: &Option<String>,
                 records: usize,
                 all: Option<usize>,
                 ready: StartReady<'_>,
                 error: Option<&str>| {
        let mut fields = json!({
            "account": short_id(account.as_deref()),
            "records": records,
            "all": all,
            "ready": match &ready {
                StartReady::Null => Value::Null,
                StartReady::Failed => json!(false),
                StartReady::Checked(ready) => json!(ready.is_some()),
            },
        });
        if let StartReady::Checked(Some(ready)) = ready {
            fields["wiped"] = json!(ready.wiped);
            fields["waitedMs"] = json!(ready.waited_ms);
        }
        if let Some(error) = error {
            fields["error"] = json!(error);
        }
        log(deps, "restore-start", fields);
    };
    let begin = (|| -> Result<Begin, DesktopHostError> {
        account = deps.current_account()?;
        let Some(current) = account.as_deref().filter(|a| !a.is_empty()) else {
            return Ok(Begin::Idle);
        };
        let read = deps.pending()?;
        all = Some(read.len());
        records = read
            .into_iter()
            .filter(|record| {
                record.state == DraftState::Pending && same_account(Some(&record.to), current)
            })
            .collect();
        if records.is_empty() {
            return Ok(Begin::Idle);
        }
        Ok(Begin::Checked(claude_ready(
            deps,
            options.launching == Some(true),
        )?))
    })();
    let ready = match begin {
        Ok(Begin::Idle) => {
            start(&account, records.len(), all, StartReady::Null, None);
            return Ok(RestoreResult::new(RestoreStatus::Idle, 0, 0, None));
        }
        Err(_) => {
            start(
                &account,
                records.len(),
                all,
                StartReady::Failed,
                Some("start-failed"),
            );
            return Ok(RestoreResult::new(
                RestoreStatus::Waiting,
                0,
                records.len(),
                None,
            ));
        }
        Ok(Begin::Checked(ready)) => ready,
    };
    start(
        &account,
        records.len(),
        all,
        StartReady::Checked(ready.as_ref()),
        None,
    );
    let Some(ready) = ready else {
        return Ok(RestoreResult::new(
            RestoreStatus::Waiting,
            0,
            records.len(),
            None,
        ));
    };
    // A link into a page still loading starts its load again: wait until it has booted.
    if deps.page_booted().ok().flatten() == Some(false) {
        log(deps, "page-loading", json!({ "records": records.len() }));
        return Ok(RestoreResult::new(
            RestoreStatus::Waiting,
            0,
            records.len(),
            Some("loading"),
        ));
    }
    let mut ctx = Ctx {
        deps,
        records,
        restored: 0,
        copied: 0,
        skipped: 0,
        next: 0,
        wrote: false,
    };
    let account = account.unwrap_or_default();
    let mut run = match ctx.records_phase(started, account, &ready, options) {
        Ok(run) => run,
        Err(Fail::Error(error)) => return Err(error),
        Err(Fail::Stop(stop)) => {
            log(
                deps,
                "stop",
                json!({
                    "leaves": stop.leaves.as_str(),
                    "reason": stop.reason,
                    "wrote": ctx.wrote,
                    "phase": "records",
                }),
            );
            // A draft being typed may be in its composer: copy, never type it again.
            if stop.leaves == Leaves::Copy {
                for i in ctx.next..ctx.records.len() {
                    let reason = if i == ctx.next && ctx.wrote {
                        "maybe-typed"
                    } else {
                        stop.reason
                    };
                    let record = ctx.records[i].clone();
                    ctx.leave(&record, reason);
                }
                return Ok(ctx.end(RestoreStatus::Done, None));
            }
            if ctx.wrote {
                let record = ctx.records[ctx.next].clone();
                ctx.leave(&record, "maybe-typed");
            }
            return Ok(ctx.end(RestoreStatus::Waiting, Some(stop.reason)));
        }
    };
    if run.anchored && run.return_to.is_some() && run.return_to != run.last_seen {
        let back = run.return_to.clone().unwrap_or_default();
        let returned = locked(deps, || {
            // Relay went there itself, so a visit is allowed: SKIP never comes back here.
            if confirm(deps, &mut run, &back)? {
                return Ok(());
            }
            // The user can go back by hand, and one who is active stays where they are.
            let _ = go(deps, &back);
            Ok(())
        });
        match returned {
            Ok(()) => {}
            Err(Fail::Error(error)) => return Err(error),
            Err(Fail::Stop(stop)) => {
                // The user moved, or Desktop is busy: the drafts are done, the user stays.
                log(
                    deps,
                    "stop",
                    json!({
                        "leaves": stop.leaves.as_str(),
                        "reason": stop.reason,
                        "wrote": false,
                        "phase": "return",
                    }),
                );
            }
        }
    }
    Ok(if ctx.skipped > 0 {
        ctx.end(RestoreStatus::Waiting, Some("elsewhere"))
    } else {
        ctx.end(RestoreStatus::Done, None)
    })
}

/// How one draft's turn under the lock ended.
enum Outcome {
    /// Its place is not on screen and cannot be gone to now.
    Skip,
    /// Left for copy, with why.
    Left(String),
    Restored,
}

/// The state of a run's records.
struct Ctx<'a> {
    deps: &'a dyn RestorerDeps,
    records: Vec<DraftRecord>,
    restored: usize,
    copied: usize,
    /// Drafts whose place was not on screen and could not be gone to: still pending.
    skipped: usize,
    next: usize,
    /// A write was attempted for the draft in hand.
    wrote: bool,
}

impl Ctx<'_> {
    fn leave(&mut self, record: &DraftRecord, reason: &str) {
        // A vault that cannot be read fails a change; the other drafts go on.
        let marked = self
            .deps
            .mark(&record.id, DraftState::NeedsCopy, Some(reason))
            .is_ok();
        if marked {
            self.copied += 1;
        }
        log(
            self.deps,
            "leave",
            json!({ "id": short_id(Some(&record.id)), "reason": reason, "marked": marked }),
        );
    }

    fn end(&self, status: RestoreStatus, reason: Option<&str>) -> RestoreResult {
        if self.restored + self.copied > 0 {
            // A notification that fails changes nothing about the drafts.
            let _ = self.deps.notify(DraftCounts {
                restored: self.restored,
                left: self.copied,
            });
        }
        RestoreResult::new(
            status,
            self.restored,
            self.records.len() - self.restored,
            reason,
        )
    }

    fn records_phase(
        &mut self,
        started: i64,
        account: String,
        ready: &Ready,
        options: RestoreOptions,
    ) -> Result<Run, Fail> {
        let deps = self.deps;
        // Waiting for the UI only inspects, so it holds no lock.
        let Some(first) = ui_ready(deps)? else {
            return stop(Leaves::Pending, "not-ready");
        };
        let here = place_of(&first);
        let mut run = Run {
            account,
            pid: first.pid,
            wiped: ready.wiped,
            visits: options.visits != Some(false),
            anchored: false,
            return_to: None,
            screen: None,
            last_seen: here.clone(),
        };
        // The draft of the place on screen first: it needs no visit.
        let (mut ordered, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.records)
            .into_iter()
            .partition(|record| here.is_some() && typeable(record) == here);
        ordered.extend(rest);
        self.records = ordered;
        while self.next < self.records.len() {
            self.wrote = false;
            if deps.now() - started >= BUDGET_MS {
                return stop(Leaves::Pending, "budget");
            }
            let record = self.records[self.next].clone();
            let id = short_id(Some(&record.id));
            log(
                deps,
                "record-start",
                json!({
                    "id": id,
                    "target": short_id(record.target_alias.as_deref()),
                    "newSession": record.new_session == Some(true),
                }),
            );
            let Some(target) = typeable(&record) else {
                self.leave(&record, "manual");
                self.next += 1;
                continue;
            };
            let wrote = &mut self.wrote;
            let outcome = locked(deps, || {
                if confirm(deps, &mut run, &target)? {
                    return Ok(Outcome::Skip);
                }
                Ok(
                    match restore_one(deps, &mut run, &target, &record.text, wrote, id.clone())? {
                        Some(reason) => Outcome::Left(reason),
                        None => Outcome::Restored,
                    },
                )
            })?;
            match outcome {
                Outcome::Skip => {
                    self.skipped += 1;
                    log(
                        deps,
                        "skip",
                        json!({
                            "id": id,
                            "visits": run.visits,
                            "returnKnown": run.return_to.is_some(),
                            "screen": run.screen,
                        }),
                    );
                }
                Outcome::Left(reason) => self.leave(&record, &reason),
                Outcome::Restored => {
                    self.restored += 1;
                    // As above: the next drafts go on.
                    let removed = deps.remove(&record.id).is_ok();
                    log(deps, "restored", json!({ "id": id, "removed": removed }));
                }
            }
            self.next += 1;
        }
        Ok(run)
    }
}

/// Claude runs, and Desktop's wipe is over: its marker says it finished after Claude started,
/// or Claude has run 15 s. With `launching`, it first waits up to 10 s for Claude to run at
/// all. `None` when Claude does not run or its uptime cannot be read.
fn claude_ready(
    deps: &dyn RestorerDeps,
    launching: bool,
) -> Result<Option<Ready>, DesktopHostError> {
    let begun = deps.now();
    let mut uptime: Option<i64> = None;
    let uptime = loop {
        if deps.running()? {
            uptime = deps.uptime_ms()?;
        }
        if let Some(uptime) = uptime {
            break uptime;
        }
        if !launching || deps.now() - begun >= LAUNCH_MS {
            return Ok(None);
        }
        deps.sleep(POLL_MS)?;
    };
    let read = deps.now();
    let started_at = read - uptime;
    loop {
        let waited_ms = deps.now() - begun;
        if uptime + (deps.now() - read) >= MIN_UPTIME_MS {
            return Ok(Some(Ready {
                wiped: false,
                waited_ms,
            }));
        }
        if let Some(wiped_at) = deps.wiped_at().ok().flatten()
            && wiped_at >= started_at - WIPE_SLACK_MS
        {
            return Ok(Some(Ready {
                wiped: true,
                waited_ms,
            }));
        }
        deps.sleep(POLL_MS)?;
    }
}

/// `text.length` in UTF-16 code units, as JS counts.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Where `record` is typed: its conversation's `local_` id, or the new-session screen.
fn typeable(record: &DraftRecord) -> Option<String> {
    let text = &record.text;
    if text.is_empty() || js_length(text) > MAX_TEXT || text.contains('\0') {
        return None;
    }
    if record.new_session == Some(true) {
        return Some(NEW_SESSION.to_owned());
    }
    let alias = record.target_alias.as_deref().filter(|a| !a.is_empty())?;
    let target = format!("local_{alias}");
    is_local_session_id(&target).then_some(target)
}

/// Runs `f` under the Desktop lock. A busy lock stops the run.
fn locked<T>(deps: &dyn RestorerDeps, f: impl FnOnce() -> Result<T, Fail>) -> Result<T, Fail> {
    let mut f = Some(f);
    let mut out: Option<Result<T, Fail>> = None;
    deps.with_lock(&mut || {
        if let Some(f) = f.take() {
            out = Some(f());
        }
    })?;
    // Told apart from a busy lock by whether `f` ran at all.
    match out {
        Some(result) => result,
        None => stop(Leaves::Pending, "busy"),
    }
}

/// Under the lock, before Relay acts on `target`: same account, same Claude past its wipe,
/// and the screen showing what Relay last saw. `Ok(true)` is the TS `SKIP`: the place is not on
/// screen and the run allows no visits.
fn confirm(deps: &dyn RestorerDeps, run: &mut Run, target: &str) -> Result<bool, Fail> {
    let account = deps.current_account().ok().flatten();
    if !deps.running().unwrap_or(false) {
        return stop(Leaves::Pending, "claude-not-running");
    }
    let uptime = deps.uptime_ms().ok().flatten();
    let fresh = uptime.is_some_and(|uptime| uptime >= MIN_UPTIME_MS || run.wiped);
    if !same_account(account.as_deref(), &run.account) || !fresh {
        return stop(Leaves::Pending, "changed");
    }
    let view = match deps.automation().inspect() {
        Ok(view) => view,
        Err(error) => {
            halt_on(&error)?;
            // What the user is looking at is unknown: as good as moved.
            return stop(Leaves::Pending, "moved");
        }
    };
    if view.pid != run.pid {
        return stop(Leaves::Pending, "changed");
    }
    let place = place_of(&view);
    if !run.anchored {
        // Relay has done nothing yet, so a screen still settling is no move of the user's.
        run.anchored = true;
        run.return_to = place.clone();
        run.last_seen = place.clone();
        run.screen = view.screen.clone();
    } else if place != run.last_seen {
        return stop(Leaves::Pending, "moved");
    }
    if place.as_deref() == Some(target) {
        if !lets_type(&view) {
            return stop(Leaves::Pending, "active");
        }
        return Ok(false);
    }
    if !run.visits {
        return Ok(true);
    }
    if !lets_act(&view) {
        return stop(Leaves::Pending, "active");
    }
    Ok(false)
}

/// The first answer from Desktop's UI, every 500 ms for up to 60 s.
fn ui_ready(deps: &dyn RestorerDeps) -> Result<Option<Snapshot>, Fail> {
    let deadline = deps.now() + READY_MS;
    loop {
        if let Some(view) = look(deps)? {
            return Ok(Some(view));
        }
        if deps.now() >= deadline {
            return Ok(None);
        }
        deps.sleep(POLL_MS)?;
    }
}

/// `target` is on screen in the run's Claude, stopped, with its composer there.
fn composing(view: &Snapshot, run: &Run, target: &str) -> bool {
    place_of(view).as_deref() == Some(target)
        && view.pid == run.pid
        && view.status == SessionStatus::Stopped
        && view.composer_present == Some(true)
}

/// The guard for typing into `target`, from a view that shows it.
fn guard_for(view: &Snapshot, target: &str) -> Option<DesktopDraftGuard> {
    if target == NEW_SESSION {
        new_session_guard(view).ok().map(Into::into)
    } else {
        automation_guard(view).ok().map(Into::into)
    }
}

/// A guard from a view that shows the target. A conversation without one stops the run; the
/// new-session screen without one leaves only its draft for copy (`None`).
fn guard_of(view: &Snapshot, target: &str) -> Result<Option<DesktopDraftGuard>, Fail> {
    match guard_for(view, target) {
        Some(guard) => Ok(Some(guard)),
        None if target == NEW_SESSION => Ok(None),
        None => stop(Leaves::Copy, "unsupported"),
    }
}

/// Types one draft into its conversation's empty composer and reads it again 5 s later.
/// `Ok(Some(reason))` when it is left for copy, `Ok(None)` when restored. `wrote` tells
/// whether a write was attempted.
fn restore_one(
    deps: &dyn RestorerDeps,
    run: &mut Run,
    target: &str,
    text: &str,
    wrote: &mut bool,
    id: Option<String>,
) -> Result<Option<String>, Fail> {
    let mut seen: Option<Snapshot> = None;
    let Some(mut view) = show(deps, run, target, &mut seen)? else {
        let last = seen.as_ref();
        log(
            deps,
            "shown-timeout",
            json!({
                "id": id,
                "sessionMatches": last.is_some_and(|v| place_of(v).as_deref() == Some(target)),
                "seen": last.map_or(Value::Null, |v| place_label(place_of(v).as_deref())),
                "status": last.map(|v| v.status.as_str()),
                "composerPresent": last.and_then(|v| v.composer_present),
            }),
        );
        return Ok(Some("exact-session-not-observed".into()));
    };
    log(
        deps,
        "shown",
        json!({
            "id": id,
            "matched": shows(&view, target),
            "status": view.status.as_str(),
            "composerPresent": view.composer_present,
            "composerEmpty": view.composer_empty,
            "composerEmptyAs": view.composer_empty_as,
            "composerChars": view.composer_chars,
            "screen": view.screen,
            "panes": view.panes,
            "paneFound": view.pane_found,
            "accountLabel": view.account_label.as_deref().is_some_and(|l| !l.is_empty()),
            "permissionMode": view.permission_mode,
            "frontmost": view.frontmost,
            "idleMs": view.idle_ms,
            "guardable": guard_for(&view, target).is_some(),
            "sessionMatches": place_of(&view).as_deref() == Some(target),
        }),
    );
    run.last_seen = Some(target.to_owned());
    if matches!(view.status, SessionStatus::Running | SessionStatus::Waiting) {
        return Ok(Some("busy".into()));
    }
    // The conversation shows, but its content is still loading: the draft waits.
    if view.composer_present != Some(true)
        && view.status == SessionStatus::Unknown
        && place_of(&view).as_deref() == Some(target)
    {
        return stop(Leaves::Pending, "loading");
    }
    if view.composer_present != Some(true) || view.status != SessionStatus::Stopped {
        return Ok(Some("no-composer".into()));
    }
    if !view.composer_empty {
        return Ok(Some("composer-not-empty".into()));
    }
    // One write, and one more only when the same composer is seen there and empty again.
    let mut again = false;
    loop {
        let Some(guard) = guard_of(&view, target)? else {
            return Ok(Some(if *wrote {
                after_write("unsupported")
            } else {
                "unsupported".into()
            }));
        };
        // Before the first write only: a rewrite finishes what the first one started.
        if !*wrote {
            yield_to(deps)?;
        }
        let attempt = if again { 2 } else { 1 };
        *wrote = true;
        let written = deps.automation().write_draft(
            &guard,
            text,
            Some(WriteDraftOptions {
                keys_idle_ms: Some(QUIET_MS as f64),
            }),
        );
        match written {
            Ok(_) => log(
                deps,
                "write",
                json!({ "id": id, "ok": true, "attempt": attempt }),
            ),
            Err(error) => {
                let issue = issue_of(&error);
                log(
                    deps,
                    "write",
                    json!({ "id": id, "ok": false, "attempt": attempt, "issue": issue.as_str() }),
                );
                // Without accessibility nothing reached a composer: the draft stays retryable.
                if issue == DesktopAutomationIssue::AccessibilityPermissionRequired {
                    *wrote = false;
                }
                halt_on(&error)?;
                if issue == DesktopAutomationIssue::UserActive {
                    // Refused before anything was typed: the draft waits for the user to pause.
                    *wrote = false;
                    return stop(Leaves::Pending, "active");
                }
                // Past its guard a failed write may have typed the text: never again blindly.
                return Ok(Some(after_write(issue.as_str())));
            }
        }
        deps.sleep(RECHECK_MS)?;
        let fresh = match deps.automation().inspect() {
            Ok(fresh) => fresh,
            Err(error) => {
                log(
                    deps,
                    "recheck",
                    json!({ "id": id, "inspected": false, "issue": issue_of(&error).as_str() }),
                );
                halt_on(&error)?;
                return Ok(Some(after_write("unconfirmed")));
            }
        };
        log(
            deps,
            "recheck",
            json!({
                "id": id,
                "composerPresent": fresh.composer_present,
                "composerEmpty": fresh.composer_empty,
                "status": fresh.status.as_str(),
                "pidSame": fresh.pid == run.pid,
                "sessionMatches": place_of(&fresh).as_deref() == Some(target),
            }),
        );
        if !composing(&fresh, run, target) {
            return Ok(Some(after_write("unconfirmed")));
        }
        if !fresh.composer_empty {
            return Ok(None);
        }
        if again {
            return Ok(Some("lost".into()));
        }
        view = fresh;
        again = true;
    }
}

/// `view` shows `target` with a composer a draft can be typed into, or one that already holds
/// text, or busy.
fn shows(view: &Snapshot, target: &str) -> bool {
    place_of(view).as_deref() == Some(target)
        && ((view.composer_present == Some(true)
            && (guard_for(view, target).is_some() || !view.composer_empty))
            || matches!(view.status, SessionStatus::Running | SessionStatus::Waiting))
}

/// Waits, every 500 ms for up to 30 s, until `target` shows with a composer that can be
/// guarded, or busy, opening it (again every 5 s) only while the screen still shows the place
/// Relay last saw there, or is loading. Any other place means the user moved.
fn show(
    deps: &dyn RestorerDeps,
    run: &Run,
    target: &str,
    seen: &mut Option<Snapshot>,
) -> Result<Option<Snapshot>, Fail> {
    let deadline = deps.now() + SHOWN_MS;
    let mut opened_at: Option<i64> = None;
    // The target has been on screen: from then on only it, or loading, is waited for.
    let mut appeared = false;
    loop {
        yield_to(deps)?;
        let view = look(deps)?;
        if let Some(view) = &view {
            *seen = Some(view.clone());
        }
        let place = view.as_ref().and_then(place_of);
        if let Some(view) = view.as_ref().filter(|_| place.as_deref() == Some(target)) {
            appeared = true;
            if shows(view, target) || deps.now() >= deadline {
                return Ok(Some(view.clone()));
            }
        } else if place.is_some() && (appeared || place != run.last_seen) {
            return stop(Leaves::Pending, "moved");
        } else if deps.now() >= deadline {
            return Ok(None);
        } else if let Some(view) = view.as_ref().filter(|_| {
            // Without a view nothing says Relay may act: it looks again first.
            !appeared && opened_at.is_none_or(|at| deps.now() - at >= RESEND_MS)
        }) {
            if !lets_act(view) {
                return stop(Leaves::Pending, "active");
            }
            yield_to(deps)?;
            opened_at = Some(deps.now());
            open(deps, target)?;
            // Look again at once: Desktop may already be there.
            continue;
        }
        deps.sleep(POLL_MS)?;
    }
}

/// One inspect; `None` while Desktop cannot answer yet.
fn look(deps: &dyn RestorerDeps) -> Result<Option<Snapshot>, Fail> {
    match deps.automation().inspect() {
        Ok(view) => Ok(Some(view)),
        Err(error) => {
            halt_on(&error)?;
            Ok(None)
        }
    }
}

/// Sends the link to `place`, the helper checking right before it that the user is idle.
fn go(deps: &dyn RestorerDeps, place: &str) -> Result<(), DesktopHostError> {
    let options = Some(OpenSessionOptions {
        require_idle: Some(true),
    });
    if place == NEW_SESSION {
        deps.automation().open_new_session(options)
    } else {
        deps.automation().open_session(place, options)
    }
}

/// Opens `target`; a link that did not take is sent again.
fn open(deps: &dyn RestorerDeps, target: &str) -> Result<(), Fail> {
    if let Err(error) = go(deps, target) {
        halt_on(&error)?;
        // Nothing was opened: the drafts wait for the user to pause.
        if issue_of(&error) == DesktopAutomationIssue::UserActive {
            return stop(Leaves::Pending, "active");
        }
    }
    Ok(())
}
