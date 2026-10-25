import type { UsageIssue } from "../../shared/types";
import { readPrivateJson, writePrivateJson } from "./continuation-journal";
import { shortId, withShortIds } from "./draft-diagnostics";

/** The log keeps this many of the newest entries. */
export const USAGE_ISSUE_LOG_LIMIT = 200;

export interface UsageIssueEntry {
  accountId: string;
  issue: UsageIssue;
  /** ISO time the issue appeared, once per change of issue while Relay runs. */
  at: string;
  /** Where and why: a step, an HTTP status, an error type. Never a credential. */
  detail?: string;
}
/** A detail fit for the log: one line, at most 160 characters, anything token-like masked. */
export function logDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const line = detail
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, "<redacted>")
    .slice(0, 160)
    .trim();
  return line || undefined;
}

function entriesIn(file: string): UsageIssueEntry[] {
  try {
    const value = readPrivateJson(file) as {
      version?: unknown;
      entries?: unknown;
    } | null;
    if (value?.version !== 1 || !Array.isArray(value.entries)) return [];
    return value.entries.filter(
      (entry): entry is UsageIssueEntry =>
        !!entry &&
        typeof entry.accountId === "string" &&
        typeof entry.issue === "string" &&
        typeof entry.at === "string" &&
        (entry.detail === undefined || typeof entry.detail === "string"),
    );
  } catch {
    // Missing, unreadable or corrupt: start a new log rather than lose the issue.
    return [];
  }
}

/**
 * Append one usage issue to the private diagnosis log, keeping the newest
 * {@link USAGE_ISSUE_LOG_LIMIT}. Only the account's short id (`shortId`), the issue, the time
 * and the issue's `logDetail` are written, never a credential. A failed write is swallowed: the log is a
 * diagnostic aid and must never disturb usage polling. Returns whether it saved.
 */
export function appendUsageIssue(
  file: string,
  entry: { accountId: string; issue: UsageIssue; detail?: string },
  now: number,
): boolean {
  try {
    const entries = [
      ...entriesIn(file),
      {
        accountId: shortId(entry.accountId) ?? "",
        issue: entry.issue,
        at: new Date(now).toISOString(),
        ...(logDetail(entry.detail) ? { detail: logDetail(entry.detail) } : {}),
      },
    ]
      .slice(-USAGE_ISSUE_LOG_LIMIT)
      .map(withShortIds);
    writePrivateJson(file, { version: 1, entries });
    return true;
  } catch {
    return false;
  }
}
