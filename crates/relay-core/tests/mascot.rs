//! Port of tests/mascot.test.ts.

#[path = "common/tray.rs"]
mod helpers;

use helpers::{at, from_json, ms, spread};
use relay_core::shared::mascot::{
    HUNGRY_PERCENT, MascotHead, MascotPose, MascotRest, READING_MAX_AGE_MS, head_for, mascot_pose,
    mascot_rest,
};
use relay_core::shared::mascot_frames::{
    BLINK_FRAME, MASCOT_FRAMES, MascotFrame, POSE_FRAME, pose_frame,
};
use relay_core::shared::tray::{TRAY_RESET_FROM, TraySnapshot};
use serde_json::{Value, json};

fn now() -> f64 {
    ms("2026-10-15T10:00:00Z")
}

fn account(id: &str) -> Value {
    json!({ "id": id, "name": id, "kind": "personal", "group": "personal", "color": "olive", "createdAt": at(now()) })
}

fn usage_with(id: &str, five: f64, week: f64, extra: Value) -> Value {
    spread(
        json!({
            "accountId": id, "status": "ready", "stale": false, "checkedAt": at(now() - 60_000.0),
            "fiveHour": { "usedPercent": five, "resetsAt": at(now() + 3_600_000.0) },
            "sevenDay": { "usedPercent": week, "resetsAt": at(now() + 86_400_000.0) },
        }),
        extra,
    )
}

fn usage(id: &str, five: f64) -> Value {
    usage_with(id, five, 10.0, json!({}))
}

fn desktop(extra: Value) -> Value {
    spread(
        json!({
            "available": true, "running": true, "organizations": [], "activeProfileId": "a", "busy": false,
            "recoveryRequired": false, "errorRevision": 0,
        }),
        extra,
    )
}

fn attempt(id: &str, status: &str, at_ms: f64) -> Value {
    json!({ "id": id, "accountId": "a", "identityKey": "k", "at": at(at_ms), "status": status })
}

fn started() -> Value {
    attempt("1", "started", now() - 30_000.0)
}

/// `input(extra)`: a and b, a open in Claude.
fn input(extra: Value) -> TraySnapshot {
    from_json(spread(
        json!({
            "accounts": [account("a"), account("b")],
            "usage": { "a": usage("a", 20.0), "b": usage("b", 30.0) },
            "desktop": desktop(json!({})),
        }),
        extra,
    ))
}

fn pose(snapshot: &TraySnapshot) -> MascotPose {
    mascot_pose(snapshot.mascot_input(), now())
}

fn with_usage(a: Value, b: Value) -> TraySnapshot {
    input(json!({ "usage": { "a": a, "b": b } }))
}

#[test]
fn the_panda_idles_when_nothing_needs_showing() {
    assert_eq!(pose(&input(json!({}))), MascotPose::Idle);
    assert_eq!(pose(&input(json!({ "desktop": null }))), MascotPose::Idle);
    let empty: TraySnapshot = from_json(json!({
        "accounts": [], "usage": {}, "desktop": desktop(json!({ "activeProfileId": null })),
    }));
    assert_eq!(pose(&empty), MascotPose::Idle);
}

#[test]
fn the_panda_gets_hungry_where_the_menu_bar_title_starts_counting_down_80_of_the_five_hour_window()
{
    assert_eq!(HUNGRY_PERCENT, TRAY_RESET_FROM);
    let b = || usage("b", 30.0);
    assert_eq!(pose(&with_usage(usage("a", 79.9), b())), MascotPose::Idle);
    assert_eq!(pose(&with_usage(usage("a", 80.0), b())), MascotPose::Hungry);
    assert_eq!(pose(&with_usage(usage("a", 99.9), b())), MascotPose::Hungry);
    assert_eq!(
        pose(&with_usage(usage_with("a", 20.0, 95.0, json!({})), b())),
        MascotPose::Idle
    );
}

#[test]
fn a_full_five_hour_window_or_every_account_full_shows_the_full_face() {
    assert_eq!(
        pose(&input(json!({ "usage": { "a": usage("a", 100.0) } }))),
        MascotPose::Full
    );
    assert_eq!(
        pose(&with_usage(usage("a", 100.0), usage("b", 30.0))),
        MascotPose::Full
    );
    // Every account full, though the active one's five-hour window is not.
    assert_eq!(
        pose(&with_usage(
            usage_with("a", 40.0, 100.0, json!({})),
            usage("b", 100.0)
        )),
        MascotPose::Full
    );
    // Only the active account's five-hour window counts on its own.
    assert_eq!(
        pose(&with_usage(usage("a", 40.0), usage("b", 100.0))),
        MascotPose::Idle
    );
    assert_eq!(
        pose(&with_usage(
            usage_with("a", 40.0, 100.0, json!({})),
            usage_with("b", 100.0, 10.0, json!({ "stale": true }))
        )),
        MascotPose::Idle
    );
}

#[test]
fn the_panda_sleeps_when_claude_is_closed_or_the_active_account_s_reading_failed_or_is_old() {
    let b = || usage("b", 30.0);
    let closed = input(json!({ "desktop": desktop(json!({ "running": false })) }));
    assert_eq!(pose(&closed), MascotPose::Sleeping);
    assert_eq!(
        mascot_rest(closed.mascot_input(), now()),
        Some(MascotRest::Closed)
    );
    let old = usage_with(
        "a",
        20.0,
        10.0,
        json!({ "checkedAt": at(now() - READING_MAX_AGE_MS) }),
    );
    let old = with_usage(old, b());
    assert_eq!(pose(&old), MascotPose::Sleeping);
    assert_eq!(
        mascot_rest(old.mascot_input(), now()),
        Some(MascotRest::Unknown)
    );
    let recent = usage_with(
        "a",
        20.0,
        10.0,
        json!({ "checkedAt": at(now() - READING_MAX_AGE_MS + 60_000.0) }),
    );
    assert_eq!(pose(&with_usage(recent, b())), MascotPose::Idle);
    for extra in [
        json!({ "stale": true }),
        json!({ "status": "error", "issue": "rate-limited" }),
    ] {
        assert_eq!(
            pose(&with_usage(usage_with("a", 95.0, 10.0, extra), b())),
            MascotPose::Sleeping
        );
    }
    // A refresh in progress keeps its reading; a first reading still to come, or a reset that
    // passed, is no reason.
    assert_eq!(
        pose(&with_usage(
            usage_with("a", 95.0, 10.0, json!({ "status": "loading" })),
            b()
        )),
        MascotPose::Hungry
    );
    assert_eq!(
        pose(&input(json!({ "usage": { "b": b() } }))),
        MascotPose::Idle
    );
    assert_eq!(
        pose(&with_usage(
            json!({ "accountId": "a", "status": "loading", "stale": false }),
            b()
        )),
        MascotPose::Idle
    );
    let reset = usage_with(
        "a",
        100.0,
        10.0,
        json!({ "fiveHour": { "usedPercent": 100, "resetsAt": at(now() - 60_000.0) } }),
    );
    assert_eq!(pose(&with_usage(reset, b())), MascotPose::Idle);
    // No saved account open, or no Desktop state yet: no reason either.
    assert_eq!(
        pose(&input(
            json!({ "desktop": desktop(json!({ "activeProfileId": null })), "usage": {} })
        )),
        MascotPose::Idle
    );
}

#[test]
fn warming_lasts_while_a_start_is_under_two_minutes_old() {
    assert_eq!(
        pose(&input(json!({ "attempts": [started()] }))),
        MascotPose::Warming
    );
    assert_eq!(
        pose(&input(
            json!({ "attempts": [attempt("1", "started", now() - 2.0 * 60_000.0)] })
        )),
        MascotPose::Idle
    );
    assert_eq!(
        pose(&input(
            json!({ "attempts": [attempt("1", "verified", now() - 30_000.0)] })
        )),
        MascotPose::Idle
    );
}

#[test]
fn alert_beats_away_which_beats_warming_sleeping_full_and_hungry() {
    let full = json!({ "a": usage("a", 100.0), "b": usage("b", 100.0) });
    let all = |d: Value| {
        input(json!({ "desktop": desktop(d), "attempts": [started()], "usage": full.clone() }))
    };
    assert_eq!(pose(&all(json!({ "busy": true }))), MascotPose::Away);
    assert_eq!(
        pose(&all(json!({ "busy": true, "recoveryRequired": true }))),
        MascotPose::Alert
    );
    assert_eq!(
        pose(&all(
            json!({ "busy": true, "error": "Claude Desktop data could not be read." })
        )),
        MascotPose::Alert
    );
    assert_eq!(
        pose(&input(
            json!({ "desktop": desktop(json!({ "available": false })) })
        )),
        MascotPose::Alert
    );
    assert_eq!(
        pose(&input(
            json!({ "attempts": [started()], "usage": full.clone() })
        )),
        MascotPose::Warming
    );
    assert_eq!(
        pose(&input(json!({ "usage": full.clone() }))),
        MascotPose::Full
    );
    assert_eq!(
        pose(&input(
            json!({ "usage": full.clone(), "desktop": desktop(json!({ "running": false })) })
        )),
        MascotPose::Sleeping
    );
    assert_eq!(
        pose(&all(json!({ "busy": true, "running": false }))),
        MascotPose::Away
    );
}

#[test]
fn only_the_active_account_needing_sign_in_raises_the_alert() {
    let b = || usage("b", 30.0);
    for extra in [
        json!({ "connectionRenewalRequired": true }),
        json!({ "issue": "renewal-required" }),
        json!({ "issue": "expired" }),
        json!({ "issue": "identity-mismatch" }),
    ] {
        assert_eq!(
            pose(&with_usage(usage_with("a", 20.0, 10.0, extra), b())),
            MascotPose::Alert
        );
    }
    assert_eq!(
        pose(&with_usage(
            usage("a", 20.0),
            usage_with("b", 30.0, 10.0, json!({ "issue": "expired" }))
        )),
        MascotPose::Idle
    );
    assert_eq!(
        pose(&with_usage(
            usage_with("a", 20.0, 10.0, json!({ "issue": "rate-limited" })),
            b()
        )),
        MascotPose::Idle
    );
}

#[test]
fn a_connection_flag_left_over_from_before_is_no_alert_while_the_service_is_rate_limited_or_down() {
    let b = || usage("b", 30.0);
    for issue in ["rate-limited", "unavailable"] {
        let extra = json!({ "issue": issue, "connectionRenewalRequired": true });
        assert_eq!(
            pose(&with_usage(usage_with("a", 20.0, 10.0, extra), b())),
            MascotPose::Idle,
            "{issue}"
        );
    }
    // The flag alone, with no reported issue, still asks for a sign-in.
    assert_eq!(
        pose(&with_usage(
            usage_with(
                "a",
                20.0,
                10.0,
                json!({ "connectionRenewalRequired": true })
            ),
            b()
        )),
        MascotPose::Alert
    );
    // A reported sign-in issue is an alert with or without the flag.
    assert_eq!(
        pose(&with_usage(
            usage_with(
                "a",
                20.0,
                10.0,
                json!({ "issue": "expired", "connectionRenewalRequired": true })
            ),
            b()
        )),
        MascotPose::Alert
    );
}

#[test]
fn a_usage_sign_in_that_belongs_to_another_account_alerts_on_the_active_account_whatever_the_read_says()
 {
    let stamp = at(now());
    let desktop_id = json!({ "accountUuid": "u-desktop", "orgId": "o-1", "savedAt": stamp });
    let mismatched = spread(
        account("a"),
        json!({
            "desktop": desktop_id,
            "auth": { "loggedIn": true, "accountUuid": "u-other", "orgId": "o-1", "checkedAt": stamp },
        }),
    );
    let matching = spread(
        account("a"),
        json!({
            "desktop": desktop_id,
            "auth": { "loggedIn": true, "accountUuid": "u-desktop", "orgId": "o-1", "checkedAt": stamp },
        }),
    );
    for extra in [
        json!({}),
        json!({ "issue": "keychain-locked" }),
        json!({ "issue": "rate-limited" }),
    ] {
        let snapshot = input(json!({
            "accounts": [mismatched.clone(), account("b")],
            "usage": { "a": usage_with("a", 20.0, 10.0, extra.clone()), "b": usage("b", 30.0) },
        }));
        assert_eq!(pose(&snapshot), MascotPose::Alert, "{extra}");
    }
    assert_eq!(
        pose(&input(json!({ "accounts": [matching, account("b")] }))),
        MascotPose::Idle
    );
    // A mismatch on an account that is not active is no alert.
    let other = spread(mismatched.clone(), json!({ "id": "b", "name": "b" }));
    assert_eq!(
        pose(&input(json!({ "accounts": [account("a"), other] }))),
        MascotPose::Idle
    );
}

#[test]
fn a_locked_keychain_is_a_sign_in_problem_with_or_without_a_retained_flag() {
    for extra in [
        json!({ "issue": "keychain-locked" }),
        json!({ "issue": "keychain-locked", "connectionRenewalRequired": true }),
    ] {
        assert_eq!(
            pose(&with_usage(
                usage_with("a", 20.0, 10.0, extra.clone()),
                usage("b", 30.0)
            )),
            MascotPose::Alert,
            "{extra}"
        );
    }
}

#[test]
fn the_panel_head_follows_the_pose() {
    let poses = [
        MascotPose::Alert,
        MascotPose::Away,
        MascotPose::Warming,
        MascotPose::Sleeping,
        MascotPose::Full,
        MascotPose::Hungry,
        MascotPose::Idle,
    ];
    assert_eq!(
        poses.map(head_for),
        [
            MascotHead::Alert,
            MascotHead::Idle,
            MascotHead::Idle,
            MascotHead::Sleep,
            MascotHead::Hungry,
            MascotHead::Hungry,
            MascotHead::Idle,
        ]
    );
}

#[test]
fn the_menu_bar_has_seven_head_frames_and_every_pose_shows_one() {
    assert_eq!(
        MASCOT_FRAMES.map(MascotFrame::as_str),
        ["idle", "blink", "hungry", "sleep", "alert", "away", "full"]
    );
    let table: Vec<(&str, &str)> = POSE_FRAME
        .iter()
        .map(|(pose, frame)| (pose.as_str(), frame.as_str()))
        .collect();
    assert_eq!(
        table,
        [
            ("idle", "idle"),
            ("warming", "idle"),
            ("hungry", "hungry"),
            ("full", "full"),
            ("sleeping", "sleep"),
            ("alert", "alert"),
            ("away", "away"),
        ]
    );
    for (pose, frame) in POSE_FRAME {
        assert_eq!(pose_frame(pose), frame);
    }
    assert_eq!(BLINK_FRAME, MascotFrame::Blink);
}
