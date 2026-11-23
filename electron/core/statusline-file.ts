import path from "node:path";
import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
import { tFor } from "../../shared/i18n/translate";
import { percentUsed } from "../../shared/percent";
import type { ProxySessionState } from "../../shared/proxy-types";
import {
  STATUSLINE_FILE,
  STATUSLINE_GATEWAY_SESSIONS,
  STATUSLINE_SNAPSHOT_VERSION,
  type StatuslineAccount,
  type StatuslineSnapshot,
  type StatuslineWindow,
} from "../../shared/statusline";
import { terminalIdentities, type TerminalMode } from "../../shared/terminal-identity";
import { clockLocative } from "../../shared/tr-dative";
import type { Account, AccountUsage, UsageWindow } from "../../shared/types";
import { freshUsage } from "../../shared/usage";
import { writePrivateJson } from "./continuation-journal";

export interface StatuslineSnapshotInput {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktopAccountId?: string;
  terminalMode: TerminalMode;
  /** The gateway's live sessions; undefined while it is not running. */
  gatewaySessions?: ProxySessionState[];
  /** Relay's profiles folder, `<userData>/profiles`. */
  profiles: string;
  language: Locale;
  /** The planning time zone, as every other surface of Relay shows times in. */
  zone: string;
  now: number;
}

/** Past this, a renewal names its weekday too ("Sat 21:30"). */
const SAME_DAY_MS = 20 * 60 * 60_000;

/**
 * The snapshot `relay statusline` reads: Claude accounts with their sign-ins and current limits,
 * the sessions the gateway carried, and every label already in the app's language.
 */
export function buildStatuslineSnapshot(input: StatuslineSnapshotInput): StatuslineSnapshot {
  const { language, zone, now } = input;
  const t = tFor(language);
  const locale = FORMAT_LOCALE[language];
  let clock: Intl.DateTimeFormat;
  let weekday: Intl.DateTimeFormat;
  try {
    clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: zone });
    weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: zone });
  } catch {
    // An unknown zone: the system's own.
    clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  }
  const window = (read: UsageWindow | undefined): StatuslineWindow | undefined => {
    const used = percentUsed(read?.usedPercent);
    if (used === undefined) return undefined;
    const at = Date.parse(read?.resetsAt ?? "");
    if (!Number.isFinite(at) || at <= now) return { used };
    const hour = clock.format(at);
    const time = at - now > SAME_DAY_MS ? `${weekday.format(at).replace(/\.$/, "")} ${hour}` : hour;
    return {
      used,
      resetsAt: at,
      resets: t("statusline.resets", { time, timeLocative: time.replace(/\d{1,2}:\d{2}$/, (c) => clockLocative(c)) }),
    };
  };
  const accounts: StatuslineAccount[] = input.accounts
    .filter((account) => (account.provider ?? "claude") === "claude")
    .map((account) => {
      const usage = input.usage[account.id];
      const fresh = freshUsage(usage, now) && usage.accountId === account.id;
      const fiveHour = fresh ? window(usage.fiveHour) : undefined;
      const week = fresh ? window(usage.sevenDay) : undefined;
      return {
        id: account.id,
        name: account.name,
        identities: terminalIdentities(account),
        ...(fiveHour ? { fiveHour } : {}),
        ...(week ? { week } : {}),
      };
    });
  const known = new Set(accounts.map((a) => a.id));
  // Claude Code names its session in a header the gateway keys it by: `hdr:<session id>`.
  const sessions = input.gatewaySessions
    ?.filter((s) => s.sessionKey.startsWith("hdr:") && known.has(s.accountId))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, STATUSLINE_GATEWAY_SESSIONS);
  return {
    version: STATUSLINE_SNAPSHOT_VERSION,
    generatedAt: now,
    formatLocale: locale,
    profiles: input.profiles,
    ...(input.desktopAccountId && known.has(input.desktopAccountId) ? { desktopAccountId: input.desktopAccountId } : {}),
    terminalFollows: input.terminalMode !== "off",
    accounts,
    ...(sessions
      ? { gateway: { sessions: Object.fromEntries(sessions.map((s) => [s.sessionKey.slice(4), s.accountId])) } }
      : {}),
    text: {
      fiveHour: t("statusline.fiveHour", { percent: "{percent}" }),
      week: t("widgetSnapshot.week", { pct: "{percent}" }),
      viaGateway: t("statusline.viaGateway"),
      updatedAgo: t("statusline.updatedAgo", { age: "{age}" }),
    },
  };
}

/** Writes `<dir>/statusline.json` through a private temporary file, so a reader never sees half of it. */
export function writeStatuslineFile(dir: string, snapshot: StatuslineSnapshot): void {
  writePrivateJson(path.join(dir, STATUSLINE_FILE), snapshot);
}
