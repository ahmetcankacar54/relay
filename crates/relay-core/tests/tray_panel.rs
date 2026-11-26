//! Port of tests/tray-panel.test.ts.

#[path = "common/tray.rs"]
mod helpers;

use helpers::{at, from_json, ms};
use relay_core::shared::tray::{TraySnapshot, tray_title, tray_tooltip};
use relay_core::shared::tray_panel::{
    PANEL_WIDTH, Point, Rect, Size, clamp_panel_height, panel_position,
};
use relay_i18n::Locale::{En, Tr};
use serde_json::{Value, json};

fn now() -> f64 {
    ms("2026-10-14T10:00:00Z")
}

fn usage(five: f64, checked: f64) -> Value {
    json!({
        "accountId": "a", "status": "ready", "stale": false, "checkedAt": at(checked),
        "fiveHour": { "usedPercent": five, "resetsAt": at(now() + 3_600_000.0) },
        "sevenDay": { "usedPercent": 10, "resetsAt": at(now() + 86_400_000.0) },
    })
}

fn fresh(five: f64) -> Value {
    usage(five, now() - 60_000.0)
}

fn snap(u: Option<Value>, active: &str) -> TraySnapshot {
    from_json(json!({
        "accounts": [{
            "id": "a", "name": "A", "kind": "personal", "group": "personal", "color": "olive",
            "createdAt": "2026-10-01T00:00:00Z",
            "desktop": {
                "accountUuid": "00000000-0000-4000-8000-000000000001",
                "orgId": "00000000-0000-4000-8000-000000000002",
                "savedAt": "2026-10-01T00:00:00Z",
            },
        }],
        "usage": match u { Some(u) => json!({ "a": u }), None => json!({}) },
        "desktop": {
            "available": true, "running": true, "organizations": [], "activeProfileId": active,
            "busy": false, "recoveryRequired": false, "errorRevision": 0,
        },
    }))
}

fn on_a(u: Value) -> TraySnapshot {
    snap(Some(u), "a")
}

#[test]
fn tray_title_shows_the_active_account_s_five_hour_percent_used_compact() {
    assert_eq!(tray_title(&on_a(fresh(37.6)), now(), En), "37%");
    // From 80 % on, the time left until the window renews (an hour here) follows the percent.
    assert_eq!(tray_title(&on_a(fresh(90.0)), now(), En), "90% · 1:00");
    assert_eq!(tray_title(&on_a(fresh(94.0)), now(), En), "94% · 1:00");
    assert_eq!(tray_title(&on_a(fresh(94.0)), now(), Tr), "%94 · 1:00");
    // Only a full window reads 100.
    assert_eq!(tray_title(&on_a(fresh(99.9)), now(), Tr), "%99 · 1:00");
    // A full one gives the clock it reopens at, in the planning time zone.
    let full = TraySnapshot {
        time_zone: Some("Europe/Istanbul".into()),
        ..on_a(fresh(100.0))
    };
    assert_eq!(tray_title(&full, now(), Tr), "14:00");
    assert_eq!(tray_title(&on_a(fresh(0.0)), now(), Tr), "%0");
    // A reading too old to count: the panda sleeps and the title keeps its figure, marked as last
    // known.
    let old = on_a(usage(20.0, now() - 3_600_000.0));
    assert_eq!(tray_title(&old, now(), En), "~20%");
    // Once its window has reset, nothing is known: the dash.
    assert_eq!(tray_title(&old, now() + 3_600_000.0, En), "—");
    assert_eq!(tray_title(&snap(None, "a"), now(), En), "");
    assert_eq!(
        tray_title(&snap(Some(fresh(20.0)), "missing"), now(), En),
        ""
    );
}

#[test]
fn the_tooltip_says_what_the_title_s_number_is() {
    assert_eq!(
        tray_tooltip(&on_a(fresh(94.0)), Tr, now()),
        "Relay — A · %94 kullanıldı · 1 sa sonra yenilenir"
    );
    assert_eq!(
        tray_tooltip(&on_a(fresh(94.0)), En, now()),
        "Relay — A · 94% used · renews in 1:00"
    );
    let old = on_a(usage(20.0, now() - 3_600_000.0));
    assert_eq!(
        tray_tooltip(&old, En, now()),
        "Relay — A · ~20% used · renews in 1:00 · usage data is out of date, read 1 h ago"
    );
    assert_eq!(
        tray_tooltip(&old, En, now() + 3_600_000.0),
        "Relay — A · usage data is out of date, read 2 h ago"
    );
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

#[test]
fn the_panel_opens_under_the_icon_and_stays_on_screen() {
    let work = rect(0.0, 25.0, 1440.0, 875.0);
    let size = Size {
        width: PANEL_WIDTH,
        height: 500.0,
    };
    assert_eq!(
        panel_position(rect(700.0, 0.0, 30.0, 24.0), work, size),
        Point { x: 535.0, y: 28.0 }
    );
    assert_eq!(
        panel_position(rect(1420.0, 0.0, 30.0, 24.0), work, size),
        Point { x: 1072.0, y: 28.0 }
    );
    assert_eq!(
        panel_position(rect(2.0, 0.0, 30.0, 24.0), work, size),
        Point { x: 8.0, y: 28.0 }
    );
    assert_eq!(clamp_panel_height(50.0, 875.0), 200.0);
    assert_eq!(clamp_panel_height(2000.0, 875.0), 859.0);
    assert_eq!(clamp_panel_height(512.4, 875.0), 513.0);
    // The panel reports its exact, fractional height; rounding it down left the document
    // scrollable.
    assert_eq!(clamp_panel_height(477.28125, 875.0), 478.0);
}
