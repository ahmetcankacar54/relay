//! Port of the Usage side of `tests/cli-secrets.test.ts`: a sign-in read from the Keychain under
//! the account's `credential_service`, whose identity proof fails, never puts the token into
//! the usage the CLI prints or the issue it logs. The command transcripts are the CLI slice's.
//! macOS only, as the TS case skips other systems.
#![cfg(target_os = "macos")]

#[path = "common/usage_cli.rs"]
mod helpers;
#[path = "common/vault.rs"]
mod vault;

use std::sync::Arc;

use helpers::{Connected, now_ms};
use relay_core::shared::types::{UsageIssue, UsageStatus};
use relay_core::usage::{UsageEndpoint, UsageRequest, network_detail};
use relay_core::usage_credentials::UsageError;
use serde_json::json;

const TOKEN: &str = "sk-ant-oat01-SCANTOKENSCANTOKENSCANTOKENSCANTOKEN0000";

#[test]
fn no_command_prints_a_token_a_cookie_or_a_fixture_secret_on_success_or_failure() {
    let c = Connected::new();
    c.save_credential(TOKEN, now_ms() + 3_600_000.0, &["user:profile"], false);
    let request: UsageRequest = Arc::new(|endpoint, token: &str| {
        assert_eq!(
            token, TOKEN,
            "the token read from the Keychain is the one sent"
        );
        match endpoint {
            // The TS request throws `Error("HTTP 500 for <token>")`; the reader keeps its type only.
            UsageEndpoint::Profile => Err(UsageError::with_detail(
                UsageIssue::Unavailable,
                network_detail(Some("Error"), None),
            )),
            UsageEndpoint::Usage => Ok(json!({})),
        }
    });
    let manager = c.manager(request);
    let row = manager.refresh(&c.account.id, false).unwrap();
    assert_ne!(row.status, UsageStatus::Ready);
    let all = format!(
        "{}\n{}\n{}",
        serde_json::to_string(&row).unwrap(),
        serde_json::to_string(&manager.snapshot()).unwrap(),
        c.issues.lock().unwrap().join("\n"),
    );
    assert!(!all.contains("FIXTURE"), "{all}");
    assert!(!all.contains(TOKEN), "{all}");
    assert!(!all.contains("sk-ant-"), "{all}");
}
