//! The Rust port of `shared/proxy-types.ts`, delegating to `relay_core::shared::proxy_types`.
//!
//! `DEFAULT_PROXY_CONFIG` and the other constants are not functions: they are not bridged.

#![forbid(unsafe_code)]

use relay_core::shared::proxy_types;

/// Port of `currentAffinityTtl` (`shared/proxy-types.ts:228`).
pub fn current_affinity_ttl(
    saved: Option<f64>,
    revision: Option<f64>,
) -> Result<Option<f64>, String> {
    Ok(proxy_types::current_affinity_ttl(saved, revision))
}
