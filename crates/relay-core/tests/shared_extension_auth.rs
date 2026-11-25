//! Port of tests/extension-auth.test.ts.

#[path = "common/shared_b.rs"]
mod helpers;

use helpers::{json, owned, pairs, sign_in_for, some_pairs, uuid};
use relay_core::shared::browser_extension::{
    BrowserApp, ExtensionInstance, ExtensionTarget, LocalStateProfile, choose_instance, local_state_profiles, startup_restores,
};
use relay_core::shared::extension_auth::{SignIn, holds_token, is_sign_in_entry, named_account, pick_sign_in, same_sign_in, session_expired};
use serde_json::json as j;

fn sorted_keys(sign_in: &SignIn) -> Vec<String> {
    let mut keys: Vec<String> = sign_in.keys().cloned().collect();
    keys.sort();
    keys
}

fn to_sign_in(entries: &[(String, String)]) -> SignIn {
    entries.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[test]
fn the_sign_in_is_its_own_entries_found_by_name_or_by_a_token_with_the_account_it_names() {
    let id = uuid();
    let mut entries = sign_in_for(&id, 1);
    entries.extend(owned(&[("savedPrompts", r#"["a prompt"]"#), ("conversationCache", "{}")]));
    let picked = pick_sign_in(some_pairs(&entries), &[id.clone(), uuid()]).unwrap();
    assert_eq!(sorted_keys(&picked.sign_in), ["accessToken", "accountUuid", "refreshToken", "tokenExpiry"]);
    assert_eq!(picked.account.as_deref(), Some(id.as_str()));
}

#[test]
fn key_names_need_not_be_known_a_nested_sign_in_under_any_key_is_found() {
    let id = uuid();
    let state = j!({ "access_token": "sk-ant-oat01-ABCDEFGHIJKL", "refresh_token": "sk-ant-ort01-ABCDEFGHIJKL", "account": { "uuid": id.to_uppercase() } })
        .to_string();
    let entries = owned(&[("persistedState", &state), ("tabGroups", "[]"), ("theme", r#""dark""#)]);
    let picked = pick_sign_in(some_pairs(&entries), std::slice::from_ref(&id)).unwrap();
    assert_eq!(picked.account.as_deref(), Some(id.as_str()));
    assert_eq!(picked.sign_in.keys().cloned().collect::<Vec<_>>(), ["persistedState"]);
    // A bare token value under an odd name counts too.
    assert!(holds_token([("x", r#""sk-ant-oat01-ABCDEFGHIJKLMN""#)]));
}

#[test]
fn signed_out_no_token_anywhere_even_with_an_account_uuid_left_behind() {
    let id = uuid();
    assert_eq!(pick_sign_in([], std::slice::from_ref(&id)), None);
    let left = owned(&[("lastAccountUuid", &json(&id)), ("oauthState", r#""abc""#)]);
    assert_eq!(pick_sign_in(some_pairs(&left), std::slice::from_ref(&id)), None);
    let empty = owned(&[("accessToken", "null"), ("refreshToken", r#""""#)]);
    assert_eq!(pick_sign_in(some_pairs(&empty), std::slice::from_ref(&id)), None);
}

#[test]
fn an_account_relay_does_not_have_or_two_it_cannot_tell_apart_names_no_account() {
    let a = uuid();
    let b = uuid();
    let known = [a.clone(), b.clone()];
    let strange = sign_in_for(&uuid(), 1);
    let stranger = pick_sign_in(some_pairs(&strange), &known).unwrap();
    assert_eq!(stranger.account, None);
    // Both named, one in an account key: that one.
    let recent = j!([a, b]).to_string();
    let named = owned(&[("accountUuid", &json(&a)), ("recent", &recent)]);
    assert_eq!(named_account(pairs(&named), &known), Some(a.clone()));
    // Both named, neither in an account key: none.
    let neither = owned(&[("recent", &recent)]);
    assert_eq!(named_account(pairs(&neither), &known), None);
}

#[test]
fn extension_1_0_102_s_layout_account_uuid_names_the_account_a_consent_map_of_several_names_no_one() {
    let mine = uuid();
    let other = uuid();
    let stranger = uuid();
    let org = uuid();
    let consent = {
        let mut map = serde_json::Map::new();
        for id in [&stranger, &mine, &other] {
            map.insert(id.clone(), j!({ "browserControlPermissionAccepted": true }));
        }
        serde_json::Value::Object(map).to_string()
    };
    let layout = |account: &str| -> Vec<(String, String)> {
        owned(&[
            ("accountUuid", &json(account)),
            ("anonymousId", &json(&uuid())),
            ("bridgeDeviceId", &json(&uuid())),
            ("codeVerifier", r#""abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ""#),
            ("lastActiveOrgHint", &json(&org)),
            ("oauthState", r#""abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ""#),
            ("permissionConsentByAccount", &consent),
            ("permissionConsentOwner", &json(account)),
            ("tokenOrg", &j!({ "hybrid": false, "uuid": org }).to_string()),
        ])
    };
    let known = [mine.clone(), other.clone()];
    let entries = layout(&mine);
    let picked = pick_sign_in(some_pairs(&entries), &known).unwrap();
    assert_eq!(picked.account.as_deref(), Some(mine.as_str()));
    assert!(!picked.other);
    assert_eq!(picked.sign_in.get("accountUuid"), Some(&json(&mine)));
    // Signed in to an account Relay does not have: someone else's, never guessed from the map.
    let entries = layout(&stranger);
    let theirs = pick_sign_in(some_pairs(&entries), &known).unwrap();
    assert_eq!(theirs.account, None);
    assert!(theirs.other);
    // Signed out: the extension deletes accountUuid, tokenOrg and the rest; the map stays.
    let signed_out: Vec<(String, String)> = layout(&mine)
        .into_iter()
        .filter(|(key, _)| ["anonymousId", "bridgeDeviceId", "permissionConsentByAccount"].contains(&key.as_str()))
        .collect();
    assert_eq!(pick_sign_in(some_pairs(&signed_out), &known), None);
}

#[test]
fn two_sign_ins_are_the_same_only_when_every_key_is() {
    let id = uuid();
    assert!(same_sign_in(&to_sign_in(&sign_in_for(&id, 1)), &to_sign_in(&sign_in_for(&id, 1))));
    assert!(!same_sign_in(&to_sign_in(&sign_in_for(&id, 1)), &to_sign_in(&sign_in_for(&id, 2))));
    let fewer: Vec<(String, String)> = sign_in_for(&id, 1).into_iter().filter(|(k, _)| k != "tokenExpiry").collect();
    assert!(!same_sign_in(&to_sign_in(&sign_in_for(&id, 1)), &to_sign_in(&fewer)));
}

#[test]
fn profiles_come_from_local_state_guest_and_system_profiles_are_dropped() {
    let state = j!({
        "profile": {
            "profiles_order": ["Profile 1", "Default"],
            "info_cache": {
                "Default": { "name": "Kişisel" },
                "Profile 1": { "name": "  Studio " },
                "Guest Profile": { "name": "Guest", "is_guest": true },
                "System Profile": { "name": "System" },
                "Profile 2": { "name": "Temp", "is_ephemeral": true },
                "../evil": { "name": "x" },
            },
        },
    });
    let profile = |p: &str, n: &str| LocalStateProfile { profile: p.into(), name: n.into() };
    assert_eq!(local_state_profiles(&state), [profile("Profile 1", "Studio"), profile("Default", "Kişisel")]);
    assert_eq!(local_state_profiles(&serde_json::Value::Null), []);
    assert_eq!(local_state_profiles(&j!({ "profile": {} })), []);
}

#[test]
fn the_startup_setting_restores_tabs_only_for_last_session_1_or_5() {
    assert!(startup_restores(&j!({ "session": { "restore_on_startup": 1 } })));
    assert!(startup_restores(&j!({ "session": { "restore_on_startup": 5 } })));
    assert!(!startup_restores(&j!({ "session": { "restore_on_startup": 4 } })));
    assert!(!startup_restores(&j!({ "session": {} })));
    assert!(!startup_restores(&serde_json::Value::Null));
}

#[test]
fn the_chosen_instance_wins_the_only_one_is_used_several_without_a_choice_are_none() {
    let instance = |app, name: &str| ExtensionInstance { app, profile: "Default".into(), name: name.into(), opened: true, used_at: None };
    let brave = instance(BrowserApp::Brave, "A");
    let chrome = instance(BrowserApp::Chrome, "B");
    let target = |app| ExtensionTarget { app, profile: "Default".into() };
    assert_eq!(choose_instance(std::slice::from_ref(&brave), None), Some(&brave));
    let both = [brave.clone(), chrome.clone()];
    assert_eq!(choose_instance(&both, None), None);
    assert_eq!(choose_instance(&both, Some(&target(BrowserApp::Chrome))), Some(&chrome));
    // A chosen instance that is gone does not pick another of several.
    assert_eq!(choose_instance(&both, Some(&target(BrowserApp::Edge))), None);
    assert_eq!(choose_instance(&[], None), None);
}

#[test]
fn extension_1_0_105_the_org_hint_and_the_pkce_pair_go_with_the_sign_in_a_failed_sign_in_s_record_never() {
    let id = uuid();
    let org = uuid();
    let entries = owned(&[
        ("accountUuid", &json(&id)),
        ("tokenOrg", &j!({ "hybrid": false, "uuid": org }).to_string()),
        ("lastActiveOrgHint", &json(&uuid())),
        ("codeVerifier", &json(&"v".repeat(43))),
        ("signInState", &json(&"s".repeat(43))),
        ("oauthState", &json(&"o".repeat(43))),
        ("lastAuthFailureReason", &json("session_expired")),
        ("startupReauthState", &j!({ "terminal": true, "stop": "definitive" }).to_string()),
        ("pairingOrgMismatch", &j!({ "org": uuid() }).to_string()),
        ("selectedModel", &json("claude-sonnet-4-5")),
    ]);
    let picked = pick_sign_in(some_pairs(&entries), std::slice::from_ref(&id)).unwrap();
    assert_eq!(picked.account.as_deref(), Some(id.as_str()));
    assert_eq!(
        sorted_keys(&picked.sign_in),
        ["accountUuid", "codeVerifier", "lastActiveOrgHint", "oauthState", "signInState", "tokenOrg"]
    );
    // Still part of a sign-in, so a write that lacks them removes them from the profile.
    assert!(is_sign_in_entry("lastAuthFailureReason", r#""session_expired""#));
    assert!(is_sign_in_entry("startupReauthState", "{}"));
    assert!(is_sign_in_entry("pairingOrgMismatch", "{}"));
    assert!(!is_sign_in_entry("selectedModel", r#""claude-sonnet-4-5""#));
    assert!(session_expired(some_pairs(&entries)));
    let without: Vec<(String, String)> = entries.iter().filter(|(k, _)| k != "lastAuthFailureReason").cloned().collect();
    assert!(!session_expired(some_pairs(&without)));
    assert!(!session_expired([("lastAuthFailureReason", Some(r#""network_error""#))]));
}
