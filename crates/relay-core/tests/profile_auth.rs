//! Port of tests/profile-auth.test.ts (electron/core/profile-auth and cli-diagnostics).

#[path = "common/usage_terminal.rs"]
mod helpers;

use std::path::PathBuf;

use helpers::write_script;
use relay_core::cli_diagnostics::diagnose_cli;
use relay_core::profile_auth::read_profile_auth;

struct Script {
    _temp: tempfile::TempDir,
    file: PathBuf,
    profile: PathBuf,
    dir: PathBuf,
}

/// A `claude` stand-in running `body`, beside an empty `profile` folder.
fn script(body: &str) -> Script {
    let temp = tempfile::Builder::new()
        .prefix("relay-profile-auth-")
        .tempdir()
        .unwrap();
    let dir = temp.path().to_path_buf();
    let file = dir.join("claude");
    write_script(&file, &format!("#!/bin/sh\n{body}\n"));
    let profile = dir.join("profile");
    std::fs::create_dir(&profile).unwrap();
    Script {
        _temp: temp,
        file,
        profile,
        dir,
    }
}

#[cfg(unix)]
const ACCOUNT: &str = "0b7b2d6e-3c1f-4f8e-9a51-2a8d1c4b5e6f";
#[cfg(unix)]
const ORG: &str = "1c8c3e7f-4d20-4a9f-8b62-3b9e2d5c6f70";

// Needs a POSIX shell: the stand-in is a shell script.
#[cfg(unix)]
#[test]
fn read_profile_auth_reads_auth_status_json_in_the_profile_and_reports_the_account() {
    let s = script(&format!(
        r#"[ "$1 $2 $3" = "auth status --json" ] || exit 9
case "$CLAUDE_CONFIG_DIR" in */profile) ;; *) exit 8;; esac
echo '{{"loggedIn":true,"authMethod":"claude.ai","email":"a@example.test","orgId":"{ORG}","orgName":"Org","subscriptionType":"max","accountUuid":"{ACCOUNT}"}}'"#
    ));
    let now = || "2026-10-19T09:00:00.000Z".to_owned();
    let auth = read_profile_auth(s.file.to_str().unwrap(), &s.profile, None, Some(&now));
    assert!(auth.logged_in);
    assert_eq!(auth.account_uuid.as_deref(), Some(ACCOUNT));
    assert_eq!(auth.org_id.as_deref(), Some(ORG));
    assert_eq!(auth.email.as_deref(), Some("a@example.test"));
    assert_eq!(auth.checked_at, "2026-10-19T09:00:00.000Z");
}

#[test]
fn read_profile_auth_reports_a_failed_status_as_signed_out_with_the_error_text() {
    let s = script("exit 1");
    let auth = read_profile_auth(s.file.to_str().unwrap(), &s.profile, None, None);
    assert!(!auth.logged_in);
    assert_eq!(
        auth.error.as_deref(),
        Some("The usage sign-in could not be verified. Renew the usage sign-in.")
    );
}

// Needs a POSIX shell: the stand-in is a shell script.
#[cfg(unix)]
#[test]
fn diagnose_cli_reports_the_version_and_whether_it_supports_desktop() {
    let s = script(r#"echo "2.1.300 (Claude Code)""#);
    let file = s.file.to_str().unwrap();
    let d = diagnose_cli(Some(file), &s.dir);
    assert_eq!(d.executable.as_deref(), Some(file));
    assert_eq!(d.version.as_deref(), Some("2.1.300 (Claude Code)"));
    assert_eq!(d.data_dir, s.dir.to_str().unwrap());
    assert_eq!(d.error, None);
}

#[test]
fn diagnose_cli_says_when_no_cli_is_found() {
    let s = script("exit 0");
    let missing = s.dir.join("missing");
    let d = diagnose_cli(Some(missing.to_str().unwrap()), &s.dir);
    assert!(d.error.unwrap().contains("Claude Code was not found"));
}
