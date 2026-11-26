//! The Rust port of `shared/cli-version.ts`, delegating to `relay_core::shared::cli_version`.

#![forbid(unsafe_code)]

use relay_core::shared::cli_version;

/// Port of `meetsCliMinimum` (`shared/cli-version.ts:28`).
pub fn meets_cli_minimum(version: String) -> Result<bool, String> {
    Ok(cli_version::meets_cli_minimum(&version))
}

/// Port of `readsUsage` (`shared/cli-version.ts:32`).
pub fn reads_usage(version: String) -> Result<bool, String> {
    Ok(cli_version::reads_usage(&version))
}
