//! Port of `cli/src/guards.ts`.

use std::path::Path;

use crate::deps::CliDeps;
use crate::i18n::T;
use crate::io::{CliError, exit};

/// `Number.parseInt(part, 10) || 0`.
fn parse_int(part: &str) -> i64 {
    let s = relay_core::store::schema::js_trim(part);
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let run: String = digits.chars().take_while(char::is_ascii_digit).collect();
    run.parse::<i64>().map(|n| sign * n).unwrap_or(0)
}

/// Whether dotted version `version` is below `floor`.
pub fn older_than(version: &str, floor: &str) -> bool {
    let a: Vec<i64> = version.split(['.', '+', '-']).map(parse_int).collect();
    let b: Vec<i64> = floor.split('.').map(parse_int).collect();
    for i in 0..3 {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

pub fn update_app_message(t: T) -> String {
    t.t("guards.updateRelayAppTo012")
}

/// The installed Relay.app writes an older account list than this relay: not the "older than 0.12" case.
pub fn app_older_message(t: T) -> String {
    t.t("guards.relayAppWritesAnOlderAccount")
}

/// Refuses to quit or open Claude without a macOS desktop session (over SSH, for example).
pub fn gui_session_guard(deps: &CliDeps, t: T) -> Result<(), CliError> {
    if !(deps.gui_session)() {
        return Err(CliError::new(
            t.t("guards.thisSessionHasNoMacosDesktop"),
            exit::ENVIRONMENT,
        ));
    }
    Ok(())
}

/// Whether this process may create and remove a file in `dir`; a sandbox may forbid it.
pub fn probe_writable(dir: &Path) -> bool {
    if relay_core::fs_util::create_private_dir_all(dir).is_err() {
        return false;
    }
    let file = dir.join(format!(".probe-{}", uuid::Uuid::new_v4()));
    match relay_core::fs_util::create_new_private(&file) {
        Ok(handle) => {
            drop(handle);
            std::fs::remove_file(&file).is_ok()
        }
        Err(_) => false,
    }
}
