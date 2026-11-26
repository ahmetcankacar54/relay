//! Port of tests/tray-menu-lifecycle.test.ts.

use relay_core::tray_menu_lifecycle::{TrayMenuHost, TrayMenuLifecycle};

const EXPECTED: &str = "native install unavailable";

#[derive(Default)]
struct Host {
    applied: Vec<(String, u64)>,
    scheduled: Vec<u64>,
    errors: Vec<&'static str>,
    /// The value whose install fails.
    bad: Option<&'static str>,
}

impl TrayMenuHost<String> for Host {
    type Error = &'static str;
    fn apply(&mut self, value: String, generation: u64) -> Result<(), Self::Error> {
        if Some(value.as_str()) == self.bad {
            return Err(EXPECTED);
        }
        self.applied.push((value, generation));
        Ok(())
    }
    fn schedule(&mut self, generation: u64) {
        self.scheduled.push(generation);
    }
    fn on_apply_error(&mut self, error: Self::Error) {
        self.errors.push(error);
    }
}

struct Fixture {
    lifecycle: TrayMenuLifecycle<String, Host>,
}

fn fixture() -> Fixture {
    Fixture {
        lifecycle: TrayMenuLifecycle::new(Host::default()),
    }
}

impl Fixture {
    fn update(&mut self, value: &str) {
        self.lifecycle.update(value.to_string(), value).unwrap();
    }
    fn flush(&mut self) {
        let callbacks = std::mem::take(&mut self.lifecycle.host_mut().scheduled);
        for generation in callbacks {
            self.lifecycle.run_scheduled(generation);
        }
    }
    fn applied(&self) -> &[(String, u64)] {
        &self.lifecycle.host().applied
    }
    fn values(&self) -> Vec<&str> {
        self.applied().iter().map(|(v, _)| v.as_str()).collect()
    }
    fn current(&self) -> u64 {
        self.applied().last().unwrap().1
    }
    fn last(&self) -> &str {
        &self.applied().last().unwrap().0
    }
}

#[test]
fn unchanged_polls_retain_the_same_native_menu_before_and_during_tracking() {
    let mut f = fixture();
    f.update("A");
    for _ in 0..20 {
        f.update("A");
    }
    let generation = f.current();
    f.lifecycle.opened(generation);
    for _ in 0..20 {
        f.update("A");
    }
    assert_eq!(f.applied(), [("A".to_string(), generation)]);
    f.lifecycle.closed(generation);
    f.flush();
    assert_eq!(f.applied().len(), 1);
}

#[test]
fn an_open_menu_defers_replacements_and_applies_only_the_newest_poll_after_close() {
    let mut f = fixture();
    f.update("A");
    let generation = f.current();
    f.lifecycle.opened(generation);
    f.update("B");
    f.update("C");
    assert_eq!(f.applied().len(), 1);
    f.lifecycle.closed(generation);
    assert_eq!(
        f.applied().len(),
        1,
        "never replace inside the close callback"
    );
    f.update("D");
    assert_eq!(
        f.applied().len(),
        1,
        "another close listener must also defer"
    );
    f.flush();
    assert_eq!(f.values(), ["A", "D"]);
}

#[test]
fn the_latest_poll_reverting_to_current_content_clears_an_older_pending_change() {
    let mut f = fixture();
    f.update("A");
    let generation = f.current();
    f.lifecycle.opened(generation);
    f.update("B");
    f.update("A");
    f.lifecycle.closed(generation);
    f.flush();
    assert_eq!(f.values(), ["A"]);
}

#[test]
fn a_changed_poll_arriving_after_close_still_waits_for_the_next_event_loop_turn() {
    let mut f = fixture();
    f.update("A");
    f.lifecycle.opened(f.current());
    f.lifecycle.closed(f.current());
    f.update("B");
    assert_eq!(f.applied().len(), 1);
    f.flush();
    assert_eq!(f.values(), ["A", "B"]);
}

#[test]
fn callbacks_from_replaced_menus_cannot_defer_or_flush_the_current_menu() {
    let mut f = fixture();
    f.update("A");
    let old = f.current();
    f.update("B");
    let current = f.current();
    f.lifecycle.opened(old);
    f.lifecycle.closed(old);
    f.update("C");
    assert_eq!(f.values(), ["A", "B", "C"]);
    f.lifecycle.opened(f.current());
    f.update("D");
    f.lifecycle.closed(current);
    f.flush();
    assert_eq!(f.last(), "C");
    f.lifecycle.closed(f.current());
    f.flush();
    assert_eq!(f.last(), "D");
}

#[test]
fn reopening_before_a_scheduled_replacement_keeps_it_pending_until_the_next_close() {
    let mut f = fixture();
    f.update("A");
    let generation = f.current();
    f.lifecycle.opened(generation);
    f.update("B");
    f.lifecycle.closed(generation);
    f.lifecycle.opened(generation);
    f.flush();
    assert_eq!(f.applied().len(), 1);
    f.update("C");
    f.lifecycle.closed(generation);
    f.flush();
    assert_eq!(f.values(), ["A", "C"]);
}

#[test]
fn destruction_invalidates_queued_replacements_and_late_native_callbacks() {
    let mut f = fixture();
    f.update("A");
    let generation = f.current();
    f.lifecycle.opened(generation);
    f.update("B");
    f.lifecycle.closed(generation);
    f.lifecycle.destroy();
    f.lifecycle.opened(generation);
    f.lifecycle.closed(generation);
    f.update("C");
    f.flush();
    assert_eq!(f.values(), ["A"]);
}

#[test]
fn snapshot_error_fallback_is_deferred_deduplicated_and_superseded_by_recovery() {
    let mut f = fixture();
    let fallback = "fallback: only open and quit";
    f.update("ready");
    f.lifecycle.opened(f.current());
    f.update(fallback);
    f.update(fallback);
    assert_eq!(f.applied().len(), 1);
    f.lifecycle.closed(f.current());
    f.flush();
    assert_eq!(f.last(), fallback);
    f.lifecycle.opened(f.current());
    f.update(fallback);
    f.update("recovered");
    f.lifecycle.closed(f.current());
    f.flush();
    assert_eq!(f.values(), ["ready", fallback, "recovered"]);
}

#[test]
fn a_failed_native_install_retains_current_identity_and_reports_deferred_errors() {
    let mut lifecycle = TrayMenuLifecycle::new(Host {
        bad: Some("bad"),
        ..Host::default()
    });
    lifecycle.update("A".into(), "A").unwrap();
    let generation = lifecycle.host().applied[0].1;
    assert_eq!(lifecycle.update("bad".into(), "bad"), Err(EXPECTED));
    lifecycle.opened(generation);
    lifecycle.update("bad".into(), "bad").unwrap();
    lifecycle.closed(generation);
    for generation in std::mem::take(&mut lifecycle.host_mut().scheduled) {
        lifecycle.run_scheduled(generation);
    }
    assert_eq!(lifecycle.host().errors, [EXPECTED]);
    lifecycle.update("A".into(), "A").unwrap();
    assert_eq!(lifecycle.host().applied.len(), 1);
    lifecycle.update("recovered".into(), "recovered").unwrap();
    assert_eq!(lifecycle.host().applied.last().unwrap().0, "recovered");
}
