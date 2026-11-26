//! Port of `tests/fleet-show.test.ts`.

use std::cell::{Cell, RefCell};

use relay_core::continuation::SessionStatus;
use relay_core::desktop_continuation_host::{
    DesktopAutomationSnapshot, DesktopHostError, SnapshotCoverage,
};
use relay_core::fleet_show::{
    CONTINUE_OPENS, CONTINUE_REOPEN_MS, CONTINUE_SHOW_MS, ShowDeps, ShowResult, ShowSkipped,
    wait_for_conversation,
};

const TARGET: &str = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER: &str = "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn view(place: &str, idle_ms: i64) -> DesktopAutomationSnapshot {
    DesktopAutomationSnapshot {
        observed_at: 1,
        pid: 1,
        local_session_id: Some(place.into()),
        new_session: None,
        account_label: Some("A".into()),
        permission_mode: Some("Auto".into()),
        status: SessionStatus::Stopped,
        quota_stopped: false,
        composer_present: None,
        composer_empty: true,
        composer_empty_as: None,
        composer_chars: None,
        screen: None,
        panes: None,
        pane_found: None,
        send_enabled: false,
        quota_auto_resume: None,
        visible_active_tasks: None,
        visible_waiting_tasks: None,
        visible_scheduled_tasks: None,
        context_fingerprint: "a".repeat(64),
        coverage: SnapshotCoverage::ActiveConversationOnly,
        frontmost: None,
        idle_ms: Some(idle_ms),
        key_idle_ms: None,
    }
}

struct Harness<F: Fn(usize, f64) -> DesktopAutomationSnapshot> {
    now: Cell<f64>,
    opens: RefCell<Vec<f64>>,
    moved_at: Cell<f64>,
    screen: F,
}

fn harness<F: Fn(usize, f64) -> DesktopAutomationSnapshot>(screen: F) -> Harness<F> {
    Harness {
        now: Cell::new(0.0),
        opens: RefCell::new(Vec::new()),
        moved_at: Cell::new(f64::INFINITY),
        screen,
    }
}

impl<F: Fn(usize, f64) -> DesktopAutomationSnapshot> ShowDeps for Harness<F> {
    fn inspect(&self) -> Result<DesktopAutomationSnapshot, DesktopHostError> {
        Ok((self.screen)(self.opens.borrow().len(), self.now.get()))
    }
    fn open(&self, _local_session_id: &str) -> Result<(), DesktopHostError> {
        self.opens.borrow_mut().push(self.now.get());
        Ok(())
    }
    fn booted(&self) -> Result<Option<bool>, DesktopHostError> {
        Ok(Some(true))
    }
    fn unchanged(&self) -> bool {
        self.now.get() < self.moved_at.get()
    }
    fn now(&self) -> f64 {
        self.now.get()
    }
    fn sleep(&self, ms: u64) {
        self.now.set(self.now.get() + ms as f64);
    }
}

fn skipped(result: &ShowResult) -> Option<ShowSkipped> {
    match result {
        ShowResult::Skipped { skipped, .. } => Some(*skipped),
        ShowResult::Shown { .. } => None,
    }
}

#[test]
fn a_conversation_that_shows_is_continued_once_the_user_is_idle_after_one_link() {
    let h = harness(|opened, _| view(if opened > 0 { TARGET } else { OTHER }, 60_000));
    let result = wait_for_conversation(TARGET, &h);
    assert!(matches!(result, ShowResult::Shown { .. }));
    assert_eq!(*h.opens.borrow(), vec![0.0]);
}

#[test]
fn links_go_at_most_three_times_30_s_apart_never_every_few_seconds() {
    // Seen 2026-10-27 in split view: the conversation never came into focus, and a link every
    // 5 s for 3 minutes reloaded Claude under the user.
    let h = harness(|_, _| view(OTHER, 60_000));
    let result = wait_for_conversation(TARGET, &h);
    assert_eq!(
        result,
        ShowResult::Skipped {
            skipped: ShowSkipped::NotShown,
            last: Some(view(OTHER, 60_000)),
            issue: None,
            opened: CONTINUE_OPENS,
        }
    );
    let opens = h.opens.borrow();
    assert_eq!(opens.len(), CONTINUE_OPENS as usize);
    for i in 1..opens.len() {
        assert!(opens[i] - opens[i - 1] >= CONTINUE_REOPEN_MS);
    }
    assert!(h.now.get() >= CONTINUE_SHOW_MS);
}

#[test]
fn while_the_user_works_in_claude_no_link_goes_and_nothing_is_taken_as_shown() {
    let busy = harness(|_, _| view(OTHER, 1_000));
    let result = wait_for_conversation(TARGET, &busy);
    assert_eq!(skipped(&result), Some(ShowSkipped::UserActive));
    assert_eq!(busy.opens.borrow().len(), 0);
    // On screen, but the user is typing: it waits for a pause.
    let shown = harness(|_, now| view(TARGET, if now < 10_000.0 { 500 } else { 9_000 }));
    assert!(matches!(
        wait_for_conversation(TARGET, &shown),
        ShowResult::Shown { .. }
    ));
    assert_eq!(shown.now.get(), 10_000.0);
}

#[test]
fn a_conversation_the_user_continued_by_hand_ends_the_wait_at_once_with_no_more_links() {
    let h = harness(|_, _| view(OTHER, 60_000));
    h.moved_at.set(10_000.0);
    let result = wait_for_conversation(TARGET, &h);
    assert_eq!(skipped(&result), Some(ShowSkipped::MovedOn));
    assert_eq!(h.opens.borrow().len(), 1);
    assert!(h.now.get() < 20_000.0);
    // Moved on before the first look: no link at all.
    let early = harness(|_, _| view(OTHER, 60_000));
    early.moved_at.set(0.0);
    let result = wait_for_conversation(TARGET, &early);
    assert!(skipped(&result).is_some());
    assert_eq!(early.opens.borrow().len(), 0);
}
