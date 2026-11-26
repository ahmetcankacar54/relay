//! The Rust port of `shared/external-links.ts`, delegating to `relay_core::shared::external_links`.

#![forbid(unsafe_code)]

use relay_core::shared::external_links;

/// Port of `isExternalLink` (`shared/external-links.ts:30`).
pub fn is_external_link(url: String) -> Result<bool, String> {
    Ok(external_links::is_external_link(&url))
}
