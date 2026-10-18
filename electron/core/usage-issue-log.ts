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
        typeof entry.at === "string",
    );
  } catch {
    // Missing, unreadable or corrupt: start a new log rather than lose the issue.
    return [];
  }
}

/**
 * Append one usage issue to the private diagnosis log, keeping the newest
 * {@link USAGE_ISSUE_LOG_LIMIT}. Only the account's short id (`shortId`), the issue and
 * the time are written, never a credential. A failed write is swallowed: the log is a
 * diagnostic aid and must never disturb usage polling. Returns whether it saved.
 */
export function appendUsageIssue(
  file: string,
  entry: { accountId: string; issue: UsageIssue },
  now: number,
): boolean {
  try {
    const entries = [
      ...entriesIn(file),
      {
        accountId: shortId(entry.accountId) ?? "",
        issue: entry.issue,
        at: new Date(now).toISOString(),
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
