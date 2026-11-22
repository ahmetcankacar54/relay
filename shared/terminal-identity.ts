import type { T } from "./i18n/translate";
/**
 * What Relay does with the terminal's Claude Code sign-in (the plain `claude`, without
 * CLAUDE_CONFIG_DIR) at a switch:
 * - "follow": puts the account's saved terminal sign-in in place, after saving the one it leaves.
 * - "off": never reads or touches it.
 */
export const TERMINAL_MODES = ["follow", "off"] as const;
export type TerminalMode = (typeof TERMINAL_MODES)[number];
/** Missing in the registry means "follow". */
export const DEFAULT_TERMINAL_MODE: TerminalMode = "follow";

/** Who a terminal sign-in belongs to: the person and the organization, both lowercase. */
export interface TerminalIdentity {
  accountUuid: string;
  orgId: string;
}

/** Who the terminal's `claude` is signed in to, as Relay last read it. */
export interface TerminalCurrent {
  state: "signed-in" | "signed-out" | "unreadable";
  accountUuid?: string;
  orgId?: string;
  /** Shown for a sign-in Relay does not know, so the user can tell which one it is. */
  email?: string;
  orgName?: string;
  /** The sign-in belongs to one of Relay's accounts. */
  known?: boolean;
  /** Anthropic says the token is another account's than `~/.claude.json` names. */
  mismatch?: boolean;
  at: string;
}

export type TerminalReason =
  | "off"
  | "unsupported"
  /** Claude Code was renewing the sign-in; nothing was touched. */
  | "busy"
  /** The terminal is on an account Relay does not have; it is never overwritten. */
  | "unknown-account"
  /** The target has no terminal sign-in saved yet. */
  | "no-saved-login"
  /** The token is another account's than `~/.claude.json` names; nothing is saved or replaced. */
  | "mismatch"
  | "already-there"
  | "locked"
  | "unreadable"
  | "write-failed"
  | "restore-failed";

export interface TerminalOutcome {
  result: "switched" | "unchanged" | "saved" | "skipped" | "failed";
  reason?: TerminalReason;
  /** The sign-in the terminal held was saved for its account. */
  saved: boolean;
  /**
   * The sign-in put in place was saved while in use and never taken away at a switch, so Claude
   * Code may have renewed it since: it may ask for a sign-in once.
   */
  unconfirmed?: boolean;
  current?: TerminalCurrent;
  at: string;
}

/** A saved terminal sign-in: whose, when, and whether it was taken away at a switch (still good). */
export interface TerminalSaved extends TerminalIdentity {
  savedAt: string;
  parked: boolean;
}

export interface TerminalStatus {
  mode: TerminalMode;
  current?: TerminalCurrent;
  saved: TerminalSaved[];
  last?: TerminalOutcome;
  /**
   * Claude Code is connected to Relay's gateway: its requests use the account the gateway picks
   * for each one, and the sign-in above is used only while Relay is not running.
   */
  viaGateway?: boolean;
}

/** An account's identities that a terminal sign-in can belong to: its Desktop one and its own. */
export function terminalIdentities(account: {
  desktop?: { accountUuid: string; orgId: string };
  auth?: { accountUuid?: string; orgId?: string };
}): TerminalIdentity[] {
  const out: TerminalIdentity[] = [];
  const add = (accountUuid?: string, orgId?: string) => {
    if (!accountUuid || !orgId) return;
    const id = {
      accountUuid: accountUuid.toLowerCase(),
      orgId: orgId.toLowerCase(),
    };
    if (!out.some((x) => sameIdentity(x, id))) out.push(id);
  };
  add(account.desktop?.accountUuid, account.desktop?.orgId);
  add(account.auth?.accountUuid, account.auth?.orgId);
  return out;
}

export function sameIdentity(
  a: TerminalIdentity,
  b: TerminalIdentity,
): boolean {
  return (
    a.accountUuid.toLowerCase() === b.accountUuid.toLowerCase() &&
    a.orgId.toLowerCase() === b.orgId.toLowerCase()
  );
}


/** One sentence for a step's outcome; undefined when there is nothing worth saying. */
export function terminalLine(
  outcome: TerminalOutcome,
  t: T,
  name?: string,
): string | undefined {
  const to = name ?? t("sharedTerminalIdentity.thisAccount");
  if (outcome.result === "switched")
    return [
      t("sharedTerminalIdentity.claudeCodeInTheTerminalMoved", { to }),
      outcome.unconfirmed
        ? t("sharedTerminalIdentity.thisSignInCanBeOld")
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  switch (outcome.reason) {
    case "already-there":
      return t("sharedTerminalIdentity.claudeCodeInTheTerminalIs", { to });
    case "no-saved-login":
      return t("sharedTerminalIdentity.hasNoSavedTerminalSignIn", { to });
    case "unknown-account":
      return t("sharedTerminalIdentity.claudeCodeInTheTerminalIs2");
    case "mismatch":
      return t("sharedTerminalIdentity.theTerminalSignInIsFor");
    case "unsupported":
      return t("sharedTerminalIdentity.relayCannotManageTheTerminalSign");
    case "busy":
      return t("sharedTerminalIdentity.claudeCodeRenewedItsSignIn");
    case "locked":
      return t("sharedTerminalIdentity.relayCannotReadTheKeychainUnlock");
    case "unreadable":
      return t("sharedTerminalIdentity.relayCannotReadTheClaudeCode");
    case "write-failed":
      return t("sharedTerminalIdentity.relayCannotWriteTheTerminalSign");
    case "restore-failed":
      return t("sharedTerminalIdentity.relayCannotWriteTheTerminalSign2");
    default:
      return outcome.result === "failed"
        ? t("sharedTerminalIdentity.relayCannotChangeTheTerminalSign")
        : undefined;
  }
}
