//! Port of tests/tray.test.ts. The subtests of "tray disables all switch targets while state is
//! unavailable or occupied" run as one loop with their labels in the messages.

#[path = "common/tray.rs"]
mod helpers;

use helpers::{at, from_json, ms, spread};
use relay_core::shared::mascot::{MascotPose, MascotRest, mascot_pose, mascot_rest};
use relay_core::shared::tray::{
    DEFAULT_MENU_BAR_ITEMS, MENU_BAR_ITEMS, MENU_BAR_MAX_ITEMS, TRAY_NAME_MAX, TrayCommand,
    TrayMenuItem, TraySnapshot, build_tray_menu, can_request_tray_switch, menu_bar_items,
    tray_account_name, tray_cost, tray_countdown, tray_reset_clock, tray_short_name, tray_title,
    tray_tokens, tray_tooltip, tray_usage_label, unavailable_tray_menu,
};
use relay_core::shared::types::{AccountUsage, MenuBarItem, UsageWindow};
use relay_i18n::Locale::{self, En, Pl, Tr, ZhHans};
use serde_json::{Value, json};

fn now() -> f64 {
    ms("2026-10-13T10:00:00Z")
}

fn wall_now() -> f64 {
    relay_core::clock::now_ms() as f64
}

fn account(id: &str, name: &str) -> Value {
    json!({
        "id": id, "name": name, "kind": "personal", "group": "personal", "color": "#227755",
        "createdAt": "2026-10-12T00:00:00Z",
        "desktop": { "accountUuid": format!("uuid-{id}"), "orgId": format!("org-{id}"), "savedAt": "2026-10-12T00:00:00Z" },
    })
}

fn desktop() -> Value {
    json!({
        "available": true, "running": true, "organizations": [], "activeProfileId": "current",
        "busy": false, "recoveryRequired": false, "errorRevision": 0,
    })
}

fn desktop_with(patch: Value) -> Value {
    spread(desktop(), patch)
}

fn usage_json(id: &str) -> Value {
    json!({
        "accountId": id, "status": "ready", "stale": false, "checkedAt": at(now()),
        "fiveHour": { "usedPercent": 22.5, "resetsAt": "2026-10-13T14:00:00Z" },
        "sevenDay": { "usedPercent": 92, "resetsAt": "2026-10-17T10:00:00Z" },
    })
}

fn usage(id: &str) -> AccountUsage {
    from_json(usage_json(id))
}

/// `{ ...usage("target"), ...patch }`.
fn target_usage(patch: Value) -> AccountUsage {
    from_json(spread(usage_json("target"), patch))
}

fn snapshot_json() -> Value {
    json!({
        "accounts": [account("current", "Current"), account("target", "Max")],
        "usage": { "target": usage_json("target") },
        "desktop": desktop(),
    })
}

fn snapshot() -> TraySnapshot {
    from_json(snapshot_json())
}

/// `{ ...snapshot(), ...patch }`.
fn snapshot_with(patch: Value) -> TraySnapshot {
    from_json(spread(snapshot_json(), patch))
}

/// The snapshot with "target" open in Claude and its five-hour window at `used_percent`.
fn on_target(used_percent: f64, extra: Value, u: Value) -> TraySnapshot {
    let target = spread(
        spread(
            usage_json("target"),
            json!({ "fiveHour": { "usedPercent": used_percent, "resetsAt": "2026-10-13T19:50:00Z" } }),
        ),
        u,
    );
    let s = spread(
        snapshot_json(),
        json!({ "desktop": desktop_with(json!({ "activeProfileId": "target" })), "usage": { "target": target } }),
    );
    from_json(spread(s, extra))
}

fn command_type(command: &TrayCommand) -> String {
    serde_json::to_value(command).unwrap()["type"]
        .as_str()
        .unwrap()
        .to_string()
}

fn checkbox(item: &TrayMenuItem) -> Option<&relay_core::shared::tray::TrayMenuEntry> {
    match item {
        TrayMenuItem::Checkbox(entry) => Some(entry),
        _ => None,
    }
}

#[test]
fn tray_account_action_requests_a_review_and_never_bypasses_restart_consent() {
    let menu = build_tray_menu(&snapshot(), En, now());
    let current = menu
        .iter()
        .filter_map(checkbox)
        .find(|e| e.checked == Some(true))
        .expect("current");
    assert!(!current.enabled);
    assert_eq!(current.command, None);
    let target = menu
        .iter()
        .filter_map(checkbox)
        .find(|e| e.checked != Some(true))
        .expect("target");
    assert_eq!(target.label, "Max · 5 h 22% · week 92% used");
    assert_eq!(
        target.command,
        Some(TrayCommand::ReviewSwitch {
            profile_id: "target".into()
        })
    );
    let commands: Vec<String> = menu
        .iter()
        .filter_map(|i| i.entry()?.command.as_ref().map(command_type))
        .collect();
    assert_eq!(commands, ["show", "review-switch", "quit"]);
}

#[test]
fn tray_disables_all_switch_targets_while_state_is_unavailable_or_occupied() {
    let states = [
        ("initial snapshot", json!({ "desktop": null })),
        (
            "unsupported",
            json!({ "desktop": desktop_with(json!({ "available": false })) }),
        ),
        (
            "Desktop operation",
            json!({ "desktop": desktop_with(json!({ "busy": true })) }),
        ),
        (
            "recovery",
            json!({ "desktop": desktop_with(json!({ "recoveryRequired": true })) }),
        ),
        (
            "Desktop sign-in",
            json!({ "desktop": desktop_with(json!({ "pendingProfileId": "target" })) }),
        ),
        ("CLI sign-in", json!({ "authBusy": true })),
    ];
    for (label, patch) in states {
        let state = snapshot_with(patch);
        assert!(!can_request_tray_switch(&state, "target"), "{label}");
        let menu = build_tray_menu(&state, En, now());
        assert!(
            menu.iter().all(|i| !matches!(
                i.entry().and_then(|e| e.command.as_ref()),
                Some(TrayCommand::ReviewSwitch { .. })
            )),
            "{label}"
        );
        assert!(
            menu.iter()
                .any(|i| i.entry().and_then(|e| e.command.as_ref()) == Some(&TrayCommand::Show)),
            "{label}"
        );
    }
}

#[test]
fn tray_only_offers_saved_desktop_identities_and_blocks_mismatched_cli_identities() {
    let mut s = snapshot();
    s.accounts.push(from_json(spread(
        account("unlinked", "unlinked"),
        json!({ "desktop": null }),
    )));
    s.accounts.push(from_json(spread(
        account("mismatch", "mismatch"),
        json!({ "auth": { "loggedIn": true, "accountUuid": "different-account", "checkedAt": "2026-10-13T10:00:00Z" } }),
    )));
    assert!(!can_request_tray_switch(&s, "unlinked"));
    assert!(!can_request_tray_switch(&s, "mismatch"));
    assert!(!can_request_tray_switch(&s, "deleted"));
    assert!(can_request_tray_switch(&s, "target"));
    assert!(build_tray_menu(&s, En, wall_now()).iter().any(|i| {
        i.entry()
            .is_some_and(|e| e.label.contains("Save Claude app sign-in"))
    }));
}

#[test]
fn unknown_future_and_foreign_quota_stays_unknown_in_the_tray() {
    assert_eq!(
        tray_usage_label("target", None, En, now()),
        "5 h ? · week ?"
    );
    for u in [
        target_usage(json!({ "checkedAt": at(now() + 5.0 * 60_000.0) })),
        usage("different"),
        // A sign-in problem keeps nothing to show, whatever the cache still holds.
        target_usage(json!({ "status": "error", "stale": true, "issue": "keychain-locked" })),
        target_usage(json!({ "stale": true, "connectionRenewalRequired": true })),
    ] {
        assert_eq!(
            tray_usage_label("target", Some(&u), En, now()),
            "5 h ? · week ? · usage data is out of date"
        );
    }
}

#[test]
fn a_reading_old_for_a_passing_reason_keeps_its_figures_in_the_menu_marked_until_each_window_resets()
 {
    for u in [
        target_usage(json!({ "stale": true })),
        target_usage(json!({ "status": "loading" })),
        target_usage(json!({ "status": "error", "stale": true, "issue": "unavailable" })),
        target_usage(json!({ "status": "error", "stale": true, "issue": "rate-limited" })),
        target_usage(json!({ "checkedAt": at(now() - 36.0 * 60_000.0) })),
    ] {
        assert_eq!(
            tray_usage_label("target", Some(&u), En, now()),
            "5 h ~22% · week ~92% used · usage data is out of date"
        );
    }
    assert_eq!(
        tray_usage_label(
            "target",
            Some(&target_usage(json!({ "stale": true }))),
            Tr,
            now()
        ),
        "5 sa ~%22 · hafta ~%92 kullanıldı · limit verisi eski"
    );
    // A window that has reset since is unknown; the other keeps its figure.
    let reset = target_usage(json!({ "fiveHour": { "usedPercent": 0, "resetsAt": at(now()) } }));
    assert_eq!(
        tray_usage_label("target", Some(&reset), En, now()),
        "5 h ? · week ~92% used · usage data is out of date"
    );
}

#[test]
fn a_fresh_reading_s_windows_read_as_they_are() {
    assert_eq!(
        tray_usage_label(
            "target",
            Some(&target_usage(json!({ "sevenDay": null }))),
            En,
            now()
        ),
        "5 h 22% · week ? used"
    );
    let mut nan = usage("target");
    nan.five_hour = Some(UsageWindow::new(f64::NAN, None));
    assert_eq!(
        tray_usage_label("target", Some(&nan), En, now()),
        "5 h ? · week 92% used"
    );
    // With no reading for either window there is nothing the word could describe.
    assert_eq!(
        tray_usage_label(
            "target",
            Some(&target_usage(json!({ "fiveHour": null, "sevenDay": null }))),
            En,
            now()
        ),
        "5 h ? · week ?"
    );
    assert_eq!(
        tray_usage_label(
            "target",
            Some(&target_usage(
                json!({ "fiveHour": { "usedPercent": 130 }, "sevenDay": { "usedPercent": -1 } })
            )),
            Tr,
            now()
        ),
        "5 sa ? · hafta ?"
    );
}

#[test]
fn turkish_labels_escaped_names_and_empty_snapshots_remain_usable() {
    assert_eq!(tray_account_name("A&B\nnext\trow"), "A&&B next row");
    let mut s = snapshot();
    s.accounts[0].name = "A&B\nrow".into();
    assert_eq!(tray_tooltip(&s, En, wall_now()), "Relay — A&B row");
    assert_eq!(
        tray_usage_label("target", Some(&usage("target")), Tr, now()),
        "5 sa %22 · hafta %92 kullanıldı"
    );
    let empty: TraySnapshot =
        from_json(json!({ "accounts": [], "usage": {}, "desktop": desktop() }));
    let empty = build_tray_menu(&empty, Tr, now());
    assert!(
        empty
            .iter()
            .any(|i| i.entry().is_some_and(|e| e.label == "Relay’de hesap ekle"))
    );
    assert!(
        empty
            .iter()
            .any(|i| i.entry().is_some_and(|e| e.label == "Relay’i aç"))
    );
}

#[test]
fn every_menu_row_gives_the_percent_used_of_both_windows_with_its_word_once_in_both_languages() {
    let rows = |language: Locale| -> Vec<String> {
        build_tray_menu(&snapshot(), language, now())
            .iter()
            .filter_map(checkbox)
            .filter(|e| e.label.starts_with("Max"))
            .map(|e| e.label.clone())
            .collect()
    };
    assert_eq!(rows(Tr), ["Max · 5 sa %22 · hafta %92 kullanıldı"]);
    assert_eq!(rows(En), ["Max · 5 h 22% · week 92% used"]);
    // The word closes the row once, never after each figure.
    for label in rows(Tr).into_iter().chain(rows(En)) {
        let count = label.matches("kullanıldı").count() + label.matches("used").count();
        assert_eq!(count, 1, "{label}");
        assert!(
            label.ends_with("kullanıldı") || label.ends_with("used"),
            "{label}"
        );
    }
    // The header over the rows says what a click does.
    let header = |language: Locale| -> Vec<String> {
        build_tray_menu(&snapshot(), language, now())
            .iter()
            .filter_map(|i| match i {
                TrayMenuItem::Normal(e) => Some(e.label.clone()),
                _ => None,
            })
            .filter(|label| {
                let lower = label.to_lowercase();
                lower.contains("hesap seç") || lower.contains("select an account")
            })
            .collect()
    };
    assert_eq!(header(Tr), ["Geçmek için hesap seç"]);
    assert_eq!(header(En), ["Select an account to switch"]);
}

#[test]
fn other_languages_place_the_word_used_where_their_grammar_puts_it_never_glued_after_the_figures() {
    assert_eq!(
        tray_usage_label("target", Some(&usage("target")), Pl, now()),
        "wykorzystano: 5 h 22% · tydzień 92%"
    );
    assert_eq!(
        tray_usage_label("target", Some(&usage("target")), ZhHans, now()),
        "5 小时已用 22% · 每周已用 92%"
    );
    let mut s = snapshot_with(json!({ "titleItems": ["five-hour", "week"] }));
    s.desktop.as_mut().unwrap().active_profile_id = Some("target".into());
    s.usage.insert(
        "target",
        target_usage(json!({ "fiveHour": { "usedPercent": 22.5 } })),
    );
    s.usage.retain(|k, _| k == "target");
    assert_eq!(
        tray_tooltip(&s, En, now()),
        "Relay — Max · 22% used · week 92% used"
    );
    assert_eq!(
        tray_tooltip(&s, Pl, now()),
        "Relay — Max · wykorzystano 22% · tydzień: wykorzystano 92%"
    );
    assert_eq!(
        tray_tooltip(&s, ZhHans, now()),
        "Relay — Max · 已用 22% · 每周已用 92%"
    );
}

/// `s.usage = { target: u }`.
fn set_target(s: &mut TraySnapshot, u: AccountUsage) {
    s.usage = Default::default();
    s.usage.insert("target", u);
}

#[test]
fn the_tooltip_names_the_account_and_carries_the_five_hour_percent_used_with_its_word() {
    let mut s = snapshot();
    s.desktop.as_mut().unwrap().active_profile_id = Some("target".into());
    // With the window's reset known, it also says when the window renews.
    assert_eq!(
        tray_tooltip(&s, En, now()),
        "Relay — Max · 22% used · renews in 4:00"
    );
    assert_eq!(
        tray_tooltip(&s, Tr, now()),
        "Relay — Max · %22 kullanıldı · 4 sa sonra yenilenir"
    );
    // Turkish says the time left in hours and minutes, never as a clock ("1:50 sonra").
    let soon = |minutes: f64| {
        target_usage(
            json!({ "fiveHour": { "usedPercent": 22.5, "resetsAt": at(now() + minutes * 60_000.0) } }),
        )
    };
    set_target(&mut s, soon(110.0));
    assert_eq!(
        tray_tooltip(&s, Tr, now()),
        "Relay — Max · %22 kullanıldı · 1 sa 50 dk sonra yenilenir"
    );
    set_target(&mut s, soon(7.0));
    assert_eq!(
        tray_tooltip(&s, Tr, now()),
        "Relay — Max · %22 kullanıldı · 7 dk sonra yenilenir"
    );
    // Without one, the percent alone.
    set_target(
        &mut s,
        target_usage(json!({ "fiveHour": { "usedPercent": 22.5 } })),
    );
    assert_eq!(tray_tooltip(&s, En, now()), "Relay — Max · 22% used");
    assert_eq!(tray_tooltip(&s, Tr, now()), "Relay — Max · %22 kullanıldı");
    // No fresh reading: the name alone, as before.
    s.usage = Default::default();
    assert_eq!(tray_tooltip(&s, En, now()), "Relay — Max");
    assert_eq!(tray_tooltip(&TraySnapshot::default(), Tr, now()), "Relay");
}

#[test]
fn the_countdown_reads_h_mm_until_the_reset_rounding_up_to_the_minute_and_nothing_once_it_passed() {
    let left = |ms: f64| tray_countdown(Some(&at(now() + ms)), now());
    assert_eq!(left(110.0 * 60_000.0).as_deref(), Some("1:50"));
    assert_eq!(left(7.0 * 60_000.0).as_deref(), Some("0:07"));
    assert_eq!(left(5.0 * 3_600_000.0).as_deref(), Some("5:00"));
    // A part-minute counts as a whole one, so the last seconds read 0:01, never 0:00.
    assert_eq!(left(61_000.0).as_deref(), Some("0:02"));
    assert_eq!(left(1_000.0).as_deref(), Some("0:01"));
    assert_eq!(left(0.0), None);
    assert_eq!(left(-60_000.0), None);
    assert_eq!(tray_countdown(None, now()), None);
    assert_eq!(tray_countdown(Some("soon"), now()), None);
}

#[test]
fn the_menu_bar_title_adds_the_time_left_from_80_used_on_when_the_reset_is_known() {
    let titled = |used: f64, resets_at: Option<&str>, language: Locale| {
        let mut s = snapshot();
        s.desktop.as_mut().unwrap().active_profile_id = Some("target".into());
        let five = match resets_at {
            Some(r) => json!({ "usedPercent": used, "resetsAt": r }),
            None => json!({ "usedPercent": used }),
        };
        set_target(&mut s, target_usage(json!({ "fiveHour": five })));
        tray_title(&s, now(), language)
    };
    let in110 = at(now() + 110.0 * 60_000.0);
    let in110 = Some(in110.as_str());
    // Below 80 % the item stays a plain number.
    assert_eq!(titled(22.5, in110, Tr), "%22");
    assert_eq!(titled(79.9, in110, Tr), "%79");
    assert_eq!(titled(80.0, in110, Tr), "%80 · 1:50");
    assert_eq!(titled(94.0, in110, Tr), "%94 · 1:50");
    assert_eq!(titled(94.0, in110, En), "94% · 1:50");
    // No reset time: the percent alone.
    assert_eq!(titled(94.0, None, Tr), "%94");
    // A reset already past makes the reading old, so the title is empty rather than counting down.
    assert_eq!(titled(94.0, Some(&at(now() - 60_000.0)), Tr), "");
}

#[test]
fn a_full_five_hour_window_shows_the_clock_it_reopens_at_in_the_planning_time_zone() {
    let istanbul = on_target(100.0, json!({ "timeZone": "Europe/Istanbul" }), json!({}));
    assert_eq!(tray_title(&istanbul, now(), Tr), "22:50");
    assert_eq!(tray_title(&istanbul, now(), En), "22:50");
    assert_eq!(
        tray_title(
            &on_target(100.0, json!({ "timeZone": "UTC" }), json!({})),
            now(),
            En
        ),
        "19:50"
    );
    assert_eq!(
        tray_tooltip(&istanbul, Tr, now()),
        "Relay — Max · %100 kullanıldı · 22:50’de açılır"
    );
    assert_eq!(
        tray_tooltip(&istanbul, En, now()),
        "Relay — Max · 100% used · opens at 22:50"
    );
    // 99.9 % is not full yet: the countdown stays.
    assert_eq!(
        tray_title(
            &on_target(99.9, json!({ "timeZone": "UTC" }), json!({})),
            now(),
            Tr
        ),
        "%99 · 9:50"
    );
    // Without a reset time a full window still reads as a percent.
    let mut unknown_reset = on_target(100.0, json!({ "timeZone": "UTC" }), json!({}));
    unknown_reset.usage.get_mut("target").unwrap().five_hour = Some(UsageWindow::new(100.0, None));
    assert_eq!(tray_title(&unknown_reset, now(), Tr), "%100");
    // An unknown zone falls back to the system's clock rather than failing.
    let mars = tray_title(
        &on_target(100.0, json!({ "timeZone": "Mars/Olympus" }), json!({})),
        now(),
        En,
    );
    let bytes = mars.as_bytes();
    assert!(
        bytes.len() == 5
            && bytes[2] == b':'
            && [0, 1, 3, 4].iter().all(|i| bytes[*i].is_ascii_digit()),
        "{mars}"
    );
    assert_eq!(
        tray_reset_clock(Some("2026-10-13T19:50:00Z"), now(), En, Some("UTC")).as_deref(),
        Some("19:50")
    );
    assert_eq!(
        tray_reset_clock(Some("2026-10-13T09:00:00Z"), now(), En, Some("UTC")),
        None
    );
}

#[test]
fn while_a_switch_runs_the_title_names_the_account_it_opens_cut_short_when_long() {
    let busy = |switching_to: Option<&str>| {
        on_target(
            40.0,
            json!({
                "switchingTo": switching_to,
                "desktop": desktop_with(json!({ "activeProfileId": "target", "busy": true, "running": false })),
            }),
            json!({}),
        )
    };
    assert_eq!(tray_title(&busy(Some("current")), now(), Tr), "Current…");
    assert_eq!(
        tray_tooltip(&busy(Some("current")), Tr, now()),
        "Relay — Current hesabına geçiliyor…"
    );
    assert_eq!(
        tray_tooltip(&busy(Some("current")), En, now()),
        "Relay switches to Current…"
    );
    let mut long = busy(Some("current"));
    long.accounts[0].name = "Şirket hesabı (ekip)\nikinci".into();
    assert_eq!(tray_title(&long, now(), Tr), "Şirket hesabı…");
    assert_eq!(
        tray_short_name("Abcdefghijklmn", TRAY_NAME_MAX),
        "Abcdefghijklmn"
    );
    assert_eq!(
        tray_short_name("Abcdefghijklmno", TRAY_NAME_MAX),
        "Abcdefghijklm"
    );
    // Busy with no known target (a save, a link): the title keeps the percent, though Claude may
    // be closed.
    assert_eq!(tray_title(&busy(None), now(), Tr), "%40");
    // A target left over once Desktop is no longer busy is ignored.
    assert_eq!(
        tray_title(
            &on_target(40.0, json!({ "switchingTo": "current" }), json!({})),
            now(),
            Tr
        ),
        "%40"
    );
}

fn closed_desktop() -> Value {
    json!({ "desktop": desktop_with(json!({ "activeProfileId": "target", "running": false })) })
}

#[test]
fn the_title_shows_a_dash_while_claude_is_closed_or_a_sign_in_problem_keeps_the_limits_unknown() {
    let closed = on_target(40.0, closed_desktop(), json!({}));
    assert_eq!(tray_title(&closed, now(), Tr), "—");
    assert_eq!(
        tray_tooltip(&closed, Tr, now()),
        "Relay — Max · Claude uygulaması kapalı"
    );
    assert_eq!(
        tray_tooltip(&closed, En, now()),
        "Relay — Max · Claude app closed"
    );
    // Expired, scope, a missing or foreign sign-in: the service keeps nothing of the last reading.
    let expired = json!({
        "status": "error", "stale": false, "issue": "expired", "fiveHour": null, "sevenDay": null, "checkedAt": null,
    });
    assert_eq!(
        tray_title(&on_target(40.0, json!({}), expired.clone()), now(), Tr),
        "—"
    );
    assert_eq!(
        tray_tooltip(&on_target(40.0, json!({}), expired), En, now()),
        "Relay — Max · usage data is out of date"
    );
    // A locked Keychain or a connection to renew keeps the figures in the cache, but they are not
    // shown.
    for sign_in in [
        json!({ "status": "error", "stale": true, "issue": "keychain-locked" }),
        json!({ "status": "error", "stale": true, "issue": "renewal-required" }),
        json!({ "stale": true, "connectionRenewalRequired": true }),
    ] {
        let s = on_target(40.0, json!({}), sign_in.clone());
        assert_eq!(tray_title(&s, now(), Tr), "—", "{sign_in}");
        assert_eq!(
            tray_tooltip(&s, Tr, now()),
            "Relay — Max · limit verisi eski",
            "{sign_in}"
        );
    }
    assert_eq!(
        tray_title(
            &on_target(
                40.0,
                json!({}),
                json!({ "checkedAt": at(now() - 29.0 * 60_000.0) })
            ),
            now(),
            Tr
        ),
        "%40"
    );
    // A refresh in progress keeps the reading it started from.
    assert_eq!(
        tray_title(
            &on_target(40.0, json!({}), json!({ "status": "loading" })),
            now(),
            Tr
        ),
        "%40"
    );
    // Before the first reading, and with no saved account open, there is nothing to sleep over.
    assert_eq!(
        tray_title(
            &on_target(40.0, json!({ "usage": {} }), json!({})),
            now(),
            Tr
        ),
        ""
    );
    assert_eq!(
        tray_title(
            &on_target(
                40.0,
                json!({}),
                json!({ "status": "loading", "checkedAt": null })
            ),
            now(),
            Tr
        ),
        ""
    );
    assert_eq!(
        tray_title(
            &snapshot_with(json!({ "desktop": desktop_with(json!({ "activeProfileId": null })) })),
            now(),
            Tr
        ),
        ""
    );
}

#[test]
fn a_read_that_fails_for_a_passing_reason_keeps_the_last_figure_in_the_title_marked_while_the_panda_sleeps()
 {
    // No network, a rate limit, the service down: Relay keeps the previous reading, marked stale.
    for issue in ["unavailable", "rate-limited"] {
        let failed = on_target(
            40.0,
            json!({}),
            json!({ "status": "error", "stale": true, "issue": issue }),
        );
        assert_eq!(tray_title(&failed, now(), Tr), "~%40", "{issue}");
        assert_eq!(tray_title(&failed, now(), En), "~40%", "{issue}");
        assert_eq!(
            mascot_rest(failed.mascot_input(), now()),
            Some(MascotRest::Unknown),
            "{issue}"
        );
        assert_eq!(
            mascot_pose(failed.mascot_input(), now()),
            MascotPose::Sleeping,
            "{issue}"
        );
        assert_eq!(
            tray_tooltip(&failed, Tr, now()),
            "Relay — Max · ~%40 kullanıldı · 9 sa 50 dk sonra yenilenir · limit verisi eski, az önce okundu",
            "{issue}"
        );
        // The read after it starts from the same reading.
        assert_eq!(
            tray_title(
                &on_target(
                    40.0,
                    json!({}),
                    json!({ "status": "loading", "stale": true, "issue": issue })
                ),
                now(),
                Tr
            ),
            "~%40",
            "{issue}"
        );
    }
    // A reading that has only grown old.
    let old = on_target(
        40.0,
        json!({}),
        json!({ "checkedAt": at(now() - 31.0 * 60_000.0) }),
    );
    assert_eq!(tray_title(&old, now(), Tr), "~%40");
    assert_eq!(
        tray_tooltip(&old, En, now()),
        "Relay — Max · ~40% used · renews in 9:50 · usage data is out of date, read 31 min ago"
    );
    // From 80 % on the countdown still follows; it holds, the reset time does not change.
    assert_eq!(
        tray_title(
            &on_target(94.0, json!({}), json!({ "stale": true })),
            now(),
            Tr
        ),
        "~%94 · 9:50"
    );
    // A full window stays full until it resets: its clock needs no mark.
    assert_eq!(
        tray_title(
            &on_target(
                100.0,
                json!({ "timeZone": "Europe/Istanbul" }),
                json!({ "stale": true })
            ),
            now(),
            Tr
        ),
        "22:50"
    );
    // Once the window has reset the old figure says nothing: the dash.
    let later = ms("2026-10-13T19:51:00Z");
    assert_eq!(
        tray_title(
            &on_target(40.0, json!({}), json!({ "stale": true })),
            later,
            Tr
        ),
        "—"
    );
    // A reading from the future is not one.
    assert_eq!(
        tray_title(
            &on_target(
                40.0,
                json!({}),
                json!({ "stale": true, "checkedAt": at(now() + 5.0 * 60_000.0) })
            ),
            now(),
            Tr
        ),
        "—"
    );
}

fn today() -> Value {
    json!({ "date": "2026-10-13", "tokens": 12_430_000, "cost": 18.2 })
}

fn thin(parts: &[&str]) -> String {
    parts.join("\u{2009}·\u{2009}")
}

#[test]
fn the_title_shows_the_items_chosen_in_their_order() {
    let titled = |items: Option<&[&str]>, language: Locale, used: f64, extra: Value, u: Value| {
        let base = json!({ "titleItems": items, "today": today(), "timeZone": "UTC" });
        tray_title(&on_target(used, spread(base, extra), u), now(), language)
    };
    let t = |items: &[&str]| titled(Some(items), Tr, 40.0, json!({}), json!({}));
    // Nothing chosen yet: the five-hour percent, as always.
    assert_eq!(titled(None, Tr, 40.0, json!({}), json!({})), "%40");
    assert_eq!(t(&["five-hour"]), "%40");
    assert_eq!(t(&["week"]), "%92");
    assert_eq!(t(&["five-hour", "week"]), "%40 · %92");
    // The time left has its own item; with it the percent never adds it again.
    assert_eq!(t(&["reset"]), "9:50");
    let istanbul = || json!({ "timeZone": "Europe/Istanbul" });
    assert_eq!(
        titled(
            Some(&["five-hour", "reset"]),
            Tr,
            94.0,
            json!({}),
            json!({})
        ),
        "%94 · 9:50"
    );
    assert_eq!(
        titled(
            Some(&["five-hour", "reset"]),
            En,
            40.0,
            json!({}),
            json!({})
        ),
        "40% · 9:50"
    );
    assert_eq!(
        titled(
            Some(&["five-hour", "reset"]),
            Tr,
            100.0,
            istanbul(),
            json!({})
        ),
        "%100 · 22:50"
    );
    assert_eq!(
        titled(Some(&["reset"]), Tr, 100.0, istanbul(), json!({})),
        "22:50"
    );
    // Today's tokens in millions and their API value, across all accounts.
    assert_eq!(t(&["tokens"]), "12,4M");
    assert_eq!(
        titled(Some(&["tokens"]), En, 40.0, json!({}), json!({})),
        "12.4M"
    );
    assert_eq!(t(&["cost"]), "$18,20");
    assert_eq!(
        titled(Some(&["cost"]), En, 40.0, json!({}), json!({})),
        "$18.20"
    );
    assert_eq!(
        titled(
            Some(&["cost"]),
            Tr,
            40.0,
            json!({ "today": spread(today(), json!({ "costEstimated": true })) }),
            json!({})
        ),
        "≈$18,20"
    );
    assert_eq!(t(&["account"]), "Max");
    assert_eq!(t(&["cost", "five-hour", "tokens"]), "$18,20 · %40 · 12,4M");
    // More than three parts get thin spaces around the dot.
    assert_eq!(
        t(&["five-hour", "week", "tokens", "cost"]),
        thin(&["%40", "%92", "12,4M", "$18,20"])
    );
    assert_eq!(
        titled(
            Some(&["five-hour", "tokens", "cost"]),
            Tr,
            94.0,
            json!({}),
            json!({})
        ),
        thin(&["%94", "9:50", "12,4M", "$18,20"])
    );
    // With four items there is no room left for the countdown the percent would add.
    assert_eq!(
        titled(
            Some(&["five-hour", "week", "tokens", "cost"]),
            Tr,
            94.0,
            json!({}),
            json!({})
        ),
        thin(&["%94", "%92", "12,4M", "$18,20"])
    );
    // None chosen: the panda alone.
    assert_eq!(t(&[]), "");
    // Yesterday's figures, or none yet, are left out.
    assert_eq!(
        titled(
            Some(&["five-hour", "tokens"]),
            Tr,
            40.0,
            json!({ "today": spread(today(), json!({ "date": "2026-10-12" })) }),
            json!({})
        ),
        "%40"
    );
    assert_eq!(
        titled(
            Some(&["five-hour", "cost"]),
            Tr,
            40.0,
            json!({ "today": null }),
            json!({})
        ),
        "%40"
    );
    // Last known figures each carry the mark; today's figures do not need it.
    assert_eq!(
        titled(
            Some(&["five-hour", "week", "tokens"]),
            Tr,
            40.0,
            json!({}),
            json!({ "status": "error", "stale": true, "issue": "unavailable" })
        ),
        "~%40 · ~%92 · 12,4M"
    );
    // Claude closed: one dash for the limits, whatever else is chosen stays.
    assert_eq!(
        titled(
            Some(&["five-hour", "week", "tokens", "account"]),
            Tr,
            40.0,
            closed_desktop(),
            json!({})
        ),
        "— · 12,4M · Max"
    );
    assert_eq!(
        titled(
            Some(&["week", "reset"]),
            Tr,
            40.0,
            closed_desktop(),
            json!({})
        ),
        "—"
    );
    // A switch names its target whatever is chosen.
    let switching = json!({
        "switchingTo": "current",
        "desktop": desktop_with(json!({ "activeProfileId": "target", "busy": true })),
    });
    assert_eq!(
        titled(Some(&["tokens", "cost"]), Tr, 40.0, switching, json!({})),
        "Current…"
    );
    // A long name is cut shorter than a switch's, and says so.
    let mut long = on_target(
        40.0,
        json!({ "titleItems": ["account", "five-hour"] }),
        json!({}),
    );
    long.accounts[1].name = "Şirket hesabı (ekip)".into();
    assert_eq!(tray_title(&long, now(), Tr), "Şirket he… · %40");
}

#[test]
fn the_title_s_items_name_themselves_in_the_tooltip() {
    let s = on_target(
        40.0,
        json!({ "titleItems": ["five-hour", "week", "tokens", "cost"], "today": today(), "timeZone": "UTC" }),
        json!({}),
    );
    assert_eq!(
        tray_tooltip(&s, Tr, now()),
        "Relay — Max · %40 kullanıldı · 9 sa 50 dk sonra yenilenir · hafta %92 kullanıldı · bugün 12,4M token, $18,20 API karşılığı"
    );
    assert_eq!(
        tray_tooltip(&s, En, now()),
        "Relay — Max · 40% used · renews in 9:50 · week 92% used · today 12.4M tokens, $18.20 API value"
    );
    // With Claude closed, today's figures still say what they are.
    let mut closed = s.clone();
    closed.desktop = from_json(desktop_with(
        json!({ "activeProfileId": "target", "running": false }),
    ));
    assert_eq!(
        tray_tooltip(&closed, Tr, now()),
        "Relay — Max · Claude uygulaması kapalı · bugün 12,4M token, $18,20 API karşılığı"
    );
}

#[test]
fn tokens_read_in_millions_and_the_api_value_in_dollars_short() {
    assert_eq!(tray_tokens(0.0, Tr), "0,0M");
    assert_eq!(tray_tokens(430_000.0, En), "0.4M");
    assert_eq!(tray_tokens(12_430_000.0, Tr), "12,4M");
    // From 100M on, whole millions; never "100,0M".
    assert_eq!(tray_tokens(99_960_000.0, Tr), "100M");
    assert_eq!(tray_tokens(184_400_000.0, En), "184M");
    // From a billion, billions: "milyar" in Turkish, where "B" would read as "bin".
    assert_eq!(tray_tokens(999_400_000.0, En), "999M");
    assert_eq!(tray_tokens(999_600_000.0, Tr), "1,0Mr");
    assert_eq!(tray_tokens(1_823_000_000.0, Tr), "1,8Mr");
    assert_eq!(tray_tokens(1_234_000_000.0, En), "1.2B");
    assert_eq!(tray_tokens(f64::NAN, En), "0.0M");
    assert_eq!(tray_cost(18.2, Tr, false), "$18,20");
    assert_eq!(tray_cost(99.99, En, false), "$99.99");
    assert_eq!(tray_cost(184.4, En, false), "$184");
    assert_eq!(tray_cost(1234.5, Tr, false), "$1.235");
    assert_eq!(tray_cost(5.0, En, true), "≈$5.00");
    assert_eq!(tray_cost(-1.0, En, false), "$0.00");
}

fn strs(items: &[MenuBarItem]) -> Vec<&'static str> {
    items.iter().map(|i| i.as_str()).collect()
}

#[test]
fn the_title_s_items_are_kept_known_once_each_and_at_most_four() {
    assert_eq!(strs(&menu_bar_items(None)), ["five-hour"]);
    assert_eq!(strs(&menu_bar_items(Some(&json!("tokens")))), ["five-hour"]);
    assert!(menu_bar_items(Some(&json!([]))).is_empty());
    assert_eq!(
        strs(&menu_bar_items(Some(&json!([
            "tokens", "bogus", "tokens", "cost", "week", "reset", "account"
        ])))),
        ["tokens", "cost", "week", "reset"]
    );
    assert_eq!(MENU_BAR_MAX_ITEMS, 4);
    assert_eq!(
        strs(&MENU_BAR_ITEMS),
        ["five-hour", "week", "reset", "tokens", "cost", "account"]
    );
    assert_eq!(strs(&DEFAULT_MENU_BAR_ITEMS), ["five-hour"]);
}

fn combos(from: usize, size: usize) -> Vec<Vec<MenuBarItem>> {
    if size == 0 {
        return vec![Vec::new()];
    }
    MENU_BAR_ITEMS[from..]
        .iter()
        .enumerate()
        .flat_map(|(i, item)| {
            combos(from + i + 1, size - 1).into_iter().map(move |rest| {
                let mut all = vec![*item];
                all.extend(rest);
                all
            })
        })
        .collect()
}

/// `String.prototype.length`.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

#[test]
fn any_four_items_stay_a_short_title() {
    // The widest figure of each item: a stale full week, a clock, a thousand millions, an
    // estimated thousand dollars, a long name.
    let mut wide = on_target(
        99.0,
        json!({
            "timeZone": "UTC",
            "today": { "date": "2026-10-13", "tokens": 1_234_000_000_u64, "cost": 1234, "costEstimated": true },
        }),
        json!({ "stale": true, "sevenDay": { "usedPercent": 100, "resetsAt": "2026-10-17T10:00:00Z" } }),
    );
    wide.accounts[1].name = "Çok uzun bir hesap adı".into();
    let mut widest = String::new();
    for size in 1..=MENU_BAR_MAX_ITEMS {
        for items in combos(0, size) {
            for language in [Tr, En] {
                let title = tray_title(
                    &TraySnapshot {
                        title_items: Some(items.clone()),
                        ..wide.clone()
                    },
                    now(),
                    language,
                );
                // Never more than four parts, whatever is chosen.
                let parts = title
                    .split(" · ")
                    .flat_map(|p| p.split("\u{2009}·\u{2009}"));
                assert!(parts.count() <= MENU_BAR_MAX_ITEMS, "{title}");
                if js_length(&title) > js_length(&widest) {
                    widest = title;
                }
            }
        }
    }
    assert_eq!(widest, thin(&["~%100", "1,2Mr", "≈$1.234", "Çok uzun…"]));
    assert!(js_length(&widest) <= 36, "{widest}");
}

#[test]
fn a_fresh_recheck_rejects_a_target_when_desktop_changes_after_menu_creation() {
    let mut s = snapshot();
    let target = build_tray_menu(&s, En, now()).into_iter().find(|i| {
        matches!(
            i.entry().and_then(|e| e.command.as_ref()),
            Some(TrayCommand::ReviewSwitch { .. })
        )
    });
    assert!(target.is_some());
    s.desktop.as_mut().unwrap().busy = true;
    assert!(!can_request_tray_switch(&s, "target"));
    s.desktop.as_mut().unwrap().busy = false;
    s.desktop.as_mut().unwrap().active_profile_id = Some("target".into());
    assert!(!can_request_tray_switch(&s, "target"));
}

#[test]
fn tray_names_the_two_sign_ins_the_way_the_app_does_while_one_is_unfinished() {
    let label_for = |patch: Value, language: Locale| -> Vec<String> {
        build_tray_menu(&snapshot_with(patch), language, now())
            .iter()
            .filter_map(|i| i.entry().filter(|e| !e.enabled).map(|e| e.label.clone()))
            .collect()
    };
    let pending = || json!({ "desktop": desktop_with(json!({ "pendingProfileId": "target" })) });
    assert!(label_for(pending(), Tr).contains(&"Önce Claude uygulaması girişini tamamla".into()));
    assert!(label_for(pending(), En).contains(&"Finish the Claude app sign-in first".into()));
    assert!(
        label_for(json!({ "authBusy": true }), Tr)
            .contains(&"Önce limit okuma girişini tamamla".into())
    );
    assert!(
        label_for(json!({ "authBusy": true }), En)
            .contains(&"Finish the usage sign-in first".into())
    );
}

#[test]
fn the_fallback_menu_follows_the_language_and_offers_only_open_and_quit() {
    let labels = |language: Locale| -> Vec<String> {
        unavailable_tray_menu(language)
            .iter()
            .map(|i| i.entry().map_or("-".into(), |e| e.label.clone()))
            .collect()
    };
    assert_eq!(
        labels(En),
        [
            "Open Relay",
            "Claude app status unavailable",
            "-",
            "Quit Relay"
        ]
    );
    assert_eq!(
        labels(Tr),
        [
            "Relay’i aç",
            "Claude uygulamasının durumu okunamadı",
            "-",
            "Relay’den çık"
        ]
    );
    let commands: Vec<String> = unavailable_tray_menu(Tr)
        .iter()
        .filter_map(|i| match i {
            TrayMenuItem::Normal(e) => e.command.as_ref().map(command_type),
            _ => None,
        })
        .collect();
    assert_eq!(commands, ["show", "quit"]);
}
