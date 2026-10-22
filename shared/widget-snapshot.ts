import { formatChange, formatCost, formatTokens, type NumberLanguage } from "./number-format";
import type { TokenToday } from "./token-usage-view";

/**
 * What the macOS widget draws, written by Relay to
 * `<userData>/widget/today.json`. Every string is formatted here, so the
 * widget only lays them out; it never formats numbers or translates.
 */
export interface WidgetSnapshot {
  version: 1;
  generatedAt: number;
  date: string;
  zone: string;
  /** "data", "empty" (no tokens today yet) or "scanning" (the first scan is running). */
  state: "data" | "empty" | "scanning";
  totals: { input: number; output: number; cache: number; total: number };
  cost: number;
  change: number | null;
  /** The API value per quarter hour today; null after the current one. */
  slots: (number | null)[];
  yesterdayAverage: number | null;
  text: {
    title: string;
    subtitle: string;
    rows: [string, string, string];
    input: string;
    output: string;
    cache: string;
    total: string;
    cost: string;
    /** "" without a change. */
    change: string;
    /** The line under the title while `state` is not "data". */
    status: string;
    /** Shown in place of the subtitle once the file is 30 minutes old. */
    stale: string;
  };
}

export interface WidgetSnapshotInput {
  today: TokenToday;
  progress: { complete: boolean; percent: number };
  language: NumberLanguage;
  zone: string;
  now: number;
}

const clock = new Map<string, Intl.DateTimeFormat>();
function timeOf(time: number, zone: string, language: NumberLanguage) {
  const key = `${language}:${zone}`;
  let f = clock.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
    clock.set(key, f);
  }
  return f.format(time);
}

export function buildWidgetSnapshot(input: WidgetSnapshotInput): WidgetSnapshot {
  const { today, progress, language, zone, now } = input;
  const t = (tr: string, en: string) => (language === "tr" ? tr : en);
  const { totals } = today;
  const cache = totals.cacheWrite + totals.cacheRead;
  const total = totals.input + totals.output + cache;
  const cost = totals.cost ?? 0;
  const state: WidgetSnapshot["state"] = !progress.complete
    ? "scanning"
    : total === 0
      ? "empty"
      : "data";
  const percent = new Intl.NumberFormat(language === "tr" ? "tr-TR" : "en-GB", {
    style: "percent",
  }).format(progress.percent / 100);
  return {
    version: 1,
    generatedAt: now,
    date: today.date,
    zone,
    state,
    totals: { input: totals.input, output: totals.output, cache, total },
    cost,
    change: today.change,
    slots: today.slots,
    yesterdayAverage: today.yesterdayAverage,
    text: {
      title: t("Bugün", "Today"),
      subtitle: t("CLAUDE CODE · TOKEN", "CLAUDE CODE · TOKENS"),
      rows: [t("Girdi", "Input"), t("Çıktı", "Output"), t("Önbellek", "Cache")],
      input: formatTokens(totals.input, language),
      output: formatTokens(totals.output, language),
      cache: formatTokens(cache, language),
      total: formatTokens(total, language),
      cost: `${totals.costEstimated ? "≈" : ""}${formatCost(cost, language)}`,
      change: today.change === null ? "" : formatChange(today.change, language),
      status:
        state === "scanning"
          ? t(`Relay tarıyor… ${percent}`, `Relay is scanning… ${percent}`)
          : state === "empty"
            ? t("Bugün henüz token yok", "No tokens yet today")
            : "",
      stale: t(
        `Güncel değil · ${timeOf(now, zone, language)}`,
        `Not current · ${timeOf(now, zone, language)}`,
      ),
    },
  };
}

/**
 * What the widget would draw differently: a new file whose key is unchanged
 * needs no reload. `generatedAt` and the stale line move on every write.
 */
export function widgetVisibleKey(snapshot: WidgetSnapshot): string {
  const { stale: _stale, ...text } = snapshot.text;
  return JSON.stringify([
    snapshot.date,
    snapshot.state,
    text,
    snapshot.slots.map((v) => (v === null ? null : Math.round(v * 100))),
    snapshot.yesterdayAverage === null
      ? null
      : Math.round(snapshot.yesterdayAverage * 100),
  ]);
}
