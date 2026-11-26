//! Port of `electron/core/sidebar-keys.ts`: the Local Storage keys of Claude Desktop's Code
//! sidebar organization (sections, the sessions filed in them, pins) that the draft reader reads
//! along with the drafts.

pub const SIDEBAR_KEYS: [&str; 4] = [
    "dframe-store",
    "LSS-persisted.dframe-group-scopes",
    "LSS-persisted.dframe-code-sections",
    "LSS-persisted.starred-local-code-sessions",
];

/// Most characters (UTF-16 code units), keys and values together, of the sidebar keys a read
/// reports: more is left out, so the drafts it carries too always stay within their limits.
pub const MAX_SIDEBAR_CHARS: usize = 4 * 1024 * 1024;
