//! Port of tests/desktop-org.test.ts.

use relay_core::desktop_org::{OrgHint, active_org_hint};
use relay_core::shared::types::js::date_parse;
use serde_json::{Value, json};

const ACCOUNT: &str = "00000000-0000-4000-8000-0000000000a1";
const OTHER: &str = "00000000-0000-4000-8000-0000000000b2";
const OLD: &str = "00000000-0000-4000-8000-0000000000c3";
const NOW: &str = "00000000-0000-4000-8000-0000000000d4";
const THIRD: &str = "00000000-0000-4000-8000-0000000000e5";

fn orgs(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn hint(org: &str, certain: bool) -> Option<OrgHint> {
    Some(OrgHint {
        org_id: org.into(),
        certain,
    })
}

#[test]
fn a_single_workspace_or_a_config_that_says_nothing_gives_no_hint() {
    assert_eq!(
        active_org_hint(
            &json!({ "a": { "accountUuid": ACCOUNT, "orgUuid": NOW } }),
            ACCOUNT,
            &orgs(&[NOW]),
            None
        ),
        None
    );
    assert_eq!(
        active_org_hint(
            &json!({ "locale": "en-US" }),
            ACCOUNT,
            &orgs(&[OLD, NOW]),
            None
        ),
        None
    );
    for config in [Value::Null, json!("x"), json!([]), json!(7)] {
        assert_eq!(
            active_org_hint(&config, ACCOUNT, &orgs(&[OLD, NOW]), None),
            None
        );
    }
}

#[test]
fn an_answer_the_claude_app_remembered_for_the_account_names_its_workspace_outright() {
    let mut config = json!({
        format!("dxt:allowlistLastUpdated:{OLD}"): "2026-11-10T10:00:00.000Z",
        format!("dxt:allowlistLastUpdated:{NOW}"): "2026-08-11T10:00:00.000Z",
        "sshTransportFlagLastAnswer": { "accountUuid": ACCOUNT.to_uppercase(), "orgUuid": NOW, "on": true },
    });
    assert_eq!(
        active_org_hint(&config, ACCOUNT, &orgs(&[OLD, NOW]), None),
        hint(NOW, true)
    );
    assert_eq!(
        active_org_hint(&config, OTHER, &orgs(&[OLD, NOW]), None),
        hint(OLD, false)
    );
    config["sshTransportFlagLastAnswer"] = json!({ "accountUuid": ACCOUNT, "orgUuid": THIRD });
    assert_eq!(
        active_org_hint(&config, ACCOUNT, &orgs(&[OLD, NOW]), None),
        hint(OLD, false)
    );
}

#[test]
fn without_one_the_workspace_the_app_refreshed_last_is_the_hint_certain_only_for_this_sign_in() {
    let config = json!({
        format!("dxt:allowlistLastUpdated:{OLD}"): "2026-08-11T10:06:35.679Z",
        format!("dxt:allowlistLastUpdated:{NOW}"): "2026-11-10T10:35:48.365Z",
        format!("dxt:allowlistLastUpdated:{THIRD}"): "2026-11-10T11:00:00.000Z",
        format!("dxt:allowlistEnabled:{NOW}"): false,
        "dxt:allowlistLastUpdated:not-a-workspace": "2026-11-10T12:00:00.000Z",
    });
    assert_eq!(
        active_org_hint(&config, ACCOUNT, &orgs(&[OLD, NOW]), None),
        hint(NOW, false)
    );
    let began = date_parse("2026-11-10T10:35:15.000Z");
    assert_eq!(
        active_org_hint(&config, ACCOUNT, &orgs(&[OLD, NOW]), Some(began)),
        hint(NOW, true)
    );
    assert_eq!(
        active_org_hint(
            &config,
            ACCOUNT,
            &orgs(&[OLD, NOW]),
            Some(date_parse("2026-11-10T10:40:00.000Z"))
        ),
        hint(NOW, false)
    );
    assert_eq!(
        active_org_hint(
            &json!({ format!("dxt:allowlistLastUpdated:{NOW}"): "soon" }),
            ACCOUNT,
            &orgs(&[OLD, NOW]),
            None
        ),
        None
    );
}
