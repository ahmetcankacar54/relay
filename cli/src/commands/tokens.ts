import fs from "node:fs";
import path from "node:path";
import { readPrivateJson } from "../../../electron/core/continuation-journal";
import {
  TOKEN_ROW_LABELS,
  buildTokenUsageView,
  type LedgerSnapshot,
  type TokenCounts,
} from "../../../shared/token-usage-view";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import { formatCost, formatTokens } from "../../../shared/number-format";
import { resolveAccount } from "../accounts";
import type { Command } from "../command";
import { openContext } from "../context";
import { CliError, EXIT } from "../io";
import { printJson, table } from "../output";

const total = (c: TokenCounts) => c.input + c.output + c.cacheWrite + c.cacheRead;

/** The ledger Relay.app keeps, as the view builder takes it; undefined when there is none. */
function readLedger(file: string): LedgerSnapshot | undefined {
  if (!fs.existsSync(file)) return undefined;
  // readPrivateJson allocates its limit up front: give it the file's size (it re-checks), not
  // the 64 MB cap.
  const size = fs.lstatSync(file).size;
  const cap = 64 * 1024 * 1024;
  if (size > cap)
    throw new CliError("The token ledger is larger than relay reads (64 MB).", EXIT.failed);
  const saved = readPrivateJson(file, Math.min(cap, size + 64 * 1024)) as {
    version?: number;
    complete?: boolean;
    days?: LedgerSnapshot["days"];
    slots?: LedgerSnapshot["slots"];
    slotsSince?: number;
    files?: Record<string, { size?: number; offset?: number; broken?: boolean }>;
  };
  // Relay.app has written version 3 since 2026-10-18; it reads version 2 the same way.
  if ((saved?.version !== 2 && saved?.version !== 3) || !saved.days || typeof saved.days !== "object")
    throw new CliError("The token ledger is in a format this relay does not know. Update relay.", EXIT.environment);
  let scannedBytes = 0,
    totalBytes = 0;
  for (const state of Object.values(saved.files ?? {})) {
    if (state?.broken) continue;
    scannedBytes += Number(state?.offset) || 0;
    totalBytes += Number(state?.size) || 0;
  }
  return {
    days: saved.days,
    ...(saved.slots && typeof saved.slots === "object" ? { slots: saved.slots } : {}),
    ...(typeof saved.slotsSince === "number" ? { slotsSince: saved.slotsSince } : {}),
    progress: { scannedBytes, totalBytes, complete: saved.complete === true },
  };
}

/** When the active-account timeline began: its first segment's start. Read only, never rewritten. */
function exactSince(file: string): number | undefined {
  try {
    const value = readPrivateJson(file) as { version?: number; segments?: { from?: unknown }[] };
    const from = value?.version === 1 ? value.segments?.[0]?.from : undefined;
    const time = typeof from === "string" ? Date.parse(from) : NaN;
    return Number.isFinite(time) ? time : undefined;
  } catch {
    return undefined;
  }
}

export const tokens: Command = async ({ io, deps, parsed, t, lang }) => {
  if (parsed.positionals.length) throw new CliError(t("tokens.usageRelayTokensDays730"), EXIT.usage);
  const days = Number(parsed.flags.days ?? 7);
  if (![7, 30, 90].includes(days))
    throw new CliError(t("tokens.daysMustBe730Or"), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const ledger = readLedger(path.join(ctx.paths.data, "token-ledger.json"));
  if (!ledger) {
    io.stdout(
      t("tokens.thereIsNoTokenLedgerYet"),
    );
    return EXIT.ok;
  }
  const accounts = ctx.store.state.accounts;
  const account = parsed.flags.account ? resolveAccount(accounts, String(parsed.flags.account), t) : undefined;
  const zone = ctx.store.state.settings.planning.timeZone;
  const view = buildTokenUsageView({
    ledger,
    accounts,
    range: days as StatisticsRange,
    accountId: account?.id,
    zone,
    now: io.now(),
    exactSince: exactSince(path.join(ctx.paths.data, "active-account-timeline.json")),
  });
  if (ctx.json) {
    printJson(io, view);
    return EXIT.ok;
  }
  const n = (value: number) => formatTokens(value, lang);
  const usd = (value: number | undefined) => formatCost(value ?? 0, lang);
  const label = (row: (typeof view.rows)[number]) =>
    row.kind === "account" ? (row.name ?? "") : t(TOKEN_ROW_LABELS[row.kind]);
  io.stdout(
    t("tokens.tokenUsageLastDays", { days, zone }),
  );
  io.stdout(
    t("tokens.totalInputOutputCacheWriteCache", {
      total: n(total(view.totals)),
      input: n(view.totals.input),
      output: n(view.totals.output),
      cacheWrite: n(view.totals.cacheWrite),
      cacheRead: n(view.totals.cacheRead),
      cost: `${view.totals.costEstimated ? "≈" : ""}${usd(view.totals.cost)}`,
    }),
  );
  if (view.rows.length) {
    const rows = [...view.days].reverse().map((day) => [
      day.date,
      ...view.rows.map((row) => {
        const cell = day.byRow[row.key];
        return cell && total(cell) ? `${cell.estimated ? "≈" : ""}${n(total(cell))}` : "—";
      }),
      n(Object.values(day.byRow).reduce((sum, cell) => sum + total(cell), 0)),
      `${Object.values(day.byRow).some((cell) => cell.costEstimated) ? "≈" : ""}${usd(
        Object.values(day.byRow).reduce((sum, cell) => sum + (cell.cost ?? 0), 0),
      )}`,
    ]);
    io.stdout("");
    io.stdout(
      table([t("tokens.day"), ...view.rows.map(label), t("common.total"), t("common.apiValue")], rows),
    );
  }
  io.stdout("");
  if (view.exactSince)
    io.stdout(
      t("tokens.exactAccountMatchingHasBeenKept", { viewExactSince: view.exactSince }),
    );
  io.stdout(
    t("tokens.apiValueAnthropicApiListPrices", { viewPricesChecked: view.pricesChecked }),
  );
  if (!view.progress.complete)
    io.stdout(t("tokens.transcriptsAreStillBeingScanned", { progressPercent: view.progress.percent }));
  return EXIT.ok;
};
