//! The Rust port of `shared/tr-dative.ts`, delegating to `relay_core::shared::tr_dative`.

#![forbid(unsafe_code)]

use relay_core::shared::tr_dative;

/// Port of `withDative` (`shared/tr-dative.ts:60`).
pub fn with_dative(name: String) -> Result<String, String> {
    Ok(tr_dative::with_dative(&name))
}

/// Port of `clockLocative` (`shared/tr-dative.ts:103`).
pub fn clock_locative(clock: String) -> Result<String, String> {
    Ok(tr_dative::clock_locative(&clock))
}
