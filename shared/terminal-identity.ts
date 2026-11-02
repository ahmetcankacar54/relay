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
        `Terminaldeki Claude Code ${to} hesabına geçti. Açık terminal oturumlarını yeniden başlat; eski hesabın kurum bilgisiyle devam ederler.`,
        `The terminal’s Claude Code moved to ${to}. Restart terminal sessions that are open: they carry on with the old account’s organization details.`,
      ),
      outcome.unconfirmed
        ? t(
            "Bu giriş, hesap terminalden elle değiştirilmeden önce kaydedilmişti; giriş isterse bir kez “claude auth login” yap.",
            "This sign-in was saved before the account left the terminal by hand; if it asks you to sign in, run “claude auth login” once.",
          )
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  switch (outcome.reason) {
    case "already-there":
      return t(
        `Terminaldeki Claude Code zaten ${to} hesabında.`,
        `The terminal’s Claude Code is already on ${to}.`,
      );
    case "no-saved-login":
      return t(
        `${to} için kayıtlı terminal girişi yok. Terminalde bir kez “claude auth login” ile bu hesaba gir; Relay girişi kaydeder.`,
        `${to} has no saved terminal sign-in. Sign in once in a terminal with “claude auth login”; Relay saves it.`,
      );
    case "unknown-account":
      return t(
        "Terminaldeki Claude Code, Relay’de olmayan bir hesapta; Relay o girişe dokunmaz. Terminalde “claude auth login” ile Relay hesaplarından birine gir.",
        "The terminal’s Claude Code is on an account Relay does not have, and Relay leaves that sign-in alone. Sign it in to one of Relay’s accounts with “claude auth login”.",
      );
    case "mismatch":
      return t(
        "Terminaldeki giriş, ~/.claude.json’un söylediğinden başka bir hesaba ait; Relay kaydetmedi ve değiştirmedi. Terminalde “claude auth login” ile yeniden gir.",
        "The terminal’s sign-in belongs to another account than ~/.claude.json names, so Relay neither saved nor replaced it. Sign in again with “claude auth login”.",
      );
    case "unsupported":
      return t(
        "Bu Mac’te terminal girişi yönetilemiyor.",
        "The terminal’s sign-in cannot be managed on this Mac.",
      );
    case "busy":
      return t(
        "Claude Code o sırada girişini yeniliyordu; terminal değiştirilmedi. “Şimdi eşitle” ile tekrar dene.",
        "Claude Code was renewing its sign-in at that moment, so the terminal was not changed. Try Sync now.",
      );
    case "locked":
      return t(
        "Anahtar Zinciri okunamadı. Kilidini açıp tekrar dene.",
        "The Keychain could not be read. Unlock it and try again.",
      );
    case "unreadable":
      return t(
        "Terminaldeki Claude Code girişi okunamadı.",
        "Could not read the terminal’s Claude Code sign-in.",
      );
    case "write-failed":
      return t(
        "Terminal girişi yazılamadı; önceki giriş yerinde bırakıldı.",
        "The terminal sign-in could not be written; the previous one was left in place.",
      );
    case "restore-failed":
      return t(
        "Terminal girişi yazılamadı ve önceki giriş geri konamadı. Terminalde “claude auth login” ile yeniden gir.",
        "The terminal sign-in could not be written and the previous one could not be put back. Sign in again with “claude auth login”.",
      );
    default:
      return outcome.result === "failed"
        ? t(
            "Terminal girişi değiştirilemedi.",
            "The terminal’s sign-in could not be changed.",
          )
        : undefined;
  }
}
