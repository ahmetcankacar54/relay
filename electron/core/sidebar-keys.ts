/**
 * The Local Storage keys of Claude Desktop's Code sidebar organization (sections, the sessions
 * filed in them, pins) that the draft helper reads along with the drafts. Kept apart from
 * `sidebar-layout.ts` so the helper's bundle stays small.
 */
export const SIDEBAR_KEYS = [
  "dframe-store",
  "LSS-persisted.dframe-group-scopes",
  "LSS-persisted.dframe-code-sections",
  "LSS-persisted.starred-local-code-sessions",
] as const;

/**
 * Most characters, keys and values together, of the sidebar keys a helper reports: more is left
 * out, so the result file always stays small enough for the drafts it carries too.
 */
export const MAX_SIDEBAR_CHARS = 4 * 1024 * 1024;
