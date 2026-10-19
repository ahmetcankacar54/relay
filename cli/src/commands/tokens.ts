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
    files?: Record<string, { size?: number; offset?: number; broken?: boolean }>;
  };
  if (saved?.version !== 2 || !saved.days || typeof saved.days !== "object")
    throw new CliError("The token ledger is in a format this relay does not know. Update relay.", EXIT.environment);
  let scannedBytes = 0,
    totalBytes = 0;
  for (const state of Object.values(saved.files ?? {})) {
    if (state?.broken) continue;
    scannedBytes += Number(state?.offset) || 0;
    totalBytes += Number(state?.size) || 0;
  }
  return { days: saved.days, progress: { scannedBytes, totalBytes, complete: saved.complete === true } };
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
  if (parsed.positionals.length) throw new CliError(t("Kullanım: relay tokens [--days 7|30|90] [--account <ad>]", "Usage: relay tokens [--days 7|30|90] [--account <name>]"), EXIT.usage);
  const days = Number(parsed.flags.days ?? 7);
  if (![7, 30, 90].includes(days))
    throw new CliError(t("--days 7, 30 ya da 90 olmalı.", "--days must be 7, 30 or 90."), EXIT.usage);
  const ctx = await openContext(io, deps, parsed.flags, { write: false, desktop: false });
  const ledger = readLedger(path.join(ctx.paths.data, "token-ledger.json"));
  if (!ledger) {
    io.stdout(
      t(
        "Henüz token kaydı yok. Kaydı Relay.app tutar; uygulama açıkken birikir.",
        "There is no token ledger yet. Relay.app keeps it, while the app is open.",
      ),
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
  const format = new Intl.NumberFormat(lang === "tr" ? "tr-TR" : "en-US", { notation: "compact", maximumFractionDigits: 1 });
  const n = (value: number) => format.format(value);
  const label = (row: (typeof view.rows)[number]) =>
    row.kind === "account" ? (row.name ?? "") : TOKEN_ROW_LABELS[row.kind][lang];
  io.stdout(
    t(`Token kullanımı · son ${days} gün (${zone})`, `Token usage · last ${days} days (${zone})`),
  );
  io.stdout(
    t(
      `Toplam ${n(total(view.totals))} · girdi ${n(view.totals.input)} · çıktı ${n(view.totals.output)} · önbellek yazma ${n(view.totals.cacheWrite)} · önbellek okuma ${n(view.totals.cacheRead)}`,
      `Total ${n(total(view.totals))} · input ${n(view.totals.input)} · output ${n(view.totals.output)} · cache write ${n(view.totals.cacheWrite)} · cache read ${n(view.totals.cacheRead)}`,
    ),
  );
  if (view.rows.length) {
    const rows = [...view.days].reverse().map((day) => [
      day.date,
      ...view.rows.map((row) => {
        const cell = day.byRow[row.key];
        return cell && total(cell) ? `${cell.estimated ? "≈" : ""}${n(total(cell))}` : "—";
      }),
      n(Object.values(day.byRow).reduce((sum, cell) => sum + total(cell), 0)),
    ]);
    io.stdout("");
    io.stdout(table([t("Gün", "Day"), ...view.rows.map(label), t("Toplam", "Total")], rows));
  }
  io.stdout("");
  if (view.exactSince)
    io.stdout(
      t(
        `Kesin hesap eşleşmesi ${view.exactSince} tarihinden beri tutuluyor; öncesi Relay'in limit ölçümlerinden tahmin edildi (≈).`,
        `Exact account matching has been kept since ${view.exactSince}; earlier days were estimated from Relay's limit samples (≈).`,
      ),
    );
  if (!view.progress.complete)
    io.stdout(t(`Konuşma kayıtları hâlâ taranıyor: %${view.progress.percent}.`, `Transcripts are still being scanned: ${view.progress.percent}%.`));
  return EXIT.ok;
};
