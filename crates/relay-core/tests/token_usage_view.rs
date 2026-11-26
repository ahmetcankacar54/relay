//! Backend side of `tests/token-usage-view.test.ts`: the view's cases themselves live in
//! `shared_token_usage_view.rs`, and the three `mainSource`/`mainModule` cases read Electron's
//! source text, so they are not ported. What is left for the backend is that a real ledger's
//! snapshot is what the view reads.

use std::fs;

use relay_core::shared::token_usage_view::{TokenUsageInput, build_token_usage_view};
use relay_core::shared::types::Account;
use relay_core::shared::types::js::date_parse;
use relay_core::token_attribution::{Attribution, AttributionRow};
use relay_core::token_ledger::{LedgerSnapshot, TokenLedger, TokenLedgerOptions, TokenRoot};
use serde_json::json;

const ZONE: &str = "Europe/Istanbul";

fn now() -> f64 {
    date_parse("2026-10-14T12:00:00.000Z")
}

#[test]
fn a_ledger_snapshot_is_what_the_view_reads() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("projects");
    let file = root.join("p").join("s.jsonl");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    let row = json!({
        "type": "assistant",
        "timestamp": "2026-10-14T09:00:00.000Z",
        "requestId": "req_1",
        "message": {
            "id": "msg_1",
            "model": "claude-opus-4-1",
            "usage": { "input_tokens": 10, "output_tokens": 20 },
        },
    });
    fs::write(&file, serde_json::to_string(&row).unwrap() + "\n").unwrap();
    let mut ledger = TokenLedger::new(TokenLedgerOptions {
        file: dir.path().join("token-ledger.json"),
        roots: vec![TokenRoot {
            dir: root,
            profile_account_id: None,
        }],
        attribute: Box::new(|_: &AttributionRow<'_>| Attribution::Account {
            account_id: "ann".into(),
            estimated: false,
        }),
        zone: Box::new(|| ZONE.to_string()),
        now: Some(Box::new(now)),
        budget_ms: None,
        max_age_days: None,
        max_bytes: None,
    });
    assert!(ledger.tick().unwrap().complete);
    let snapshot = ledger.snapshot();
    // The snapshot round-trips through the shape the renderer receives.
    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(
        serde_json::from_value::<LedgerSnapshot>(wire).unwrap(),
        snapshot
    );
    let accounts = [Account::new("ann", "Ann")];
    let view = build_token_usage_view(&TokenUsageInput {
        ledger: &snapshot,
        accounts: &accounts,
        range: 7,
        account_id: None,
        zone: ZONE,
        now: now(),
        exact_since: None,
    });
    let view = serde_json::to_value(&view).unwrap();
    assert_eq!(
        view["progress"],
        json!({ "percent": 100, "complete": true })
    );
    assert_eq!(view["totals"]["input"], json!(10));
    assert_eq!(view["totals"]["output"], json!(20));
    assert_eq!(view["totals"]["responses"], json!(1));
    assert_eq!(view["rows"][0]["key"], json!("ann"));
}
