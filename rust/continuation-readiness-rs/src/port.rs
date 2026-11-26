//! The Rust port of `shared/continuation-readiness.ts`, delegating to
//! `relay_core::shared::continuation_readiness`.

#![forbid(unsafe_code)]

mod pinned;

use parity_args::{arg, opt_arg};
use relay_core::shared::continuation_readiness;
use relay_core::shared::types::{Account, AccountUsage, RelaySettings};

/// Port of `continuationTargetReadinessReason` (`shared/continuation-readiness.ts:56`); a
/// missing `now` is the (pinned) clock, as `Date.now()` is.
pub fn continuation_target_readiness_reason(
    source: Option<serde_json::Value>,
    target: serde_json::Value,
    usage: Option<serde_json::Value>,
    settings: serde_json::Value,
    now: Option<serde_json::Value>,
) -> Result<Option<String>, String> {
    let source: Option<Account> = opt_arg(source.as_ref())?;
    let target: Account = arg(&target)?;
    let usage: Option<AccountUsage> = opt_arg(usage.as_ref())?;
    let settings: RelaySettings = arg(&settings)?;
    let now = match now.as_ref().and_then(crate::js::as_number) {
        Some(now) => now,
        None => pinned::now_ms(),
    };
    Ok(
        continuation_readiness::continuation_target_readiness_reason(
            source.as_ref(),
            &target,
            usage.as_ref(),
            &settings,
            now,
        )
        .map(|r| r.as_str().to_string()),
    )
}
