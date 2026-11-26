//! Port of tests/fleet-continuation.test.ts.

#[path = "common/fleet_evidence.rs"]
mod helpers;

use std::collections::HashSet;
use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use helpers::{
    Clock, FleetSetup, Recorder, desktop_state, enroll, fleet_account, fleet_now, fleet_setup,
    fleet_usage, lock, stop, usage_checked,
};
use relay_core::desktop::{DesktopError, desktop_switch_refused};
use relay_core::desktop_continuation::DesktopContinuationContext;
use relay_core::desktop_continuation_evidence::{BackgroundCommand, BackgroundStopResult};
use relay_core::fleet_continuation::{
    BACKGROUND_WAIT_MS, FleetContinuation, FleetDeps, HANDOFF_MS, LogFn, fleet_notice,
    source_exhausted as fleet_source_exhausted,
};
use relay_core::shared::types::js::iso;
use relay_core::shared::types::{
    AccountUsage, FleetContinuationState, FleetLast, FleetStatus, UsageWindow, default_settings,
};
use relay_core::shared::usage::{SOURCE_FRESH_MS, source_exhausted};
use relay_core::transcript_scan::TurnTrigger;
use relay_i18n::Locale;
use serde_json::{Map, Value, json};

const NOW: fn() -> f64 = fleet_now;

fn fleet(deps: FleetDeps) -> FleetContinuation {
    FleetContinuation::new(deps).unwrap()
}

fn reason(state: &FleetContinuationState) -> &str {
    state.reason.as_deref().unwrap_or("")
}

/// A `log` dependency that keeps `{event, ...fields}`.
fn log_into(logs: &Recorder<Value>) -> Option<Arc<LogFn>> {
    let logs = logs.clone();
    Some(Arc::new(move |event: &str, fields: &Map<String, Value>| {
        let mut entry = Map::new();
        entry.insert("event".into(), json!(event));
        entry.extend(fields.clone());
        logs.push(Value::Object(entry));
    }))
}

#[test]
fn off_does_nothing_without_a_quota_stop_or_confirmation_it_waits() {
    let f = fleet_setup();
    let clock = Clock::new(NOW());
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        ..f.deps.clone()
    });
    assert_eq!(fleet.tick().status, FleetStatus::Off);
    assert!(f.switches().is_empty());
    fleet.set_enabled(true).unwrap();
    // Full, but read too long ago to confirm it.
    f.set_usage(usage_checked(&f.a, 100.0, NOW() - SOURCE_FRESH_MS - 1.0));
    let unconfirmed = fleet.tick();
    assert_eq!(reason(&unconfirmed), "source-quota-unconfirmed");
    assert_eq!(unconfirmed.stopped, Some(2.0));
    f.set_stops(&f.a, vec![]);
    // The next scan is a minute after the last one.
    clock.add(60_000.0);
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    assert!(f.switches().is_empty());
}

#[test]
fn a_full_account_with_no_stopped_conversation_names_a_target_without_switching() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    f.set_stops(&f.a, vec![]);
    f.set_usage(fleet_usage(&f.a, 100.0));
    let full = fleet.tick();
    assert_eq!(reason(&full), "awaiting-quota-stop");
    assert_eq!(full.target_id.as_deref(), Some(f.b.id.as_str()));
    assert_eq!(full.stopped, Some(0.0));
    assert!(f.switches().is_empty());
    f.set_usage(fleet_usage(&f.a, 70.0));
    let room = fleet.tick();
    assert_eq!(reason(&room), "awaiting-quota-stop");
    assert_eq!(room.target_id, None);
    assert!(f.switches().is_empty());
}

#[test]
fn the_source_is_confirmed_full_only_by_a_reading_under_15_minutes_old() {
    let a = fleet_account("A", "max5");
    let read = |age: f64| usage_checked(&a, 100.0, NOW() - age);
    // The renderer reads the same rule from shared/usage.
    for usage in [read(5.0 * 60_000.0), read(SOURCE_FRESH_MS + 1.0)] {
        assert_eq!(
            fleet_source_exhausted(Some(&usage), NOW()),
            source_exhausted(Some(&usage), NOW())
        );
    }
    assert_eq!(SOURCE_FRESH_MS, 15.0 * 60_000.0);
    let exhausted = |usage: AccountUsage| source_exhausted(Some(&usage), NOW());
    assert!(exhausted(read(5.0 * 60_000.0)));
    assert!(exhausted(read(SOURCE_FRESH_MS)));
    assert!(!exhausted(read(SOURCE_FRESH_MS + 1.0)));
    assert!(!exhausted(read(20.0 * 60_000.0)));
    assert!(!exhausted(fleet_usage(&a, 70.0)));
}

#[test]
fn other_running_work_a_missing_target_or_missing_automation_keep_claude_untouched() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    f.state().busy = Some("not-quiescent:busyWorkers".into());
    assert_eq!(reason(&fleet.tick()), "not-quiescent:busyWorkers");
    f.state().busy = None;
    f.set_usage(fleet_usage(&f.b, 95.0));
    assert_eq!(reason(&fleet.tick()), "no-target");
    f.set_usage(fleet_usage(&f.b, 10.0));
    f.state().automation = Some("accessibility-permission-required".into());
    let blocked = fleet.tick();
    assert_eq!(blocked.status, FleetStatus::Attention);
    assert_eq!(reason(&blocked), "accessibility-permission-required");
    assert!(f.switches().is_empty());
}

#[test]
fn one_switch_continues_every_stopped_conversation_once_and_stays_on() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    let done = fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 2);
    assert_eq!(done.status, FleetStatus::Watching);
    assert_eq!(reason(&done), "continued");
    let last = done.last.unwrap();
    assert_eq!(last.conversations, 2.0);
    assert_eq!(last.started, 2.0);
    assert!(fleet.enabled());
    // The same stops are never handled again, even if still reported.
    f.state().active = f.a.id.clone();
    fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 2);
}

#[test]
fn later_limits_rotate_back_only_to_an_account_with_quota_again() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    fleet.tick();
    assert_eq!(f.state().active, f.b.id);
    // B runs out while A is still exhausted: wait instead of switching back.
    f.set_stops(&f.b, vec![stop(0)]);
    f.set_usage(fleet_usage(&f.b, 100.0));
    assert_eq!(reason(&fleet.tick()), "no-target");
    // A's window reset: rotate back.
    f.set_usage(fleet_usage(&f.a, 5.0));
    fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str(), f.a.id.as_str()]);
    assert_eq!(f.sent(), 3);
}

#[test]
fn a_failed_switch_is_reported_and_never_retried_automatically() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    f.state().switch_error = Some("Claude did not close".into());
    let failed = fleet.tick();
    assert_eq!(failed.status, FleetStatus::Attention);
    assert!(reason(&failed).starts_with("switch-failed:"));
    f.state().switch_error = None;
    fleet.tick();
    assert!(f.switches().is_empty());
    assert_eq!(f.sent(), 0);
}

#[test]
fn a_task_notification_that_calls_the_switch_off_before_claude_quits_leaves_the_stops_for_the_next_tick()
 {
    let f = fleet_setup();
    let scans = Arc::new(AtomicUsize::new(0));
    let attempts = Arc::new(AtomicUsize::new(0));
    // A background-task notification lands in a stopped transcript between the scan under the
    // lock and the quit; it keeps the stop's turn.
    let landed = Arc::new(AtomicBool::new(false));
    let base_switch = Arc::clone(&f.deps.switch_to);
    let fleet = fleet(FleetDeps {
        stops: {
            let (scans, state) = (Arc::clone(&scans), Arc::clone(&f.state));
            Arc::new(move |account| {
                scans.fetch_add(1, Ordering::SeqCst);
                Ok(lock(&state)
                    .stops
                    .get(&account.id)
                    .cloned()
                    .unwrap_or_default())
            })
        },
        quiet: {
            let landed = Arc::clone(&landed);
            Arc::new(move |_| {
                Ok(landed
                    .load(Ordering::SeqCst)
                    .then(|| "not-quiescent:busyWorkers".to_owned()))
            })
        },
        switch_to: {
            let (attempts, landed) = (Arc::clone(&attempts), Arc::clone(&landed));
            Arc::new(move |target, guards| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    landed.store(true, Ordering::SeqCst);
                }
                base_switch(target, guards)
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    let refused = fleet.tick();
    assert_eq!(refused.status, FleetStatus::Waiting);
    assert_eq!(reason(&refused), "context-changed");
    assert_eq!(refused.stopped, Some(2.0));
    assert!(f.switches().is_empty());
    assert!(f.handled().is_empty());
    assert_eq!(scans.load(Ordering::SeqCst), 2);
    // The notification settled: the next tick scans afresh and continues both.
    landed.store(false, Ordering::SeqCst);
    let done = fleet.tick();
    assert_eq!(scans.load(Ordering::SeqCst), 4);
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 2);
    assert_eq!(reason(&done), "continued");
    assert_eq!(f.handled().len(), 2);
}

#[test]
fn a_transcript_that_changes_right_before_the_quit_is_refused_by_the_guard_and_tried_again() {
    let f = fleet_setup();
    let attempts = Arc::new(AtomicUsize::new(0));
    let changed = Arc::new(AtomicBool::new(false));
    let base_switch = Arc::clone(&f.deps.switch_to);
    let fleet = fleet(FleetDeps {
        unchanged: {
            let changed = Arc::clone(&changed);
            Arc::new(move |_| !changed.load(Ordering::SeqCst))
        },
        switch_to: {
            let (attempts, changed) = (Arc::clone(&attempts), Arc::clone(&changed));
            Arc::new(move |target, guards| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    changed.store(true, Ordering::SeqCst);
                }
                base_switch(target, guards)
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    assert_eq!(reason(&fleet.tick()), "context-changed");
    assert!(f.handled().is_empty());
    changed.store(false, Ordering::SeqCst);
    assert_eq!(reason(&fleet.tick()), "continued");
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 2);
}

const CONDITIONS_CHANGED: &str =
    "Automatic Desktop switch was cancelled because its conditions changed.";

#[test]
fn a_switch_that_fails_after_claude_was_asked_to_quit_marks_its_stops_handled() {
    let f = fleet_setup();
    let attempts = Arc::new(AtomicUsize::new(0));
    let fleet = fleet(FleetDeps {
        switch_to: {
            let attempts = Arc::clone(&attempts);
            Arc::new(move |_, guards| {
                attempts.fetch_add(1, Ordering::SeqCst);
                assert!((guards.can_proceed.clone().unwrap())());
                (guards.before_quit.clone().unwrap())()?;
                // Claude quit; the write guard then saw the conditions change. Claude relaunches
                // on the source account.
                Err(DesktopError::new(CONDITIONS_CHANGED))
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    let failed = fleet.tick();
    assert_eq!(failed.status, FleetStatus::Attention);
    assert!(reason(&failed).starts_with("switch-failed:"));
    assert!(reason(&failed).contains("conditions changed"));
    assert_eq!(f.handled().len(), 2);
    // Never restarted again for the same limit.
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    assert_eq!(f.sent(), 0);
}

#[test]
fn a_send_interrupted_by_a_crash_is_never_repeated_after_relay_restarts() {
    let f = fleet_setup();
    f.state().crash_before_result = true;
    let first = fleet(f.deps.clone());
    first.set_enabled(true).unwrap();
    let result = first.tick();
    assert_eq!(result.status, FleetStatus::Attention);
    assert_eq!(reason(&result), "delivery-uncertain");
    assert_eq!(result.last.unwrap().uncertain, 2.0);
    // A new instance reading the same state sends nothing.
    f.state().crash_before_result = false;
    let restarted = fleet(f.deps.clone());
    restarted.tick();
    assert_eq!(f.sent(), 0);
    assert_eq!(f.switches(), [f.b.id.as_str()]);
}

#[test]
fn a_switch_that_was_interrupted_mid_way_resumes_continuing_on_the_target() {
    let f = fleet_setup();
    let first = fleet(f.deps.clone());
    first.set_enabled(true).unwrap();
    // Simulate Relay stopping right after Claude switched.
    let file = f.directory.path().join("fleet-state.json");
    let mut state: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    let stops = f.state().stops[&f.a.id].clone();
    state["pending"] = json!({
        "id": helpers::random_uuid(),
        "key": "k",
        "sourceId": f.a.id,
        "targetId": f.b.id,
        "stops": stops,
        "stage": "switching",
        "results": {},
        "startedAt": NOW(),
    });
    fs::write(&file, state.to_string()).unwrap();
    f.state().active = f.b.id.clone();
    let resumed = fleet(f.deps.clone());
    resumed.tick();
    assert_eq!(f.sent(), 2);
    assert!(f.switches().is_empty());
}

#[test]
fn the_target_is_the_soonest_reset_that_holds_half_an_hour_at_the_snapshots_tempo() {
    let f = fleet_setup();
    let c = enroll(fleet_account("C", "pro"));
    // C (Pro, 50 Pro units) resets in 30 minutes; B (Max 5×, 450) in an hour.
    let mut usage = f.state().usage.clone();
    usage.insert(
        c.id.clone(),
        AccountUsage {
            five_hour: Some(UsageWindow::new(50.0, Some(&iso(NOW() + 30.0 * 60_000.0)))),
            ..fleet_usage(&c, 50.0)
        },
    );
    let tempo = Arc::new(Mutex::new(None::<f64>));
    let accounts = vec![f.a.clone(), f.b.clone(), c.clone()];
    let fleet = fleet(FleetDeps {
        snapshot: {
            let tempo = Arc::clone(&tempo);
            Arc::new(move || DesktopContinuationContext {
                accounts: accounts.clone(),
                settings: default_settings(),
                usage: usage.clone(),
                tempo_rate: *lock(&tempo),
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    // Missing automation stops the tick after the target is chosen.
    f.state().automation = Some("accessibility-permission-required".into());
    assert_eq!(fleet.tick().target_id.as_deref(), Some(c.id.as_str()));
    // 200 Pro units/h needs 100 left: C falls short.
    *lock(&tempo) = Some(200.0);
    assert_eq!(fleet.tick().target_id.as_deref(), Some(f.b.id.as_str()));
    assert!(f.switches().is_empty());
}

#[test]
fn the_windows_are_told_only_when_the_fleet_state_changed_not_for_a_new_check_time() {
    let f = fleet_setup();
    let told = Arc::new(AtomicUsize::new(0));
    let clock = Clock::new(NOW());
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        changed: {
            let told = Arc::clone(&told);
            Arc::new(move || {
                told.fetch_add(1, Ordering::SeqCst);
            })
        },
        ..f.deps.clone()
    });
    let told = || told.load(Ordering::SeqCst);
    fleet.set_enabled(true).unwrap();
    f.set_stops(&f.a, vec![]);
    f.set_usage(fleet_usage(&f.a, 70.0));
    let base = told();
    fleet.tick();
    assert_eq!(told() - base, 1);
    clock.add(10_000.0);
    let again = fleet.tick();
    assert_eq!(again.checked_at, Some(iso(clock.get())));
    assert_eq!(told() - base, 1);
    // A full source names a target: that is a change.
    f.set_usage(fleet_usage(&f.a, 100.0));
    clock.add(10_000.0);
    assert_eq!(fleet.tick().target_id.as_deref(), Some(f.b.id.as_str()));
    assert_eq!(told() - base, 2);
    // Off stays off without telling anyone again.
    fleet.set_enabled(false).unwrap();
    assert_eq!(told() - base, 3);
    fleet.tick();
    fleet.tick();
    assert_eq!(told() - base, 3);
}

fn counting_stops(f: &FleetSetup, scans: &Arc<AtomicUsize>) -> FleetDeps {
    let (scans, state) = (Arc::clone(scans), Arc::clone(&f.state));
    FleetDeps {
        stops: Arc::new(move |account| {
            scans.fetch_add(1, Ordering::SeqCst);
            Ok(lock(&state)
                .stops
                .get(&account.id)
                .cloned()
                .unwrap_or_default())
        }),
        ..f.deps.clone()
    }
}

#[test]
fn scans_at_most_every_20_s_and_at_once_when_the_sources_quota_state_changes() {
    let f = fleet_setup();
    let clock = Clock::new(NOW());
    let scans = Arc::new(AtomicUsize::new(0));
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        ..counting_stops(&f, &scans)
    });
    let scans = || scans.load(Ordering::SeqCst);
    fleet.set_enabled(true).unwrap();
    f.set_stops(&f.a, vec![]);
    f.set_usage(fleet_usage(&f.a, 70.0));
    for _ in 0..2 {
        assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
        clock.add(10_000.0);
    }
    assert_eq!(scans(), 1);
    // Out of quota: scanned at once, nothing stopped yet.
    f.set_usage(fleet_usage(&f.a, 100.0));
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    assert_eq!(scans(), 2);
    // A conversation stops: seen at the next scan, 20 s after the last.
    f.set_stops(&f.a, vec![stop(0)]);
    f.state().automation = Some("accessibility-permission-required".into());
    clock.add(10_000.0);
    assert_eq!(fleet.tick().stopped, Some(0.0));
    assert_eq!(scans(), 2);
    clock.add(10_000.0);
    assert_eq!(fleet.tick().stopped, Some(1.0));
    assert_eq!(scans(), 3);
    // A change of quota state scans again at once.
    f.set_usage(usage_checked(&f.a, 100.0, NOW() - SOURCE_FRESH_MS - 1.0));
    clock.add(10_000.0);
    assert_eq!(reason(&fleet.tick()), "source-quota-unconfirmed");
    assert_eq!(scans(), 4);
    assert!(f.switches().is_empty());
}

#[test]
fn a_stop_after_a_reading_that_still_shows_room_reads_the_source_again_and_switches_at_once() {
    let f = fleet_setup();
    let reads: Recorder<String> = Recorder::default();
    // The last reading was a minute before the conversations stopped: 99 %.
    f.set_usage(fleet_usage(&f.a, 99.0));
    let mut early = stop(0);
    early.stopped_at = NOW() - 10_000.0;
    let mut earlier = stop(1);
    earlier.stopped_at = NOW() - 11_000.0;
    f.set_stops(&f.a, vec![early, earlier]);
    let a = f.a.clone();
    let fleet = fleet(FleetDeps {
        refresh_usage: {
            let (reads, state) = (reads.clone(), Arc::clone(&f.state));
            Some(Arc::new(move |id: &str| {
                reads.push(id.to_owned());
                lock(&state)
                    .usage
                    .insert(id, usage_checked(&a, 100.0, NOW()));
                Ok(())
            }))
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    fleet.tick();
    assert_eq!(reads.all(), [f.a.id.as_str()]);
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 2);
}

#[test]
fn a_source_read_again_that_still_has_room_keeps_waiting_and_is_read_at_most_once_a_minute() {
    let f = fleet_setup();
    let clock = Clock::new(NOW());
    let reads: Recorder<String> = Recorder::default();
    f.set_usage(fleet_usage(&f.a, 99.0));
    let mut recent = stop(0);
    recent.stopped_at = NOW() - 10_000.0;
    f.set_stops(&f.a, vec![recent]);
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        // The server says room still (a model limit, or the window reset meanwhile).
        refresh_usage: {
            let reads = reads.clone();
            Some(Arc::new(move |id: &str| {
                reads.push(id.to_owned());
                Ok(())
            }))
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    clock.add(10_000.0);
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    assert_eq!(reads.len(), 1);
    clock.add(50_000.0);
    fleet.tick();
    assert_eq!(reads.len(), 2);
    // A stop older than the reading asks for nothing: the reading came after it.
    f.set_usage(usage_checked(&f.a, 99.0, clock.get()));
    clock.add(70_000.0);
    fleet.tick();
    assert_eq!(reads.len(), 2);
    // A read that fails changes nothing and is asked again only a minute later.
    f.set_usage(fleet_usage(&f.a, 99.0));
    let failing = self::fleet(FleetDeps {
        now: Some(clock.now()),
        refresh_usage: {
            let reads = reads.clone();
            Some(Arc::new(move |_: &str| {
                reads.push("failed".into());
                Err("offline".into())
            }))
        },
        ..f.deps.clone()
    });
    assert_eq!(reason(&failing.tick()), "awaiting-quota-stop");
    assert_eq!(reads.all().last().map(String::as_str), Some("failed"));
    assert!(f.switches().is_empty());
}

#[test]
fn the_switch_acts_on_the_conversations_as_scanned_under_the_lock_not_on_an_earlier_scan() {
    let f = fleet_setup();
    let clock = Clock::new(NOW());
    let first = stop(0);
    // A meta row appended after the stop: the same turn, a longer transcript.
    let mut grown = first.clone();
    grown.transcript_bytes = 20;
    grown.transcript_sha256 = "b".repeat(64);
    f.set_stops(&f.a, vec![first]);
    f.state().automation = Some("accessibility-permission-required".into());
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        unchanged: Arc::new(|s| s.transcript_bytes == 20),
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    fleet.tick();
    f.set_stops(&f.a, vec![grown]);
    f.state().automation = None;
    clock.add(10_000.0);
    let done = fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(reason(&done), "continued");
}

#[test]
fn each_change_of_the_fleets_state_is_logged_with_what_it_waited_on_and_each_continuations_end() {
    let f = fleet_setup();
    let logs: Recorder<Value> = Recorder::default();
    let fleet = fleet(FleetDeps {
        log: log_into(&logs),
        quiet_detail: Some(Arc::new(|| {
            match json!({ "busy": "abcd1234", "work": "node", "sampled": true }) {
                Value::Object(map) => map,
                _ => unreachable!(),
            }
        })),
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    f.state().busy = Some("not-quiescent:busyWorkers".into());
    fleet.tick();
    // The same wait again is not logged twice.
    fleet.tick();
    let all = logs.all();
    let waits: Vec<&Value> = all
        .iter()
        .filter(|l| l["reason"] == "not-quiescent:busyWorkers")
        .collect();
    assert_eq!(waits.len(), 1);
    assert_eq!(
        *waits[0],
        json!({
            "event": "state",
            "status": "waiting",
            "reason": "not-quiescent:busyWorkers",
            "source": f.a.id[..8],
            "target": f.b.id[..8],
            "stopped": 2,
            "quota": "full",
            "busy": "abcd1234",
            "work": "node",
            "sampled": true,
        })
    );
    f.state().busy = None;
    fleet.tick();
    let all = logs.all();
    let continued: Vec<&Value> = all.iter().filter(|l| l["event"] == "continued").collect();
    assert_eq!(continued.len(), 2);
    assert_eq!(continued[0]["result"], "started");
    let conversation = continued[0]["conversation"].as_str().unwrap();
    assert!(conversation.len() == 8 && conversation.chars().all(|c| c.is_ascii_hexdigit()));
    assert!(
        all.iter()
            .any(|l| l["event"] == "state" && l["status"] == "switching")
    );
}

#[test]
fn a_target_whose_reading_is_only_too_old_is_read_again_at_once_and_taken_once_fresh() {
    let f = fleet_setup();
    let reads: Recorder<String> = Recorder::default();
    let logs: Recorder<Value> = Recorder::default();
    f.set_usage(usage_checked(&f.b, 10.0, NOW() - 10.0 * 60_000.0));
    let (a, b) = (f.a.clone(), f.b.clone());
    let fleet = fleet(FleetDeps {
        log: log_into(&logs),
        refresh_usage: {
            let (reads, state) = (reads.clone(), Arc::clone(&f.state));
            Some(Arc::new(move |id: &str| {
                reads.push(id.to_owned());
                // Its quota is unreadable now, as with a 429.
                if reads.len() == 1 {
                    return Err("rate-limited".into());
                }
                let account = if id == b.id { &b } else { &a };
                lock(&state).usage.insert(id, fleet_usage(account, 10.0));
                Ok(())
            }))
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    let waiting = fleet.tick();
    assert_eq!(reason(&waiting), "no-target");
    assert_eq!(reads.all(), [f.b.id.as_str()]);
    let all = logs.all();
    let no_target = all.iter().find(|l| l["reason"] == "no-target").unwrap();
    assert_eq!(
        no_target["targets"],
        format!("{}:quota-not-fresh", &f.b.id[..8])
    );
    // Asked once a minute at most.
    fleet.tick();
    assert_eq!(reads.all(), [f.b.id.as_str()]);
    let b = f.b.clone();
    let later = self::fleet(FleetDeps {
        now: Some(Arc::new(|| NOW() + 61_000.0)),
        refresh_usage: {
            let (reads, state) = (reads.clone(), Arc::clone(&f.state));
            Some(Arc::new(move |id: &str| {
                reads.push(id.to_owned());
                lock(&state)
                    .usage
                    .insert(id, usage_checked(&b, 10.0, NOW() + 60_000.0));
                Ok(())
            }))
        },
        ..f.deps.clone()
    });
    // A fresh source reading for the later clock.
    f.set_usage(usage_checked(&f.a, 100.0, NOW() + 30_000.0));
    let switched = later.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(switched.status, FleetStatus::Watching);
}

#[test]
fn the_notice_after_a_switch_at_the_limit_names_the_account_and_counts_the_conversations() {
    let last = |conversations: f64, started: f64, uncertain: f64, skipped: f64| FleetLast {
        at: String::new(),
        source_id: "s".into(),
        target_id: "t".into(),
        conversations,
        started,
        uncertain,
        skipped,
    };
    assert_eq!(
        fleet_notice(&last(3.0, 3.0, 0.0, 0.0), "Alto", Locale::Tr, None),
        "Limit doldu: Claude uygulaması Alto hesabına geçti. 3 konuşma kaldığı yerden devam ediyor."
    );
    assert_eq!(
        fleet_notice(&last(3.0, 1.0, 1.0, 1.0), "Alto", Locale::Tr, None),
        "Limit doldu: Claude uygulaması Alto hesabına geçti. 1 konuşma devam ediyor; 1 konuşmayı sen sürdür; 1 konuşmanın durumuna bak."
    );
    assert_eq!(
        fleet_notice(&last(3.0, 2.0, 0.0, 1.0), "Alto", Locale::En, None),
        "Limit reached: the Claude app switched to Alto. 2 conversations continue; continue 1 conversation yourself."
    );
    assert_eq!(
        fleet_notice(&last(3.0, 0.0, 0.0, 3.0), "Alto", Locale::En, None),
        "Limit reached: the Claude app switched to Alto. Continue 3 conversations yourself."
    );
    assert_eq!(
        fleet_notice(
            &last(3.0, 0.0, 0.0, 0.0),
            "Alto",
            Locale::En,
            Some("account-changed")
        ),
        "Limit reached: the Claude app switched to Alto. Its conversations were not continued; continue them yourself."
    );
    assert_eq!(
        fleet_notice(&last(1.0, 1.0, 0.0, 0.0), "Alto", Locale::En, None),
        "Limit reached: the Claude app switched to Alto. 1 conversation continues where it stopped."
    );
}

fn command(pid: i64, pids: &[i64], name: &str, ports: &[i64]) -> BackgroundCommand {
    BackgroundCommand {
        pid,
        pids: pids.to_vec(),
        names: vec![name.into()],
        ports: ports.to_vec(),
        seen_at: NOW(),
        active_at: Some(NOW()),
    }
}

#[test]
fn a_working_background_command_holds_the_switch_up_to_15_minutes_servers_and_idle_ones_are_stopped_at_the_switch()
 {
    let f = fleet_setup();
    let clock = Clock::new(NOW());
    let logs: Recorder<Value> = Recorder::default();
    let build = command(650, &[650, 651], "docker", &[]);
    let server = command(600, &[600, 601], "node", &[5173]);
    let stops: Recorder<HashSet<i64>> = Recorder::default();
    let answered = Arc::new(AtomicUsize::new(0));
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        log: log_into(&logs),
        background_commands: {
            let (clock, build, server) = (clock.clone(), build.clone(), server.clone());
            Some(Arc::new(move || {
                vec![
                    BackgroundCommand {
                        active_at: Some(clock.get()),
                        ..build.clone()
                    },
                    server.clone(),
                ]
            }))
        },
        stop_background: {
            let stops = stops.clone();
            Some(Arc::new(move |allowed: &HashSet<i64>| {
                stops.push(allowed.clone());
                Ok(BackgroundStopResult {
                    stopped: vec!["docker".into(), "node".into()],
                    left: 0,
                    unexpected: 0,
                })
            }))
        },
        answer_quit_guard: {
            let answered = Arc::clone(&answered);
            Some(Arc::new(move || {
                answered.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }))
        },
        switch_to: {
            let state = Arc::clone(&f.state);
            Arc::new(move |target, guards| {
                (guards.before_quit.clone().unwrap())()?;
                // Claude asks before it quits; the fleet answers, as it stopped the commands.
                assert_eq!((guards.answer_quit_guard.clone().unwrap())(), Ok(true));
                let mut state = lock(&state);
                state.switches.push(target.to_owned());
                state.active = target.to_owned();
                Ok(())
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    let waiting = fleet.tick();
    assert_eq!(reason(&waiting), "background-work");
    assert!(f.switches().is_empty());
    let all = logs.all();
    let logged = all
        .iter()
        .find(|l| l["reason"] == "background-work")
        .unwrap();
    assert_eq!(logged["working"], "docker");
    assert_eq!(logged["commands"], "docker node:5173");
    // Readings as fresh as the scheduled reads keep them.
    let reread = || {
        f.set_usage(usage_checked(&f.a, 100.0, clock.get() - 60_000.0));
        f.set_usage(usage_checked(&f.b, 10.0, clock.get() - 60_000.0));
    };
    // Still working 14 minutes on: still waiting.
    clock.add(BACKGROUND_WAIT_MS - 60_000.0);
    reread();
    assert_eq!(reason(&fleet.tick()), "background-work");
    // Past 15 minutes: both are stopped at the switch, and the quit question is answered.
    clock.add(60_000.0);
    reread();
    let done = fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    let mut allowed: Vec<i64> = stops.all()[0].iter().copied().collect();
    allowed.sort();
    assert_eq!(allowed, [600, 650]);
    assert_eq!(answered.load(Ordering::SeqCst), 1);
    assert_eq!(done.status, FleetStatus::Watching);
    assert!(
        logs.all()
            .iter()
            .any(|l| l["event"] == "background-stopped" && l["stopped"] == "docker node")
    );
    // A server alone never holds the switch.
    let g = fleet_setup();
    let quick = self::fleet(FleetDeps {
        background_commands: Some(Arc::new(move || vec![server.clone()])),
        stop_background: Some(Arc::new(|_: &HashSet<i64>| {
            Ok(BackgroundStopResult {
                stopped: vec!["node".into()],
                left: 0,
                unexpected: 0,
            })
        })),
        ..g.deps.clone()
    });
    quick.set_enabled(true).unwrap();
    quick.tick();
    assert_eq!(g.switches(), [g.b.id.as_str()]);
}

#[test]
fn a_background_command_the_fleet_did_not_weigh_or_one_that_will_not_end_calls_the_switch_off_before_claude_quits()
 {
    for result in [
        BackgroundStopResult {
            stopped: vec![],
            left: 0,
            unexpected: 1,
        },
        BackgroundStopResult {
            stopped: vec!["node".into()],
            left: 1,
            unexpected: 0,
        },
    ] {
        let f = fleet_setup();
        let quits = Arc::new(AtomicUsize::new(0));
        let fleet = fleet(FleetDeps {
            background_commands: Some(Arc::new(Vec::new)),
            stop_background: Some(Arc::new(move |_: &HashSet<i64>| Ok(result.clone()))),
            switch_to: {
                let quits = Arc::clone(&quits);
                Arc::new(move |_, guards| {
                    (guards.before_quit.clone().unwrap())()?;
                    quits.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
            },
            ..f.deps.clone()
        });
        fleet.set_enabled(true).unwrap();
        let state = fleet.tick();
        assert_eq!(quits.load(Ordering::SeqCst), 0);
        assert_eq!(reason(&state), "context-changed");
        assert!(f.switches().is_empty());
    }
    // Without stopping anything, Claude's question is the user's to answer.
    let f = fleet_setup();
    let asked = Arc::new(AtomicUsize::new(0));
    let fleet = fleet(FleetDeps {
        background_commands: Some(Arc::new(Vec::new)),
        stop_background: Some(Arc::new(|_: &HashSet<i64>| {
            Ok(BackgroundStopResult::default())
        })),
        answer_quit_guard: {
            let asked = Arc::clone(&asked);
            Some(Arc::new(move || {
                asked.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            }))
        },
        switch_to: {
            let state = Arc::clone(&f.state);
            Arc::new(move |target, guards| {
                (guards.before_quit.clone().unwrap())()?;
                assert_eq!((guards.answer_quit_guard.clone().unwrap())(), Ok(false));
                lock(&state).active = target.to_owned();
                Ok(())
            })
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    fleet.tick();
    assert_eq!(asked.load(Ordering::SeqCst), 0);
}

#[test]
fn a_stop_that_relays_own_stopping_of_a_background_command_caused_is_left_alone() {
    let f = fleet_setup();
    let logs: Recorder<Value> = Recorder::default();
    let clock = Clock::new(NOW());
    let mut real = stop(0);
    real.trigger = Some(TurnTrigger::TaskNotification);
    real.stopped_at = NOW() - 30_000.0;
    f.set_stops(&f.a, vec![real.clone()]);
    let stopped_commands = Arc::new(AtomicUsize::new(0));
    let mut caused = stop(1);
    caused.trigger = Some(TurnTrigger::TaskNotification);
    caused.stopped_at = NOW() + 4_000.0;
    let fleet = fleet(FleetDeps {
        now: Some(clock.now()),
        log: log_into(&logs),
        background_commands: Some(Arc::new(Vec::new)),
        stop_background: {
            let (count, state, clock) = (
                Arc::clone(&stopped_commands),
                Arc::clone(&f.state),
                clock.clone(),
            );
            let (a, real, caused) = (f.a.id.clone(), real.clone(), caused.clone());
            Some(Arc::new(move |_: &HashSet<i64>| {
                count.fetch_add(1, Ordering::SeqCst);
                // The stopped server's notification starts a turn in another conversation; out
                // of quota, it stops at the limit as Claude is about to quit.
                lock(&state)
                    .stops
                    .insert(a.clone(), vec![real.clone(), caused.clone()]);
                clock.add(5_000.0);
                Ok(BackgroundStopResult {
                    stopped: vec!["node".into()],
                    left: 0,
                    unexpected: 0,
                })
            }))
        },
        switch_to: {
            let state = Arc::clone(&f.state);
            Arc::new(move |target, guards| {
                (guards.before_quit.clone().unwrap())()?;
                if !(guards.can_proceed.clone().unwrap())() {
                    return Err(desktop_switch_refused("cancelled"));
                }
                let mut state = lock(&state);
                state.switches.push(target.to_owned());
                state.active = target.to_owned();
                Ok(())
            })
        },
        quiet_sync: Arc::new(|_| None),
        unchanged: {
            let (state, a, real) = (Arc::clone(&f.state), f.a.id.clone(), real.clone());
            Arc::new(move |s| *s != real || lock(&state).stops[&a].len() == 1)
        },
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    // The first attempt is called off: the stop it saw moved on as the notification landed.
    fleet.tick();
    assert_eq!(stopped_commands.load(Ordering::SeqCst), 1);
    assert!(f.switches().is_empty());
    // The next sees the caused stop, leaves it as handled, and switches for the real one alone.
    let mut later = real.clone();
    later.turn_id = "later".into();
    f.set_stops(&f.a, vec![later, caused]);
    clock.add(10_000.0);
    fleet.tick();
    assert_eq!(f.switches(), [f.b.id.as_str()]);
    assert_eq!(f.sent(), 1);
    assert!(
        logs.all()
            .iter()
            .any(|l| l["event"] == "stop-skipped" && l["why"] == "relay-stopped-its-command")
    );
}

#[test]
fn a_switch_made_by_hand_while_conversations_wait_at_the_limit_continues_them_there() {
    let f = fleet_setup();
    let logs: Recorder<Value> = Recorder::default();
    let fleet = fleet(FleetDeps {
        log: log_into(&logs),
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    // The fleet waits on other work; the user switches to B meanwhile.
    f.state().busy = Some("not-quiescent:unknownWork".into());
    assert_eq!(fleet.tick().status, FleetStatus::Waiting);
    f.state().busy = None;
    f.state().active = f.b.id.clone();
    let done = fleet.tick();
    assert!(f.switches().is_empty());
    assert_eq!(f.sent(), 2);
    let last = done.last.unwrap();
    assert_eq!(last.target_id, f.b.id);
    assert_eq!(last.started, 2.0);
    assert!(
        logs.all()
            .iter()
            .any(|l| l["event"] == "handoff" && l["stopped"] == 2)
    );
    // Continued once: nothing more on the next ticks.
    fleet.tick();
    assert_eq!(f.sent(), 2);
}

#[test]
fn after_a_failed_automatic_switch_a_switch_by_hand_still_continues_the_conversations() {
    let f = fleet_setup();
    let fleet = fleet(FleetDeps {
        switch_to: Arc::new(|_, guards| {
            (guards.before_quit.clone().unwrap())()?;
            Err(DesktopError::new(CONDITIONS_CHANGED))
        }),
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    assert!(reason(&fleet.tick()).starts_with("switch-failed:"));
    // Claude is back on A, whose stops are handled now: the fleet only watches.
    assert_eq!(reason(&fleet.tick()), "awaiting-quota-stop");
    f.state().active = f.b.id.clone();
    fleet.tick();
    assert_eq!(f.sent(), 2);
}

#[test]
fn a_switch_by_hand_to_a_full_account_or_long_after_the_stops_continues_nothing() {
    for late in [false, true] {
        let f = fleet_setup();
        let clock = Clock::new(NOW());
        let fleet = fleet(FleetDeps {
            now: Some(clock.now()),
            ..f.deps.clone()
        });
        fleet.set_enabled(true).unwrap();
        f.state().busy = Some("not-quiescent:unknownWork".into());
        fleet.tick();
        f.state().busy = None;
        if late {
            clock.add(HANDOFF_MS);
        } else {
            f.set_usage(fleet_usage(&f.b, 100.0));
        }
        f.state().active = f.b.id.clone();
        // B's own empty scan and A's stops, read for B, are none of B's: nothing is sent.
        fleet.tick();
        assert_eq!(f.sent(), 0, "{}", if late { "late" } else { "full" });
    }
}

#[test]
fn room_again_in_the_account_that_stopped_ends_the_wait_for_a_switch_by_hand() {
    let f = fleet_setup();
    let fleet = fleet(f.deps.clone());
    fleet.set_enabled(true).unwrap();
    f.state().busy = Some("not-quiescent:unknownWork".into());
    fleet.tick();
    f.state().busy = None;
    // A's window reset before the user switched: A's conversations are theirs to continue there.
    f.set_usage(fleet_usage(&f.a, 5.0));
    fleet.tick();
    f.state().active = f.b.id.clone();
    fleet.tick();
    assert_eq!(f.sent(), 0);
}

#[test]
fn the_fleet_waits_and_never_switches_while_a_separate_claude_window_runs() {
    let f = fleet_setup();
    let state = Arc::clone(&f.state);
    let fleet = fleet(FleetDeps {
        desktop: Arc::new(move || {
            Ok(relay_core::shared::types::DesktopState {
                windows: Some(1.0),
                ..desktop_state(&lock(&state).active)
            })
        }),
        ..f.deps.clone()
    });
    fleet.set_enabled(true).unwrap();
    let state = fleet.tick();
    assert_eq!(
        (state.status, reason(&state)),
        (FleetStatus::Waiting, "separate-window")
    );
    assert!(f.switches().is_empty());
}
