//! Port of the `planHistory`/`planHistoryDetailed` cases of `tests/desktop-drafts.test.ts`: which
//! conversations a history merge carries, and under which alias, for the draft step.

use std::path::Path;

use relay_core::desktop_files::{
    CarriedMember, HistoryPlanOptions, Scope, json_bytes, plan_history, plan_history_detailed,
    write_bytes,
};
use serde_json::{Value, json};

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A fake Claude root with two accounts and nothing else: the planner only reads
/// `claude-code-sessions/<acct>/<org>/` records and the optional projects files.
struct Fx {
    root: tempfile::TempDir,
    a: Scope,
    b: Scope,
}

fn scope() -> Scope {
    Scope {
        account_uuid: uuid(),
        org_id: uuid(),
    }
}

fn fixture() -> Fx {
    Fx {
        root: tempfile::Builder::new()
            .prefix("relay-drafts-plan-")
            .tempdir()
            .unwrap(),
        a: scope(),
        b: scope(),
    }
}

fn dir(s: &Scope) -> String {
    format!("claude-code-sessions/{}/{}", s.account_uuid, s.org_id)
}

impl Fx {
    fn root(&self) -> &Path {
        self.root.path()
    }

    fn record(&self, s: &Scope, alias: &str, extra: Value) {
        let mut record = json!({
            "sessionId": format!("local_{alias}"),
            "cliSessionId": alias,
            "cwd": self.root().to_string_lossy(),
            "title": "Fixture",
            "lastActivityAt": 42,
        });
        for (key, value) in extra.as_object().unwrap() {
            record[key] = value.clone();
        }
        write_bytes(
            self.root(),
            &format!("{}/local_{alias}.json", dir(s)),
            Some(&json_bytes(&record)),
        )
        .unwrap();
    }

    fn detailed(&self) -> relay_core::desktop_files::HistoryPlan {
        plan_history_detailed(
            self.root(),
            &self.b,
            std::slice::from_ref(&self.a),
            &HistoryPlanOptions::default(),
        )
        .unwrap()
    }
}

fn member(alias: &str, s: &Scope) -> CarriedMember {
    CarriedMember {
        alias: alias.to_string(),
        account_uuid: s.account_uuid.clone(),
    }
}

fn by_alias(members: &[CarriedMember]) -> Vec<CarriedMember> {
    let mut sorted = members.to_vec();
    sorted.sort_by(|x, y| x.alias.cmp(&y.alias));
    sorted
}

#[test]
fn a_conversation_newest_in_the_source_keeps_its_alias_in_the_target() {
    let f = fixture();
    let (x, y) = (uuid(), uuid());
    f.record(
        &f.a,
        &x,
        json!({ "cliSessionId": x, "lastActivityAt": 200 }),
    );
    f.record(
        &f.b,
        &y,
        json!({ "cliSessionId": x, "lastActivityAt": 100 }),
    );
    let plan = f.detailed();
    assert_eq!(plan.conversations.len(), 1);
    assert_eq!(plan.conversations[0].target_alias, x);
    assert_eq!(
        by_alias(&plan.conversations[0].members),
        by_alias(&[member(&x, &f.a), member(&y, &f.b)])
    );
    // The reported alias is the card the target really ends up with.
    assert!(matches!(
        plan.writes.get(&format!("{}/local_{x}.json", dir(&f.b))),
        Some(Some(_))
    ));
    assert_eq!(
        plan.writes.get(&format!("{}/local_{y}.json", dir(&f.b))),
        Some(&None)
    );
}

#[test]
fn a_conversation_newest_in_the_target_keeps_the_target_alias() {
    let f = fixture();
    let (x, y) = (uuid(), uuid());
    f.record(
        &f.a,
        &x,
        json!({ "cliSessionId": x, "lastActivityAt": 100 }),
    );
    f.record(
        &f.b,
        &y,
        json!({ "cliSessionId": x, "lastActivityAt": 200 }),
    );
    let plan = f.detailed();
    assert_eq!(plan.conversations.len(), 1);
    assert_eq!(plan.conversations[0].target_alias, y);
    assert_eq!(
        by_alias(&plan.conversations[0].members),
        by_alias(&[member(&x, &f.a), member(&y, &f.b)])
    );
    assert!(plan.writes.is_empty());
}

#[test]
fn a_duplicate_target_card_the_merge_deletes_is_still_a_member() {
    let f = fixture();
    let (cli, older) = (uuid(), uuid());
    f.record(
        &f.b,
        &cli,
        json!({ "cliSessionId": cli, "lastActivityAt": 300 }),
    );
    f.record(
        &f.b,
        &older,
        json!({ "cliSessionId": cli, "lastActivityAt": 100 }),
    );
    let plan = f.detailed();
    assert_eq!(plan.conversations.len(), 1);
    assert_eq!(plan.conversations[0].target_alias, cli);
    assert_eq!(
        by_alias(&plan.conversations[0].members),
        by_alias(&[member(&cli, &f.b), member(&older, &f.b)])
    );
    assert_eq!(
        plan.writes
            .get(&format!("{}/local_{older}.json", dir(&f.b))),
        Some(&None)
    );
    assert!(
        !plan
            .writes
            .contains_key(&format!("{}/local_{cli}.json", dir(&f.b)))
    );
}

#[test]
fn a_tombstoned_conversation_is_not_listed() {
    let f = fixture();
    let x = uuid();
    f.record(
        &f.a,
        &x,
        json!({ "cliSessionId": x, "lastActivityAt": 200 }),
    );
    write_bytes(f.root(), &format!("{}/deleted_{x}", dir(&f.b)), Some(b"")).unwrap();
    let plan = f.detailed();
    assert!(plan.conversations.is_empty());
    assert!(plan.writes.is_empty());
}

#[test]
fn plan_history_still_returns_the_same_writes() {
    let f = fixture();
    let (x, y, solo, stale) = (uuid(), uuid(), uuid(), uuid());
    f.record(
        &f.a,
        &x,
        json!({ "cliSessionId": x, "lastActivityAt": 200 }),
    );
    f.record(
        &f.b,
        &y,
        json!({ "cliSessionId": x, "lastActivityAt": 100 }),
    );
    f.record(&f.a, &solo, json!({ "lastActivityAt": 50 }));
    f.record(
        &f.b,
        &stale,
        json!({ "cliSessionId": y, "lastActivityAt": 10 }),
    );
    let plain = plan_history(
        f.root(),
        &f.b,
        std::slice::from_ref(&f.a),
        &HistoryPlanOptions::default(),
    )
    .unwrap();
    assert!(!plain.is_empty());
    assert_eq!(plain, f.detailed().writes);
}
