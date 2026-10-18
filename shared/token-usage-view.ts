import type {
  LedgerSnapshot,
  TokenCounts,
} from "../electron/core/token-ledger";
import { localDate } from "./planning";
import type { Account } from "./types";
import {
  FORMER_KEY,
  FORMER_NAME,
  type StatisticsRange,
} from "./usage-statistics-view";

export type { LedgerSnapshot, TokenCounts };

export interface TokenRow {
  /** The account id, or "former", "terminal" or "unknown"; the key of `days[].byRow`. */
  key: string;
  kind: "account" | "former" | "terminal" | "unknown";
  accountId?: string;
  /** The account's name, or the Turkish default of the other kinds; see `TOKEN_ROW_LABELS`. */
  name?: string;
  /** Some of its tokens in the range were estimated from limit samples. */
  estimated: boolean;
  totals: TokenCounts;
}

export interface TokenUsageView {
  range: StatisticsRange;
  /** Every date of the range, oldest first, ending today in the planning zone. */
  days: {
    date: string;
    byRow: Record<string, TokenCounts & { estimated: boolean }>;
  }[];
  /** Rows with tokens in the range: accounts and the former row by total, then unknown and terminal. */
  rows: TokenRow[];
  totals: TokenCounts;
  /** Models by total, largest first. */
  models: { model: string; totals: TokenCounts }[];
  progress: { percent: number; complete: boolean };
  /** The date, in the planning zone, from which Desktop accounts are matched exactly. */
  exactSince?: string;
}

export interface TokenUsageInput {
  ledger: LedgerSnapshot;
  accounts: Account[];
  range: StatisticsRange;
  accountId?: string;
  zone: string;
  now: number;
  /** When the active-account timeline began to know, epoch milliseconds. */
  exactSince?: number;
}

export const TERMINAL_KEY = "terminal";
export const UNKNOWN_KEY = "unknown";

/** The labels of the rows that are not a current account. */
export const TOKEN_ROW_LABELS = {
  former: { tr: FORMER_NAME, en: "Former account" },
  terminal: { tr: "Relay dışı terminal", en: "Outside-Relay terminal" },
  unknown: { tr: "Hesabı bilinmeyen", en: "Unknown account" },
} as const;

const DAY_MS = 86_400_000;
const BUCKET = /^(acct|est):(.+)$/;
/** Where a row kind sorts: accounts and the former row by total, then unknown, then terminal. */
const TAIL: Record<TokenRow["kind"], number> = {
  account: 0,
  former: 0,
  unknown: 1,
  terminal: 2,
};

const zero = (): TokenCounts => ({
  input: 0,
  output: 0,
  cacheWrite: 0,
  cacheRead: 0,
  responses: 0,
});
const add = (to: TokenCounts, from: TokenCounts) => {
  to.input += from.input;
  to.output += from.output;
  to.cacheWrite += from.cacheWrite;
  to.cacheRead += from.cacheRead;
  to.responses += from.responses;
};
const total = (c: TokenCounts) =>
  c.input + c.output + c.cacheWrite + c.cacheRead;
const isEmpty = (c: TokenCounts) => total(c) === 0 && c.responses === 0;

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

interface Who {
  key: string;
  kind: TokenRow["kind"];
  accountId?: string;
  name: string;
  estimated: boolean;
}

/** The row a ledger `who` key counts toward: one per account, one for all former ones. */
function classify(who: string, accounts: Map<string, Account>): Who {
  if (who === TERMINAL_KEY)
    return {
      key: TERMINAL_KEY,
      kind: "terminal",
      name: TOKEN_ROW_LABELS.terminal.tr,
      estimated: false,
    };
  const match = BUCKET.exec(who);
  if (!match)
    return {
      key: UNKNOWN_KEY,
      kind: "unknown",
      name: TOKEN_ROW_LABELS.unknown.tr,
      estimated: false,
    };
  const estimated = match[1] === "est";
  const account = accounts.get(match[2]);
  if (account)
    return {
      key: account.id,
      kind: "account",
      accountId: account.id,
      name: account.name,
      estimated,
    };
  return { key: FORMER_KEY, kind: "former", name: FORMER_NAME, estimated };
}

/**
 * Builds the Usage page's token model from the ledger. Days follow `zone`;
 * the range is the last `range` local days including today. The ledger's
 * `acct:` and `est:` buckets of one account become one row, estimated where
 * any of its tokens were; with `accountId` only that account is kept.
 */
export function buildTokenUsageView(input: TokenUsageInput): TokenUsageView {
  const { ledger, range, zone, now } = input;
  const today = localDate(now, zone);
  const days: TokenUsageView["days"] = Array.from(
    { length: range },
    (_, i) => ({
      date: shiftDate(today, i - range + 1),
      byRow: {},
    }),
  );
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));

  const rows = new Map<string, TokenRow>();
  const models = new Map<string, TokenCounts>();
  const totals = zero();
  for (const day of days) {
    const bucket = ledger.days[day.date];
    if (!bucket) continue;
    for (const [who, byModel] of Object.entries(bucket)) {
      const target = classify(who, accounts);
      if (input.accountId !== undefined && target.key !== input.accountId)
        continue;
      for (const [model, counts] of Object.entries(byModel)) {
        if (isEmpty(counts)) continue;
        let row = rows.get(target.key);
        if (!row) {
          row = {
            key: target.key,
            kind: target.kind,
            ...(target.accountId ? { accountId: target.accountId } : {}),
            name: target.name,
            estimated: false,
            totals: zero(),
          };
          rows.set(target.key, row);
        }
        const cell = (day.byRow[target.key] ??= {
          ...zero(),
          estimated: false,
        });
        add(cell, counts);
        add(row.totals, counts);
        add(totals, counts);
        if (target.estimated) row.estimated = cell.estimated = true;
        const byName = models.get(model) ?? zero();
        add(byName, counts);
        models.set(model, byName);
      }
    }
  }

  const order = new Map([...rows.keys()].map((key, index) => [key, index]));
  const sorted = [...rows.values()].sort(
    (a, b) =>
      TAIL[a.kind] - TAIL[b.kind] ||
      total(b.totals) - total(a.totals) ||
      order.get(a.key)! - order.get(b.key)!,
  );
  const byTotal = [...models].sort(
    ([an, a], [bn, b]) =>
      total(b) - total(a) || (an < bn ? -1 : an > bn ? 1 : 0),
  );

  const { scannedBytes, totalBytes, complete } = ledger.progress;
  // Never 100 until the scan is done; a finished first scan stays 100 while
  // a later pass restarts the byte counts.
  const percent = complete
    ? 100
    : totalBytes > 0
      ? Math.min(99, Math.max(0, Math.floor((scannedBytes / totalBytes) * 100)))
      : 0;

  return {
    range,
    days,
    rows: sorted,
    totals,
    models: byTotal.map(([model, counts]) => ({ model, totals: counts })),
    progress: { percent, complete },
    ...(input.exactSince !== undefined
      ? { exactSince: localDate(input.exactSince, zone) }
      : {}),
  };
}
