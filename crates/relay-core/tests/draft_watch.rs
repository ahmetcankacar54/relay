//! Port of `tests/draft-watch.test.ts`: the scheduler's watch, and the native watch helper.

#[path = "common/fleet_drafts.rs"]
mod helpers;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use helpers::*;
use relay_core::desktop_continuation_host::{
    DesktopAutomation, DesktopAutomationIssue, DesktopHostError,
};
use relay_core::desktop_watch::{
    DesktopWatch, DesktopWatchEnd, DesktopWatchHandlers, DesktopWatchState, WatchLine,
    parse_watch_line, unpacked_path,
};
use relay_core::draft_diagnostics::DraftLog;
use relay_core::draft_main::{
    BACKSTOP_MS, DraftScheduler, DraftSchedulerDeps, NOT_OPENED, NUDGE_MS, VISIT_MS, WATCH_MS,
};
use relay_core::draft_restorer::{
    DraftCounts, RestoreOptions, RestoreResult, RestoreStatus, RestorerDeps,
};
use relay_core::draft_vault::{DraftRecord, DraftState, DraftSummary};
use serde_json::{Value, json};

fn alias(n: u32) -> String {
    format!("{n:08}-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}
fn place(n: u32) -> String {
    format!("local_{}", alias(n))
}
const ELSEWHERE: &str = "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/// Draft n, as the panel knows it: no text, no alias.
fn draft(n: u32) -> DraftSummary {
    DraftSummary {
        title: format!("Conversation {n}"),
        ..summary(&format!("draft-{n}"))
    }
}
fn draft_with(n: u32, over: impl FnOnce(&mut DraftSummary)) -> DraftSummary {
    let mut d = draft(n);
    over(&mut d);
    d
}
/// A run that got past Claude's readiness and left the draft pending.
fn waiting(reason: &str) -> RestoreResult {
    stopped(reason)
}
/// A run that found Claude not ready.
fn not_ready() -> RestoreResult {
    result(RestoreStatus::Waiting, 0, 1)
}
fn opts(visits: bool, launching: bool) -> RestoreOptions {
    RestoreOptions {
        visits: Some(visits),
        launching: Some(launching),
    }
}

struct FakeWatch {
    handlers: Arc<dyn DesktopWatchHandlers>,
    /// Stopped by the scheduler.
    stopped: Arc<AtomicBool>,
    /// Ended on its own, as the helper exiting.
    ended: bool,
}

struct Timer {
    f: Option<Box<dyn FnOnce() + Send>>,
    ms: u64,
    cancelled: Arc<AtomicBool>,
}

enum During {
    Gate(Arc<Gate>),
    Do(Box<dyn Fn(&mut State) + Send>),
}

struct State {
    clock: i64,
    drafts: Vec<DraftSummary>,
    account: Option<String>,
    account_reads: usize,
    results: VecDeque<RestoreResult>,
    /// The options of each run, in order.
    runs: Vec<RestoreOptions>,
    marks: Vec<(String, DraftState, Option<String>)>,
    notices: Vec<DraftCounts>,
    changed: usize,
    retype: bool,
    tick: Option<Arc<dyn Fn() + Send + Sync>>,
    timers: Vec<Timer>,
    watches: Vec<FakeWatch>,
    /// Runs inside the scripted restore.
    during: Option<During>,
}

type Shared = Arc<Mutex<State>>;

struct Restorer {
    st: Shared,
    log: Arc<DraftLog>,
}

fn unused<T>() -> Result<T, DesktopHostError> {
    Err(DesktopHostError::other("unused"))
}

impl RestorerDeps for Restorer {
    fn automation(&self) -> &dyn DesktopAutomation {
        &Unused
    }
    fn pending(&self) -> Result<Vec<DraftRecord>, DesktopHostError> {
        let st = self.st.lock().unwrap();
        Ok(st
            .drafts
            .iter()
            .map(|d| {
                let n: u32 = d.id["draft-".len()..].parse().unwrap();
                DraftRecord {
                    id: d.id.clone(),
                    to: d.to.clone(),
                    target_alias: (!d.new_session).then(|| alias(n)),
                    new_session: d.new_session.then_some(true),
                    title: d.title.clone(),
                    text: "x".into(),
                    attachments: d.attachments,
                    captured_at: d.captured_at.clone(),
                    state: d.state,
                    reason: d.reason.clone(),
                }
            })
            .collect())
    }
    fn mark(
        &self,
        id: &str,
        state: DraftState,
        reason: Option<&str>,
    ) -> Result<(), DesktopHostError> {
        let mut st = self.st.lock().unwrap();
        st.marks.push((id.into(), state, reason.map(str::to_owned)));
        for d in st.drafts.iter_mut().filter(|d| d.id == id) {
            d.state = state;
            d.reason = reason.map(str::to_owned);
        }
        Ok(())
    }
    fn remove(&self, _: &str) -> Result<(), DesktopHostError> {
        unused()
    }
    fn current_account(&self) -> Result<Option<String>, DesktopHostError> {
        let mut st = self.st.lock().unwrap();
        st.account_reads += 1;
        Ok(st.account.clone())
    }
    fn running(&self) -> Result<bool, DesktopHostError> {
        unused()
    }
    fn uptime_ms(&self) -> Result<Option<i64>, DesktopHostError> {
        unused()
    }
    fn with_lock(&self, _: &mut dyn FnMut()) -> Result<bool, DesktopHostError> {
        unused()
    }
    fn yielding(&self) -> bool {
        false
    }
    fn notify(&self, summary: DraftCounts) -> Result<(), DesktopHostError> {
        self.st.lock().unwrap().notices.push(summary);
        Ok(())
    }
    fn sleep(&self, _: u64) -> Result<(), DesktopHostError> {
        Ok(())
    }
    fn now(&self) -> i64 {
        self.st.lock().unwrap().clock
    }
    fn log(&self) -> Option<&DraftLog> {
        Some(&*self.log)
    }
}

struct FakeHandle(Arc<AtomicBool>);

impl DesktopWatch for FakeHandle {
    fn stop(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

/// A scheduler over fake drafts, a scripted restore that records the options of each run, a
/// fake 10 s timer, fake one-shot timers and fake watches.
struct H {
    scheduler: Arc<DraftScheduler>,
    st: Shared,
    logs: Logs,
    gates: Mutex<Vec<Arc<Gate>>>,
}

fn harness(drafts: Vec<DraftSummary>) -> H {
    let st: Shared = Arc::new(Mutex::new(State {
        clock: 0,
        drafts,
        account: Some(ACCOUNT.into()),
        account_reads: 0,
        results: VecDeque::new(),
        runs: Vec::new(),
        marks: Vec::new(),
        notices: Vec::new(),
        changed: 0,
        retype: true,
        tick: None,
        timers: Vec::new(),
        watches: Vec::new(),
        during: None,
    }));
    let (logs, log) = log_sink();
    let restorer = Arc::new(Restorer {
        st: Arc::clone(&st),
        log,
    });
    let (a, b, c, d, e, f) = (
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
        Arc::clone(&st),
    );
    let g = Arc::clone(&st);
    let mut deps = DraftSchedulerDeps::new(
        restorer,
        Box::new(move || Ok(a.lock().unwrap().drafts.clone())),
        Box::new(move || {
            b.lock().unwrap().changed += 1;
            Ok(())
        }),
        Box::new(move || c.lock().unwrap().retype),
    );
    deps.restore = Some(Box::new(move |deps, options| {
        d.lock().unwrap().runs.push(options);
        let _ = deps.current_account();
        let gate = {
            let mut st = d.lock().unwrap();
            match st.during.take() {
                Some(During::Gate(gate)) => {
                    st.during = Some(During::Gate(Arc::clone(&gate)));
                    Some(gate)
                }
                Some(During::Do(f)) => {
                    f(&mut st);
                    st.during = Some(During::Do(f));
                    None
                }
                None => None,
            }
        };
        if let Some(gate) = gate {
            gate.wait();
        }
        let next = d.lock().unwrap().results.pop_front();
        Ok(next.unwrap_or_else(|| waiting("elsewhere")))
    }));
    deps.every = Some(Box::new(move |tick, _ms| {
        e.lock().unwrap().tick = Some(Arc::from(tick));
        let e = Arc::clone(&e);
        Box::new(move || e.lock().unwrap().tick = None)
    }));
    deps.later = Some(Box::new(move |fire, ms| {
        let cancelled = flag();
        f.lock().unwrap().timers.push(Timer {
            f: Some(fire),
            ms,
            cancelled: Arc::clone(&cancelled),
        });
        Box::new(move || cancelled.store(true, Ordering::SeqCst))
    }));
    deps.watch = Some(Arc::new(move |handlers| {
        let stopped = flag();
        g.lock().unwrap().watches.push(FakeWatch {
            handlers,
            stopped: Arc::clone(&stopped),
            ended: false,
        });
        Ok(Box::new(FakeHandle(stopped)) as Box<dyn DesktopWatch>)
    }));
    H {
        scheduler: DraftScheduler::new(deps),
        st,
        logs,
        gates: Mutex::default(),
    }
}

impl H {
    fn st(&self) -> MutexGuard<'_, State> {
        self.st.lock().unwrap()
    }
    fn set_clock(&self, ms: i64) {
        self.st().clock = ms;
    }
    fn push(&self, result: RestoreResult) {
        self.st().results.push_back(result);
    }
    fn runs(&self) -> Vec<RestoreOptions> {
        self.st().runs.clone()
    }
    fn logs(&self) -> Vec<Value> {
        self.logs.lock().unwrap().clone()
    }
    /// A gate the next runs wait at.
    fn hold(&self) -> Arc<Gate> {
        let gate = Gate::new();
        self.gates.lock().unwrap().push(Arc::clone(&gate));
        self.st().during = Some(During::Gate(Arc::clone(&gate)));
        gate
    }
    fn settle(&self) {
        settle(&self.scheduler, &self.gates.lock().unwrap());
    }
    fn watches(&self) -> usize {
        self.st().watches.len()
    }
    fn live(&self) -> usize {
        self.st()
            .watches
            .iter()
            .filter(|w| !is_set(&w.stopped) && !w.ended)
            .count()
    }
    fn stopped(&self, i: usize) -> bool {
        is_set(&self.st().watches[i].stopped)
    }
    /// The live watch ends on its own, for `reason`.
    fn end(&self, reason: DesktopWatchEnd) {
        let handlers = {
            let mut st = self.st();
            let mut live: Vec<&mut FakeWatch> = st
                .watches
                .iter_mut()
                .filter(|w| !is_set(&w.stopped) && !w.ended)
                .collect();
            assert_eq!(live.len(), 1, "one watch is on");
            live[0].ended = true;
            Arc::clone(&live[0].handlers)
        };
        handlers.end(reason);
    }
    /// The live watch reports: by default Claude in front, keys quiet, not idle.
    fn report(&self, over: impl FnOnce(&mut DesktopWatchState)) {
        let handlers = {
            let st = self.st();
            let live: Vec<&FakeWatch> = st
                .watches
                .iter()
                .filter(|w| !is_set(&w.stopped) && !w.ended)
                .collect();
            assert_eq!(live.len(), 1, "one watch is on");
            Arc::clone(&live[0].handlers)
        };
        let mut state = DesktopWatchState {
            pid: 456,
            place: None,
            frontmost: true,
            quiet: true,
            idle: false,
        };
        over(&mut state);
        handlers.state(state);
        self.settle();
    }
    /// Fires the one-shot timers not cancelled.
    fn fire(&self) {
        let due: Vec<Timer> = std::mem::take(&mut self.st().timers);
        for mut timer in due {
            if !is_set(&timer.cancelled)
                && let Some(f) = timer.f.take()
            {
                f();
            }
        }
        self.settle();
    }
    fn timer_ms(&self, live_only: bool) -> Vec<u64> {
        self.st()
            .timers
            .iter()
            .filter(|t| !live_only || !is_set(&t.cancelled))
            .map(|t| t.ms)
            .collect()
    }
    /// The armed 10 s timer fires.
    fn fire_tick(&self) {
        let tick = self.st().tick.clone().expect("a timer is armed");
        tick();
        self.settle();
    }
}

fn place_at(p: &str) -> impl FnOnce(&mut DesktopWatchState) + '_ {
    move |s| s.place = Some(p.to_owned())
}

#[test]
fn a_run_that_finds_claude_ready_starts_one_watch_for_the_places_of_the_accounts_pending_drafts() {
    let h = harness(vec![
        draft(1),
        draft_with(2, |d| d.new_session = true),
        draft_with(3, |d| d.to = OTHER.into()),
        draft_with(4, |d| {
            d.state = DraftState::NeedsCopy;
            d.reason = Some("manual".into());
        }),
    ]);
    // Not ready yet: no watch.
    h.push(not_ready());
    h.scheduler.after_switch();
    assert_eq!(h.watches(), 0);
    // Ready: one watch, looking for draft 1's conversation and the new-session screen.
    h.scheduler.tick();
    assert_eq!(h.live(), 1);
    assert_eq!(
        h.logs().into_iter().find(|e| e["event"] == "watch-start"),
        Some(json!({ "event": "watch-start", "places": 2 }))
    );
    // More runs keep the one watch.
    h.set_clock(10_000);
    h.scheduler.tick();
    h.scheduler.tick();
    assert_eq!(h.watches(), 1);
    // Drafts for another account only: none.
    let other = harness(vec![draft_with(1, |d| d.to = OTHER.into())]);
    other.scheduler.after_switch();
    other.scheduler.tick();
    assert_eq!(other.watches(), 0);
}

#[test]
fn the_watch_starts_a_run_when_a_drafts_place_is_on_screen_with_claude_in_front_and_no_key_for_1_s()
{
    let h = harness(vec![draft(1)]);
    h.scheduler.after_switch();
    assert_eq!(h.runs().len(), 1);
    h.set_clock(5_000);
    // Not its place, a key just pressed, or Claude behind: nothing.
    h.report(place_at(ELSEWHERE));
    h.report(|s| {
        s.place = Some(place(1));
        s.quiet = false;
    });
    h.report(|s| {
        s.place = Some(place(1));
        s.frontmost = false;
    });
    h.report(|_| {});
    assert_eq!(h.runs().len(), 1);
    // Its place, quiet keys, Claude in front: a run, which may still take the user elsewhere.
    h.report(place_at(&place(1)));
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.runs()[1], opts(true, false));
    // The new-session screen is a place too.
    let fresh = harness(vec![draft_with(7, |d| d.new_session = true)]);
    fresh.scheduler.after_switch();
    fresh.set_clock(5_000);
    fresh.report(place_at("new-session"));
    assert_eq!(fresh.runs().len(), 2);
}

#[test]
fn an_idle_user_in_front_starts_a_run_while_visits_are_allowed_after_2_minutes_only_the_drafts_place_does()
 {
    let h = harness(vec![draft(1)]);
    h.scheduler.after_switch();
    h.set_clock(30_000);
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.idle = true;
    });
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.runs()[1].visits, Some(true));
    // An idle user behind Claude is no reason.
    h.set_clock(40_000);
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.idle = true;
        s.frontmost = false;
    });
    assert_eq!(h.runs().len(), 2);
    // The visit window closes 2 minutes after the first ready run.
    h.set_clock(VISIT_MS);
    h.report(place_at(ELSEWHERE));
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.idle = true;
    });
    assert_eq!(h.runs().len(), 2);
    h.report(|s| {
        s.place = Some(place(1));
        s.idle = true;
    });
    assert_eq!(h.runs().len(), 3);
    assert_eq!(h.runs()[2].visits, Some(false));
    // A 10 s retry after it allows no visit either.
    h.set_clock(VISIT_MS + 10_000);
    h.fire_tick();
    assert_eq!(h.runs().len(), 4);
    assert_eq!(h.runs()[3].visits, Some(false));
}

#[test]
fn a_report_just_after_a_run_waits_until_1_s_after_it_one_during_a_run_is_weighed_once_it_ends() {
    let h = harness(vec![draft(1)]);
    h.scheduler.after_switch();
    // 200 ms after the run: a timer for the 800 ms left, then the run.
    h.set_clock(200);
    h.report(place_at(&place(1)));
    assert_eq!(h.runs().len(), 1);
    assert_eq!(h.timer_ms(false), vec![(NUDGE_MS - 200) as u64]);
    // Two reports meanwhile set one timer.
    h.report(|s| {
        s.place = Some(place(1));
        s.idle = true;
    });
    assert_eq!(h.st().timers.len(), 1);
    h.set_clock(NUDGE_MS);
    h.fire();
    assert_eq!(h.runs().len(), 2);
    // The timer finds the report no longer says go: nothing.
    h.set_clock(1_100);
    h.report(place_at(&place(1)));
    h.report(|s| {
        s.place = Some(place(1));
        s.quiet = false;
    });
    h.set_clock(3_000);
    h.fire();
    assert_eq!(h.runs().len(), 2);
    // A report while a run is in flight starts nothing alongside it, and is weighed after it.
    let gate = h.hold();
    h.set_clock(10_000);
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.idle = true;
    });
    assert_eq!(h.runs().len(), 3);
    h.report(place_at(&place(1)));
    assert_eq!(h.runs().len(), 3);
    h.st().during = None;
    h.set_clock(12_000);
    gate.open();
    h.settle();
    assert_eq!(h.runs().len(), 3);
    assert_eq!(h.timer_ms(true), vec![NUDGE_MS as u64]);
    h.set_clock(13_000);
    h.fire();
    assert_eq!(h.runs().len(), 4);
}

#[test]
fn with_a_watch_on_a_10_s_retry_runs_only_while_the_watch_says_go_and_otherwise_reads_the_account_alone()
 {
    let h = harness(vec![draft(1)]);
    h.scheduler.after_switch();
    h.set_clock(10_000);
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.frontmost = false;
    });
    let reads = h.st().account_reads;
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 1);
    assert_eq!(h.st().account_reads, reads + 1);
    // The watch says go and its run stopped busy: the retry tries again.
    h.push(waiting("busy"));
    h.report(place_at(&place(1)));
    assert_eq!(h.runs().len(), 2);
    h.set_clock(20_000);
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 3);
    // Desktop on another account: the retry runs.
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.frontmost = false;
    });
    h.set_clock(30_000);
    h.st().account = Some(OTHER.into());
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 4);
    // That run found no draft for Desktop's account: the watch ends.
    assert_eq!(h.live(), 0);
}

#[test]
fn with_a_watch_on_a_10_s_retry_still_runs_a_minute_after_the_last_run_in_case_the_watch_missed_the_place()
 {
    let h = harness(vec![draft(1)]);
    h.scheduler.after_switch();
    h.report(|s| {
        s.place = Some(ELSEWHERE.into());
        s.frontmost = false;
    });
    h.set_clock(BACKSTOP_MS - 1);
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 1);
    h.set_clock(BACKSTOP_MS);
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 2);
    // Counted from that run.
    h.set_clock(2 * BACKSTOP_MS - 1);
    h.scheduler.tick();
    assert_eq!(h.runs().len(), 2);
}

#[test]
fn a_run_begun_before_a_switch_opens_no_window_for_the_claude_the_switch_started() {
    let h = Arc::new(harness(vec![draft(1)]));
    let gate = h.hold();
    // A retry is in flight when the switch comes.
    let first = {
        let h = Arc::clone(&h);
        std::thread::spawn(move || h.scheduler.tick())
    };
    wait_until("the retry to wait", || gate.blocked());
    h.set_clock(50_000);
    let switched = {
        let h = Arc::clone(&h);
        std::thread::spawn(move || h.scheduler.after_switch())
    };
    flush();
    h.st().during = None;
    gate.open();
    first.join().unwrap();
    switched.join().unwrap();
    assert_eq!(h.runs().len(), 2);
    assert_eq!(h.runs()[1], opts(true, true));
    // The windows date from the run after the switch: visits until 2 minutes after it.
    h.set_clock(50_000 + VISIT_MS - 1);
    h.end(DesktopWatchEnd::Gone);
    h.scheduler.tick();
    assert_eq!(h.runs()[2].visits, Some(true));
}

#[test]
fn the_watch_ends_with_the_drafts_re_typing_a_switch_and_stop_its_own_end_lets_the_retries_look_again()
 {
    // The draft is restored.
    let done = harness(vec![draft(1)]);
    done.scheduler.after_switch();
    assert_eq!(done.live(), 1);
    done.st().during = Some(During::Do(Box::new(|st| st.drafts.clear())));
    done.push(result(RestoreStatus::Done, 1, 0));
    done.set_clock(10_000);
    done.report(place_at(&place(1)));
    assert_eq!(done.runs().len(), 2);
    assert_eq!(done.live(), 0);
    assert!(done.stopped(0));
    // Re-typing turned off.
    let off = harness(vec![draft(1)]);
    off.scheduler.after_switch();
    off.st().retype = false;
    off.scheduler.retype_changed();
    assert_eq!(off.live(), 0);
    assert_eq!(
        off.st().marks,
        vec![(
            "draft-1".into(),
            DraftState::NeedsCopy,
            Some("manual".into())
        )]
    );
    // A switch: a new Claude, and the run after it starts a new watch.
    let switched = harness(vec![draft(1)]);
    switched.scheduler.after_switch();
    switched.scheduler.after_switch();
    assert_eq!(switched.watches(), 2);
    assert!(switched.stopped(0));
    assert_eq!(switched.live(), 1);
    // stop.
    switched.scheduler.stop();
    assert_eq!(switched.live(), 0);
    // Claude quit: the watch ends, and the retries run as without one.
    let gone = harness(vec![draft(1)]);
    gone.scheduler.after_switch();
    gone.end(DesktopWatchEnd::Gone);
    assert_eq!(
        gone.logs().last(),
        Some(&json!({ "event": "watch-end", "reason": "gone" }))
    );
    gone.push(not_ready());
    gone.set_clock(10_000);
    gone.scheduler.tick();
    assert_eq!(gone.runs().len(), 2);
    assert_eq!(gone.watches(), 1);
    // The helper's own 10 minutes: a new watch at once.
    let expired = harness(vec![draft(1)]);
    expired.scheduler.after_switch();
    expired.end(DesktopWatchEnd::Expired);
    assert_eq!(expired.live(), 1);
    assert_eq!(expired.watches(), 2);
    // A report from a watch that ended is ignored.
    let first = Arc::clone(&expired.st().watches[0].handlers);
    first.state(DesktopWatchState {
        pid: 456,
        place: Some(place(1)),
        frontmost: true,
        quiet: true,
        idle: true,
    });
    expired.settle();
    assert_eq!(expired.runs().len(), 1);
}

#[test]
fn _30_minutes_after_claude_was_ready_the_accounts_drafts_still_pending_are_left_for_copy_as_not_opened()
 {
    let h = harness(vec![
        draft(1),
        draft(2),
        draft_with(3, |d| d.to = OTHER.into()),
    ]);
    h.scheduler.after_switch();
    assert_eq!(h.live(), 1);
    h.set_clock(WATCH_MS - 1);
    h.scheduler.tick();
    assert!(h.st().marks.is_empty());
    h.set_clock(WATCH_MS);
    h.push(result(RestoreStatus::Idle, 0, 0));
    h.scheduler.tick();
    assert_eq!(
        h.st().marks,
        vec![
            (
                "draft-1".into(),
                DraftState::NeedsCopy,
                Some(NOT_OPENED.into())
            ),
            (
                "draft-2".into(),
                DraftState::NeedsCopy,
                Some(NOT_OPENED.into())
            ),
        ]
    );
    assert_eq!(
        h.st().notices,
        vec![DraftCounts {
            restored: 0,
            left: 2
        }]
    );
    assert!(h.st().changed >= 1);
    assert_eq!(h.live(), 0);
    assert!(
        h.logs()
            .iter()
            .any(|e| e["event"] == "watch-over" && e["left"] == 2)
    );
    // Desktop on another account when the window ends: its drafts wait for it.
    let away = harness(vec![draft(1)]);
    away.scheduler.after_switch();
    away.st().account = Some(OTHER.into());
    away.set_clock(WATCH_MS);
    away.scheduler.tick();
    assert!(away.st().marks.is_empty());
    // A switch opens the windows again.
    let again = harness(vec![draft(1)]);
    again.scheduler.after_switch();
    again.set_clock(WATCH_MS - 1_000);
    again.scheduler.after_switch();
    again.set_clock(WATCH_MS);
    again.scheduler.tick();
    assert!(again.st().marks.is_empty());
    assert_eq!(again.runs().last().unwrap().visits, Some(true));
}

#[test]
fn the_run_after_a_switch_waits_for_claude_to_start_the_windows_open_at_the_first_ready_run() {
    let h = harness(vec![draft(1)]);
    h.push(not_ready());
    h.scheduler.after_switch();
    assert_eq!(h.runs()[0], opts(true, true));
    // Not ready yet: the windows have not opened.
    h.set_clock(VISIT_MS + 5_000);
    h.scheduler.tick();
    assert_eq!(h.runs()[1], opts(true, false));
    // Ready from that run on: visits until 2 minutes after it.
    h.set_clock(2 * VISIT_MS + 4_999);
    h.end(DesktopWatchEnd::Gone);
    h.scheduler.tick();
    assert_eq!(h.runs()[2].visits, Some(true));
    h.set_clock(2 * VISIT_MS + 5_000);
    h.end(DesktopWatchEnd::Gone);
    h.scheduler.tick();
    assert_eq!(h.runs()[3].visits, Some(false));
}

#[test]
fn the_helpers_watch_lines_are_read_strictly() {
    let id = place(1);
    let state = |place: Option<&str>, frontmost, quiet, idle| {
        Some(WatchLine::State(DesktopWatchState {
            pid: 4,
            place: place.map(str::to_owned),
            frontmost,
            quiet,
            idle,
        }))
    };
    assert_eq!(
        parse_watch_line(
            &json!({ "pid": 4, "place": id, "frontmost": true, "quiet": false, "idle": true })
                .to_string()
        ),
        state(Some(&id), true, false, true)
    );
    assert_eq!(
        parse_watch_line(
            &json!({ "pid": 4, "place": null, "frontmost": false, "quiet": true, "idle": true })
                .to_string()
        ),
        state(None, false, true, true)
    );
    assert_eq!(
        parse_watch_line(
            &json!({ "pid": 4, "place": "new-session", "frontmost": true, "quiet": true, "idle": false })
                .to_string()
        ),
        state(Some("new-session"), true, true, false)
    );
    assert_eq!(
        parse_watch_line(r#"{"gone":true}"#),
        Some(WatchLine::End(DesktopWatchEnd::Gone))
    );
    assert_eq!(
        parse_watch_line(r#"{"expired":true}"#),
        Some(WatchLine::End(DesktopWatchEnd::Expired))
    );
    assert_eq!(
        parse_watch_line(r#"{"issue":"accessibility-permission-required"}"#),
        Some(WatchLine::End(DesktopWatchEnd::Issue(
            DesktopAutomationIssue::AccessibilityPermissionRequired
        )))
    );
    assert_eq!(
        parse_watch_line(r#"{"issue":"made-up"}"#),
        Some(WatchLine::End(DesktopWatchEnd::Issue(
            DesktopAutomationIssue::DesktopUiUnsupported
        )))
    );
    let pad = "x".repeat(5000);
    for line in [
        String::new(),
        "not json".into(),
        "[]".into(),
        "null".into(),
        json!({ "pid": 0, "place": null, "frontmost": true, "quiet": true, "idle": true })
            .to_string(),
        json!({ "pid": 4, "place": "local_nope", "frontmost": true, "quiet": true, "idle": true })
            .to_string(),
        json!({ "pid": 4, "place": "https://claude.ai", "frontmost": true, "quiet": true, "idle": true })
            .to_string(),
        json!({ "pid": 4, "place": null, "frontmost": "yes", "quiet": true, "idle": true })
            .to_string(),
        json!({ "pid": 4, "place": null, "frontmost": true, "idle": true }).to_string(),
        format!(
            r#"{{"pid":4,"place":null,"frontmost":true,"quiet":true,"idle":true,"pad":"{pad}"}}"#
        ),
    ] {
        assert_eq!(
            parse_watch_line(&line),
            None,
            "{}",
            line.chars().take(60).collect::<String>()
        );
    }
}

/// Handlers that keep what a native watch said.
#[cfg(unix)]
#[derive(Default)]
struct Kept {
    states: Mutex<Vec<DesktopWatchState>>,
    ends: Mutex<Vec<DesktopWatchEnd>>,
}

#[cfg(unix)]
impl DesktopWatchHandlers for Kept {
    fn state(&self, state: DesktopWatchState) {
        self.states.lock().unwrap().push(state);
    }
    fn end(&self, reason: DesktopWatchEnd) {
        self.ends.lock().unwrap().push(reason);
    }
}

#[cfg(unix)]
fn script(path: &std::path::Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
fn ended(kept: &Kept) -> DesktopWatchEnd {
    wait_until("the watch to end", || !kept.ends.lock().unwrap().is_empty());
    kept.ends.lock().unwrap()[0]
}

// The helper is a macOS accessibility tool; its stand-in here is a shell script.
#[cfg(unix)]
#[test]
fn the_native_watch_runs_the_helper_with_its_times_passes_its_states_on_and_ends_once() {
    use relay_core::desktop_watch::native_desktop_watch;
    let scratch = tempfile::Builder::new()
        .prefix("relay-watch-")
        .tempdir()
        .unwrap();
    let helper = scratch.path().join("helper");
    let args_file = scratch.path().join("args");
    // A stand-in helper: it notes its arguments, reports two states and a bad line, then
    // Claude quitting.
    script(
        &helper,
        &[
            "#!/bin/sh".to_owned(),
            format!("echo \"$@\" > '{}'", args_file.display()),
            r#"echo '{"pid":9,"place":null,"frontmost":false,"quiet":true,"idle":false}'"#.into(),
            "echo 'garbage'".into(),
            format!(
                r#"echo '{{"pid":9,"place":"{}","frontmost":true,"quiet":true,"idle":true}}'"#,
                place(1)
            ),
            r#"echo '{"gone":true}'"#.into(),
        ]
        .join("\n"),
    );
    let kept = Arc::new(Kept::default());
    let _watch = native_desktop_watch(&helper, 1_000, 3_000, None)(kept.clone()).unwrap();
    assert_eq!(ended(&kept), DesktopWatchEnd::Gone);
    // The exit comes after the last line: still one end.
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert_eq!(
        std::fs::read_to_string(&args_file).unwrap().trim(),
        "watch 1000 3000"
    );
    assert_eq!(
        *kept.states.lock().unwrap(),
        vec![
            DesktopWatchState {
                pid: 9,
                place: None,
                frontmost: false,
                quiet: true,
                idle: false
            },
            DesktopWatchState {
                pid: 9,
                place: Some(place(1)),
                frontmost: true,
                quiet: true,
                idle: true
            },
        ]
    );
    assert_eq!(*kept.ends.lock().unwrap(), vec![DesktopWatchEnd::Gone]);
    // A helper that keeps running until stopped: stop ends it, and says nothing.
    let waiter = scratch.path().join("waiter");
    script(&waiter, "#!/bin/sh\ncat > /dev/null\n");
    let stop_kept = Arc::new(Kept::default());
    let watch = native_desktop_watch(&waiter, 1_000, 3_000, None)(stop_kept.clone()).unwrap();
    watch.stop();
    std::thread::sleep(std::time::Duration::from_millis(100));
    assert!(stop_kept.ends.lock().unwrap().is_empty());
    // A helper that is not there ends the watch as unsupported.
    let missing = Arc::new(Kept::default());
    let _watch =
        native_desktop_watch(scratch.path().join("absent"), 1_000, 3_000, None)(missing.clone())
            .unwrap();
    assert_eq!(
        ended(&missing),
        DesktopWatchEnd::Issue(DesktopAutomationIssue::DesktopUiUnsupported)
    );
    // Packaged, the helper is named inside app.asar, a file to spawn: it runs from the unpacked
    // copy beside it.
    std::fs::write(scratch.path().join("app.asar"), "archive").unwrap();
    let unpacked = scratch
        .path()
        .join("app.asar.unpacked")
        .join("dist-electron");
    std::fs::create_dir_all(&unpacked).unwrap();
    script(
        &unpacked.join("desktop-automation"),
        "#!/bin/sh\necho '{\"gone\":true}'\n",
    );
    let archived = Arc::new(Kept::default());
    let _watch = native_desktop_watch(
        scratch
            .path()
            .join("app.asar")
            .join("dist-electron")
            .join("desktop-automation"),
        1_000,
        3_000,
        None,
    )(archived.clone())
    .unwrap();
    assert_eq!(ended(&archived), DesktopWatchEnd::Gone);
}

#[test]
fn a_path_inside_app_asar_is_its_unpacked_copy_any_other_path_stays_as_it_is() {
    assert_eq!(
        unpacked_path(
            "/Applications/Relay.app/Contents/Resources/app.asar/dist-electron/desktop-automation"
        ),
        "/Applications/Relay.app/Contents/Resources/app.asar.unpacked/dist-electron/desktop-automation",
    );
    for same in [
        "/Applications/Relay.app/Contents/Resources/app.asar.unpacked/dist-electron/desktop-automation",
        "/Users/me/cc-switch/dist-electron/desktop-automation",
        "/Users/me/app.asar.d/helper",
    ] {
        assert_eq!(unpacked_path(same), same);
    }
}
