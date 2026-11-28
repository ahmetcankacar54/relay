//! Claude's split view across a switch: its page empties it the first time it starts under
//! another account, so Relay writes it back and starts Claude once more.

#[path = "common/desktop.rs"]
mod helpers;

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use helpers::{FakeHost, Fixture, session};
use relay_core::desktop_files::{
    DESKTOP_PREFERENCES, json_bytes, pane_layout, pane_layout_sessions, plan_pane_layout,
    read_object, write_bytes,
};
use relay_core::shared::types::{Account, DesktopHistoryTransfer};
use serde_json::{Map, Value, json};

type Events = Arc<Mutex<Vec<(String, Option<Map<String, Value>>)>>>;

fn layout(front: &str, beside: &[&str]) -> Value {
    let panes: Vec<Value> = beside
        .iter()
        .enumerate()
        .map(|(col, id)| json!({ "ref": { "kind": "code", "id": id }, "pos": { "col": col + 1, "row": 0 } }))
        .collect();
    json!({
        "state": {
            "extraPanesByMode": { "code": panes },
            "colWeightsByMode": {},
            "rowSplit": 0.5,
            "draftNonce": 0,
            "lastPrimaryCodeSession": { "id": front, "type": "local" },
        },
        "version": 4,
    })
}

fn empty_layout() -> Value {
    json!({ "state": { "extraPanesByMode": {}, "colWeightsByMode": {}, "rowSplit": 0.5, "draftNonce": 0, "lastPrimaryCodeSession": null }, "version": 4 })
}

fn preferences(layout: &Value) -> Value {
    json!({ "preferences": { "epitaxyPrefs": { "desktop-frame.paneStore.v1": layout, "other": 1 }, "keep": true } })
}

fn shown(f: &Fixture) -> Vec<String> {
    let config = read_object(&f.root, DESKTOP_PREFERENCES).unwrap();
    pane_layout(config.as_ref()).map_or_else(Vec::new, |l| pane_layout_sessions(&l))
}

/// Two accounts, A in Claude; `ids` are Code sessions both accounts hold (as history transfer
/// leaves them), `only_a` sessions A alone holds. Returns the fixture, A, B and the local ids.
fn two_accounts(ids: usize, only_a: usize) -> (Fixture, Account, Account, Vec<String>) {
    let f = Fixture::new();
    let a = f.account("A", None);
    let b = f.account("B", None);
    f.manager.switch_to(&a.id, Default::default()).unwrap();
    // The sessions each account holds are set up here, as history transfer would leave them.
    f.store
        .update(|s| s.settings.desktop_history_transfer = DesktopHistoryTransfer::Off)
        .unwrap();
    let mut local = Vec::new();
    for n in 0..ids + only_a {
        let (id, _) = session(&f.root, &a, None, json!({}));
        if n < ids {
            session(&f.root, &b, Some(&id), json!({}));
        }
        local.push(format!("local_{id}"));
    }
    f.manager.configure(|h| {
        h.layout_clear_ms = 300;
        h.layout_poll_ms = 10;
    });
    (f, a, b, local)
}

fn record(f: &Fixture) -> Events {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    f.manager.configure(|h| {
        h.on_draft_event = Some(Arc::new(
            move |event: &str, fields: Option<&Map<String, Value>>| {
                sink.lock()
                    .unwrap()
                    .push((event.to_string(), fields.cloned()));
            },
        ))
    });
    events
}

fn layout_event(events: &Events) -> Map<String, Value> {
    events
        .lock()
        .unwrap()
        .iter()
        .find(|(e, _)| e == "pane-layout")
        .and_then(|(_, fields)| fields.clone())
        .expect("a pane-layout event")
}

/// Claude's page on its first start after the switch: it empties the split view.
fn page_empties_on_first_start(f: &Fixture) -> Arc<AtomicU32> {
    let starts = Arc::new(AtomicU32::new(0));
    let (count, root) = (Arc::clone(&starts), f.root.clone());
    FakeHost::set(
        &f.host.watch_launch,
        Arc::new(move |_: &FakeHost| {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                write_bytes(
                    &root,
                    DESKTOP_PREFERENCES,
                    Some(&json_bytes(&preferences(&empty_layout()))),
                )
                .unwrap();
            }
            None
        }),
    );
    starts
}

#[test]
fn a_switch_brings_back_every_session_of_the_split_view_that_claude_emptied() {
    let (f, _a, b, ids) = two_accounts(5, 0);
    let refs: Vec<&str> = ids[1..].iter().map(String::as_str).collect();
    write_bytes(
        &f.root,
        DESKTOP_PREFERENCES,
        Some(&json_bytes(&preferences(&layout(&ids[0], &refs)))),
    )
    .unwrap();
    let starts = page_empties_on_first_start(&f);
    let events = record(&f);
    f.host.st().order.clear();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(
        shown(&f),
        ids,
        "the front session first, then all four beside it"
    );
    // Claude was quit once more and started again on the same account, which keeps the view.
    assert_eq!(starts.load(Ordering::SeqCst), 2);
    assert_eq!(f.host.st().order, ["quit", "launch", "quit", "launch"]);
    let event = layout_event(&events);
    assert_eq!(event["result"], json!("restored"));
    assert_eq!(event["restored"], json!(5));
    // The rest of Claude's preferences is as Claude left it.
    let config = read_object(&f.root, DESKTOP_PREFERENCES).unwrap().unwrap();
    assert_eq!(config["preferences"]["keep"], json!(true));
    assert_eq!(config["preferences"]["epitaxyPrefs"]["other"], json!(1));
}

#[test]
fn sessions_the_account_switched_to_lacks_are_left_out_of_the_view() {
    let (f, _a, b, ids) = two_accounts(2, 1);
    write_bytes(
        &f.root,
        DESKTOP_PREFERENCES,
        Some(&json_bytes(&preferences(&layout(
            &ids[0],
            &[&ids[2], &ids[1]],
        )))),
    )
    .unwrap();
    page_empties_on_first_start(&f);
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(shown(&f), [ids[0].clone(), ids[1].clone()]);
}

#[test]
fn a_view_whose_front_session_the_account_lacks_is_not_written_and_claude_is_not_restarted() {
    let (f, _a, b, ids) = two_accounts(1, 1);
    write_bytes(
        &f.root,
        DESKTOP_PREFERENCES,
        Some(&json_bytes(&preferences(&layout(&ids[1], &[&ids[0]])))),
    )
    .unwrap();
    page_empties_on_first_start(&f);
    let events = record(&f);
    f.host.st().order.clear();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert!(shown(&f).is_empty());
    assert_eq!(f.host.st().order, ["quit", "launch"]);
    assert_eq!(layout_event(&events)["result"], json!("missing"));
}

#[test]
fn a_view_claude_kept_needs_no_second_start() {
    let (f, _a, b, ids) = two_accounts(2, 0);
    write_bytes(
        &f.root,
        DESKTOP_PREFERENCES,
        Some(&json_bytes(&preferences(&layout(&ids[0], &[&ids[1]])))),
    )
    .unwrap();
    let events = record(&f);
    f.host.st().order.clear();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(shown(&f), ids);
    assert_eq!(f.host.st().order, ["quit", "launch"]);
    assert_eq!(layout_event(&events)["result"], json!("kept"));
}

#[test]
fn without_a_split_view_a_switch_starts_claude_once() {
    let (f, _a, b, _ids) = two_accounts(1, 0);
    write_bytes(
        &f.root,
        DESKTOP_PREFERENCES,
        Some(&json_bytes(&preferences(&empty_layout()))),
    )
    .unwrap();
    let events = record(&f);
    f.host.st().order.clear();
    f.manager.switch_to(&b.id, Default::default()).unwrap();
    assert_eq!(f.host.st().order, ["quit", "launch"]);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .all(|(e, _)| e != "pane-layout")
    );
}

#[test]
fn planning_a_view_back_refuses_one_already_shown_and_keeps_unknown_kinds_out() {
    let saved = layout("local_a", &["local_b"]);
    let has = |id: &str| id != "local_gone";
    let shown_now = preferences(&saved);
    assert!(plan_pane_layout(shown_now.as_object(), &saved, &has).is_none());
    let mut with_chat = saved.clone();
    with_chat["state"]["extraPanesByMode"]["code"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "ref": { "kind": "chat", "id": "conv" }, "pos": { "col": 2, "row": 0 } }));
    let emptied = preferences(&empty_layout());
    let next = plan_pane_layout(emptied.as_object(), &with_chat, &has).unwrap();
    assert_eq!(
        pane_layout_sessions(&pane_layout(Some(&next)).unwrap()),
        ["local_a", "local_b"]
    );
    // No preferences at all: nothing to write into.
    assert!(plan_pane_layout(json!({}).as_object(), &saved, &has).is_none());
}
