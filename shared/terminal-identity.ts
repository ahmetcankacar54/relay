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

type T = (tr: string, en: string) => string;

/** One sentence for a step's outcome; undefined when there is nothing worth saying. */
export function terminalLine(
  outcome: TerminalOutcome,
  t: T,
  name?: string,
): string | undefined {
  const to = name ?? t("bu hesap", "this account");
  if (outcome.result === "switched")
    return [
      t(
        `Terminaldeki Claude Code ${to} hesabına geçti. Açık terminal oturumlarını yeniden başlat.`,
        `Claude Code in the terminal moved to ${to}. Restart open terminal sessions.`,
      ),
      outcome.unconfirmed
        ? t(
            "Bu giriş eski olabilir. Giriş isterse bir kez “claude auth login” yap.",
            "This sign-in can be old. If Claude Code asks you to sign in, run “claude auth login” once.",
          )
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  switch (outcome.reason) {
    case "already-there":
      return t(
        `Terminaldeki Claude Code zaten ${to} hesabında.`,
        `Claude Code in the terminal is already on ${to}.`,
      );
    case "no-saved-login":
      return t(
        `${to} için kayıtlı terminal girişi yok. Terminalde bir kez “claude auth login” ile bu hesaba gir. Relay girişi kaydeder.`,
        `${to} has no saved terminal sign-in. Sign in once in a terminal with “claude auth login”. Relay saves it.`,
      );
    case "unknown-account":
      return t(
        "Terminaldeki Claude Code, Relay’de olmayan bir hesapta; Relay o girişe dokunmaz. Terminalde “claude auth login” ile Relay hesaplarından birine gir.",
        "Claude Code in the terminal is on an account that is not in Relay. Relay does not change that sign-in. Sign in to a Relay account with “claude auth login”.",
      );
    case "mismatch":
      return t(
        "Terminaldeki giriş, ~/.claude.json’un söylediğinden başka bir hesaba ait; Relay kaydetmedi ve değiştirmedi. Terminalde “claude auth login” ile yeniden gir.",
        "The terminal sign-in is for a different account than ~/.claude.json shows. Relay did not save or replace it. Sign in again with “claude auth login”.",
      );
    case "unsupported":
      return t(
        "Bu Mac’te terminal girişi yönetilemiyor.",
        "Relay cannot manage the terminal sign-in on this Mac.",
      );
    case "busy":
      return t(
        "Claude Code o sırada girişini yeniliyordu; terminal değiştirilmedi. “Şimdi eşitle” ile tekrar dene.",
        "Claude Code renewed its sign-in at that moment, so Relay did not change the terminal. Try again with “Sync now”.",
      );
    case "locked":
      return t(
        "Anahtarlık okunamadı. Kilidini açıp tekrar dene.",
        "Relay cannot read the Keychain. Unlock it and try again.",
      );
    case "unreadable":
      return t(
        "Terminaldeki Claude Code girişi okunamadı.",
        "Relay cannot read the Claude Code sign-in in the terminal.",
      );
    case "write-failed":
      return t(
        "Terminal girişi yazılamadı; önceki giriş yerinde bırakıldı.",
        "Relay cannot write the terminal sign-in. The previous sign-in stays in place.",
      );
    case "restore-failed":
      return t(
        "Terminal girişi yazılamadı ve önceki giriş geri konamadı. Terminalde “claude auth login” ile yeniden gir.",
        "Relay cannot write the terminal sign-in or put back the previous one. Sign in again with “claude auth login”.",
      );
    default:
      return outcome.result === "failed"
        ? t(
            "Terminal girişi değiştirilemedi.",
            "Relay cannot change the terminal sign-in.",
          )
        : undefined;
  }
}
