//! Port of `tests/cli-doctor.test.ts`. macOS only, as the TS skips elsewhere.
#![cfg(target_os = "macos")]

mod common;

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;

use common::{Options, cli_fixture};
use serde_json::Value;

/// `relay doctor --json`'s checks by name.
fn checks(out: &str) -> HashMap<String, Value> {
    let rows: Vec<Value> = serde_json::from_str(out).unwrap();
    rows.into_iter()
        .map(|c| (c["check"].as_str().unwrap().to_owned(), c))
        .collect()
}

#[test]
fn doctor_reports_each_check_with_an_old_claude_code_cli_as_a_warning() {
    let mut f = cli_fixture(Options::default());
    f.saved("A", None);
    let claude = f.temp().join("fake-claude");
    std::fs::write(&claude, "#!/bin/sh\necho \"2.1.200 (Claude Code)\"\n").unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let claude = claude.to_string_lossy().into_owned();
    f.deps.claude = Arc::new(move |_| Some(claude.clone()));
    assert_eq!(f.run(&["doctor", "--json"]), 0);
    let checks = checks(&f.out());
    assert_eq!(checks["vault"]["status"], "ok");
    assert_eq!(checks["key"]["status"], "ok");
    assert_eq!(checks["claude-cli"]["status"], "warn");
    assert!(
        checks["claude-cli"]["detail"]
            .as_str()
            .unwrap()
            .contains("2.1.296")
    );
    assert_eq!(checks["platform"]["status"], "ok");
    assert!(checks.contains_key("automation"));
    f.clear();
    assert_eq!(f.run(&["doctor"]), 0);
    assert!(f.out().contains("Automation"));
}

#[test]
fn a_locked_key_fails_the_check_and_exits_5() {
    let f = cli_fixture(Options::default());
    f.saved("A", None);
    f.security.force_exit(51);
    assert_eq!(f.run(&["doctor", "--json"]), 5);
    assert_eq!(checks(&f.out())["key"]["status"], "fail");
}
