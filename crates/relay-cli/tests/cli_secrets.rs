//! Port of `tests/cli-secrets.test.ts`: no command output carries a secret. macOS only, as the TS
//! skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::fs;
use std::sync::Arc;

use common::{Fixture, Options, cli_fixture};
use relay_core::desktop_files::write_bytes;
use relay_core::fs_util::iso_timestamp;
use relay_core::shared::types::{AccountAuth, UsageIssue};
use relay_core::usage::UsageEndpoint;
use relay_core::usage_credentials::{UsageError, credential_service};
use serde_json::json;

const TOKEN: &str = "sk-ant-oat01-SCANTOKENSCANTOKENSCANTOKENSCANTOKEN0000";

fn run(f: &Fixture, transcript: &mut Vec<String>, argv: &[&str]) {
    f.clear();
    f.run(argv);
    transcript.push(format!(
        "$ relay {}\n{}\n{}",
        argv.join(" "),
        f.out(),
        f.err()
    ));
}

#[test]
fn no_command_prints_a_token_a_cookie_or_a_fixture_secret_on_success_or_failure() {
    let mut f = cli_fixture(Options::default());
    let (a, _) = f.saved("A", None);
    f.saved("B", None);
    let mut transcript = Vec::new();
    for argv in [
        &["list"][..],
        &["list", "--json"],
        &["status"],
        &["status", "--json"],
        &["history"],
        &["history", "--json"],
        &["tokens"],
        &["doctor"],
        &["doctor", "--json"],
        &["usage"],
        &["usage", "--json"],
    ] {
        run(&f, &mut transcript, argv);
    }
    run(&f, &mut transcript, &["switch", "A", "--yes"]);
    run(&f, &mut transcript, &["switch", "B", "--yes"]);
    f.state.lock().unwrap().fail_quit = Some(format!("osascript failed {TOKEN}"));
    run(&f, &mut transcript, &["switch", "A", "--yes"]);
    f.state.lock().unwrap().fail_quit = None;
    // Connected limits read the CLI's credential.
    f.store()
        .update(|s| {
            for account in &mut s.accounts {
                let desktop = account.desktop.clone().unwrap();
                account.auth = Some(AccountAuth {
                    logged_in: true,
                    account_uuid: Some(desktop.account_uuid),
                    org_id: Some(desktop.org_id),
                    email: Some(format!("{}@example.test", account.name)),
                    checked_at: iso_timestamp(relay_core::clock::now_ms()),
                    ..AccountAuth::default()
                });
            }
        })
        .unwrap();
    let credential = json!({ "claudeAiOauth": {
        "accessToken": TOKEN,
        "expiresAt": relay_core::clock::now_ms() + 3_600_000,
        "scopes": ["user:profile"],
    } });
    f.security.set_item(
        &credential_service(&f.home.join("profiles").join(&a.id)),
        &credential.to_string(),
    );
    f.deps.request = Arc::new(|endpoint, _| {
        if endpoint == UsageEndpoint::Profile {
            return Err(UsageError::with_detail(
                UsageIssue::Unavailable,
                format!("HTTP 500 for {TOKEN}"),
            ));
        }
        Ok(json!({}))
    });
    run(&f, &mut transcript, &["usage"]);
    run(&f, &mut transcript, &["usage", "--json"]);
    // A malformed Claude config would put its first bytes into a JSON parse error.
    write_bytes(
        &f.claude,
        "config.json",
        Some(b"FIXTURE-SECRET-broken-config {"),
    )
    .unwrap();
    run(&f, &mut transcript, &["switch", "A", "--yes"]);
    run(&f, &mut transcript, &["status"]);
    run(&f, &mut transcript, &["remove", "A", "--yes"]);
    run(&f, &mut transcript, &["add", "C", "--yes"]);
    let all = transcript.join("\n");
    // A parse error may quote only the first bytes of a bad JSON file, so look for any part of the marker.
    assert!(!all.contains("FIXTURE"), "{all}");
    assert!(!all.contains(TOKEN), "{all}");
    assert!(!all.contains("sk-ant-"), "{all}");
    let operations = f.home.join("cli-operations");
    if operations.exists() {
        for entry in fs::read_dir(&operations).unwrap() {
            assert!(
                !fs::read_to_string(entry.unwrap().path())
                    .unwrap()
                    .contains("FIXTURE-SECRET")
            );
        }
    }
}
