//! Port of `electron/core/profile-auth.ts`: who is signed in to an account's isolated profile.

use std::path::Path;

use serde_json::Value;

use crate::clock::now_ms;
use crate::environment::{command, process_env, profile_environment};
use crate::fs_util::iso_timestamp;
use crate::profile_identity::{auth_status, read_profile_identity};
use crate::shared::types::AccountAuth;

/// What an account's auth becomes when its status cannot be read.
pub fn signed_out(previous: Option<&AccountAuth>, checked_at: &str) -> AccountAuth {
    AccountAuth {
        logged_in: false,
        checked_at: checked_at.to_owned(),
        error: Some("The usage sign-in could not be verified. Renew the usage sign-in.".into()),
        ..previous.cloned().unwrap_or_default()
    }
}

/// Asks the official CLI, in the account's isolated profile, who is signed in there
/// (`claude auth status --json`), corroborated by the profile's own identity metadata. A status
/// that cannot be read means signed out, with the error the app shows.
pub fn read_profile_auth(
    executable: &str,
    profile: &Path,
    previous: Option<&AccountAuth>,
    now: Option<&dyn Fn() -> String>,
) -> AccountAuth {
    let now = || now.map_or_else(|| iso_timestamp(now_ms()), |n| n());
    let env = profile_environment(&profile.to_string_lossy(), &process_env());
    let stdout = match command(executable, &["auth", "status", "--json"], &env, profile) {
        Ok(output) => Some(output.stdout),
        // A non-zero exit that still printed the status is read.
        Err(error) if !error.stdout.trim().is_empty() => Some(error.stdout),
        Err(_) => None,
    };
    stdout
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            auth_status(
                &value,
                previous,
                read_profile_identity(profile).as_ref(),
                &now(),
            )
            .ok()
        })
        .unwrap_or_else(|| signed_out(previous, &now()))
}
