import type { Account, AccountUsage } from "../../shared/types";
import { modelOnlyUsage } from "../../shared/quota-windows";

const HOUR = 3_600_000;
/** A week ending this soon with this much left: what is left may be lost at the reset. */
const EXPIRING_MS = 48 * HOUR;
const EXPIRING_ROOM = 10;

/** Where an account stands now, in the order the board lists them. */
export type LimitStanding =
  /** A five-hour or weekly window is used up: nothing goes there until `opensAt`. */
  | { kind: "full"; opensAt?: string }
  /** Its week ends soon with room left: what is left is lost unless used first. */
  | { kind: "expiring"; endsAt: string; left: number }
  | { kind: "open"; endsAt?: string }
  | { kind: "unread" };

const valid = (iso: string | undefined, now: number) => !!iso && Date.parse(iso) > now;

/** The board's reading of one account (exported for tests). */
export function limitStanding(usage: AccountUsage | undefined, now: number): LimitStanding {
  // An old reading still says how the account stood; the row says it is old.
  if (!usage || (!usage.fiveHour && !usage.sevenDay)) return { kind: "unread" };
  // A window whose reset has passed is empty again, as everywhere else, until it is read anew.
  const full = [usage.fiveHour, usage.sevenDay].filter((w) => !!w && w.usedPercent >= 100 && !(w.resetsAt && Date.parse(w.resetsAt) <= now));
  if (full.length)
    return {
      kind: "full",
      ...(full.some((w) => valid(w!.resetsAt, now))
        ? { opensAt: full.map((w) => w!.resetsAt!).filter((r) => valid(r, now)).sort().at(-1) }
        : {}),
    };
  // Antigravity's week, when it has one, is only its roomiest model: no week of its own ends.
  const week = modelOnlyUsage(usage) ? undefined : usage.sevenDay;
  if (week?.resetsAt && valid(week.resetsAt, now)) {
    const left = Math.max(0, 100 - week.usedPercent);
    if (Date.parse(week.resetsAt) - now <= EXPIRING_MS && left >= EXPIRING_ROOM)
      return { kind: "expiring", endsAt: week.resetsAt, left };
    return { kind: "open", endsAt: week.resetsAt };
  }
  return { kind: "open" };
}

/**
 * The board's order: accounts whose week ends soon with room first (use them first), then the
 * others by when their week ends, the full ones after, and accounts never read last. The
 * gateway's "soonest reset" order works the same way.
 */
export function boardOrder(accounts: Account[], usage: Record<string, AccountUsage | undefined>, now: number): Account[] {
  const rank = (s: LimitStanding) => ({ expiring: 0, open: 1, full: 2, unread: 3 })[s.kind];
  const ends = (s: LimitStanding) =>
    s.kind === "expiring" || s.kind === "open" ? Date.parse(s.endsAt ?? "") || Infinity : Date.parse((s.kind === "full" && s.opensAt) || "") || Infinity;
  return accounts
    .map((account, index) => ({ account, index, s: limitStanding(usage[account.id], now) }))
    .sort((a, b) => rank(a.s) - rank(b.s) || ends(a.s) - ends(b.s) || a.index - b.index)
    .map((x) => x.account);
}
