//! The bridge's channel table: every channel the UI calls (src/data/tauri-bridge.ts, and
//! electron/preload.ts while it exists) has a handler, and nothing else is registered. Plus the
//! dispatch rules that need no running core: who may call, unknown channels, and the argument
//! checks of `Call`.

use std::collections::BTreeSet;
use std::path::PathBuf;

use relay_app::ipc::{Call, Sender, dispatch, dispatch_send, invoke_channels, send_channels};
use serde_json::{Value, json};

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every `"relay:<name>"` literal between `start` and the `}` that closes its object.
fn channels_in_block(source: &str, start: &str) -> BTreeSet<String> {
    let from = source
        .find(start)
        .unwrap_or_else(|| panic!("{start} not found"));
    let block = &source[from..];
    let block = &block[..block.find("\n}").expect("block end")];
    quoted_channels(block)
}

fn quoted_channels(text: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find("\"relay:") {
        let tail = &rest[at + 1..];
        let end = tail.find('"').expect("closing quote");
        found.insert(tail[..end].to_owned());
        rest = &tail[end..];
    }
    found
}

/// The channels a TS file passes to `ipcRenderer.<method>(`.
fn preload_channels(source: &str, method: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    let needle = format!("ipcRenderer.{method}(");
    let mut rest = source;
    while let Some(at) = rest.find(&needle) {
        let tail = rest[at + needle.len()..].trim_start();
        if let Some(name) = tail.strip_prefix('"') {
            let end = name.find('"').expect("closing quote");
            found.insert(name[..end].to_owned());
        }
        rest = &rest[at + needle.len()..];
    }
    found
}

fn registered_invoke() -> BTreeSet<String> {
    invoke_channels().into_iter().collect()
}

fn registered_send() -> BTreeSet<String> {
    send_channels().into_iter().collect()
}

#[test]
fn every_bridge_channel_has_a_handler_and_no_other_is_registered() {
    let bridge = std::fs::read_to_string(repo().join("src/data/tauri-bridge.ts")).unwrap();
    let mut invoke = channels_in_block(&bridge, "export const CHANNELS = {");
    invoke.insert("relay:legacy-ui-storage".into());
    let mut send = channels_in_block(&bridge, "export const SEND_CHANNELS = {");
    send.insert("relay:switch-ready".into());
    let registered = registered_invoke();
    let missing: Vec<_> = invoke.difference(&registered).collect();
    let extra: Vec<_> = registered.difference(&invoke).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "invoke channels: missing {missing:?}, extra {extra:?}"
    );
    assert_eq!(registered_send(), send);
}

#[test]
fn every_electron_preload_channel_has_a_handler() {
    let preload = repo().join("electron/preload.ts");
    // Phase 6 deletes the Electron preload; the bridge test above stays.
    let Ok(preload) = std::fs::read_to_string(preload) else {
        return;
    };
    let switch_preload =
        std::fs::read_to_string(repo().join("electron/switch-preload.ts")).unwrap_or_default();
    let invoke = preload_channels(&preload, "invoke");
    assert!(
        invoke.len() >= 118,
        "{} invoke channels parsed",
        invoke.len()
    );
    let registered = registered_invoke();
    let missing: Vec<_> = invoke.difference(&registered).collect();
    assert!(missing.is_empty(), "no handler for {missing:?}");
    let mut send = preload_channels(&preload, "send");
    send.extend(preload_channels(&switch_preload, "send"));
    assert_eq!(registered_send(), send);
}

#[test]
fn only_the_main_window_and_the_panel_may_invoke() {
    let call = Call::new(Sender::Switch, Vec::new());
    assert_eq!(
        dispatch("relay:snapshot", &call),
        Err("Invalid IPC source.".to_owned())
    );
}

#[test]
fn an_unknown_channel_is_refused_as_electron_refused_it() {
    let call = Call::new(Sender::Main, Vec::new());
    assert_eq!(
        dispatch("relay:nope", &call),
        Err("No handler registered for 'relay:nope'".to_owned())
    );
    assert!(dispatch("snapshot", &call).is_err());
}

#[test]
fn a_call_before_startup_is_refused() {
    let call = Call::new(Sender::Main, Vec::new());
    assert_eq!(
        dispatch("relay:snapshot", &call),
        Err("Relay is still starting.".to_owned())
    );
}

#[test]
fn one_way_channels_keep_their_windows() {
    let main = Call::new(Sender::Main, vec![json!(100)]);
    assert_eq!(
        dispatch_send("relay:panel-size", &main),
        Err("Invalid IPC source.".to_owned())
    );
    assert_eq!(
        dispatch_send("relay:panel-close", &main),
        Err("Invalid IPC source.".to_owned())
    );
    assert_eq!(
        dispatch_send("relay:switch-ready", &main),
        Err("Invalid IPC source.".to_owned())
    );
    let switch = Call::new(Sender::Switch, vec![json!(crate_uuid()), json!("x")]);
    assert_eq!(
        dispatch_send("relay:write", &switch),
        Err("Invalid IPC source.".to_owned())
    );
}

fn crate_uuid() -> String {
    "6f1c3d2e-8a4b-4c5d-9e6f-7a8b9c0d1e2f".into()
}

#[test]
fn ids_are_uuids_and_say_so_as_zod_did() {
    let call = Call::new(
        Sender::Main,
        vec![json!("../../invalid"), json!(crate_uuid())],
    );
    let error = call.id(0).unwrap_err();
    let issues: Value = serde_json::from_str(&error).expect("zod issues as JSON");
    assert_eq!(issues[0]["code"], "invalid_format");
    assert_eq!(issues[0]["path"], json!([]));
    assert_eq!(call.id(1).unwrap(), crate_uuid());
}

#[test]
fn optional_arguments_take_null_and_missing() {
    let call = Call::new(Sender::Main, vec![Value::Null]);
    assert_eq!(call.opt_id(0).unwrap(), None);
    assert_eq!(call.opt_id(3).unwrap(), None);
    assert!(call.id(0).is_err(), "a required id refuses null");
    let bad = Call::new(Sender::Main, vec![json!(7)]);
    assert!(bad.opt_id(0).is_err());
}

#[test]
fn numbers_keep_their_bounds() {
    let call = Call::new(Sender::Main, vec![json!(168), json!(169), json!(1.5)]);
    assert_eq!(call.int(0, 0.0, 168.0).unwrap(), 168);
    let too_big: Value = serde_json::from_str(&call.int(1, 0.0, 168.0).unwrap_err()).unwrap();
    assert_eq!(too_big[0]["code"], "too_big");
    assert!(call.int(2, 0.0, 168.0).is_err(), "not an integer");
}

#[test]
fn session_keys_are_one_to_a_hundred_characters() {
    let call = Call::new(
        Sender::Main,
        vec![json!(""), json!("k".repeat(100)), json!("k".repeat(101))],
    );
    assert!(call.key(0).is_err());
    assert!(call.key(1).is_ok());
    assert!(call.key(2).is_err());
}

#[test]
fn enums_refuse_what_they_do_not_list() {
    let call = Call::new(
        Sender::Main,
        vec![json!("en"), json!("invalid"), Value::Null],
    );
    assert_eq!(call.one_of(0, &["en", "tr"]).unwrap(), "en");
    assert!(call.one_of(1, &["en", "tr"]).is_err());
    assert_eq!(call.opt_one_of(2, &["en", "tr"]).unwrap(), None);
}
