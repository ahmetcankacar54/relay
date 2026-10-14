import { MAX_USAGE_GAP_MS, type UsageSample } from "./usage-statistics";
import type { UsageWindow } from "./types";

export const ROLLUP_DAYS = 90;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FIVE_HOURS_MS = 5 * HOUR_MS;
// Reported reset times jitter slightly between polls of the same window.
const RESET_TOLERANCE_MS = 120_000;

export interface HourRollup {
  points: number;
  windows: number;
  coveredMinutes: number;
}
export interface WindowRecord {
  resetAt: string;
  maxPercent: number;
}
export interface LimitHit {
  identity: string;
  kind: "five-hour" | "weekly";
  at: string;
  until?: string;
  resetAt?: string;
}
export interface UsageRollups {
  version: 1;
  /** identity → UTC hour start ISO → rollup */
  hours: Record<string, Record<string, HourRollup>>;
  /** identity → observed five-hour windows */
  windows: Record<string, WindowRecord[]>;
  hits: LimitHit[];
  /** identity → last folded sample, the baseline for the next increase */
  last: Record<string, UsageSample>;
}

export const emptyRollups = (): UsageRollups => ({
  version: 1,
  hours: {},
  windows: {},
  hits: [],
  last: {},
});

export function hourKey(time: number): string {
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
}

// Same rule as summarizeUsageSamples: a five-hour reset in (checkedAt, +5h].
function validWindow(sample: UsageSample): boolean {
  const reset = sample.fiveHour?.resetsAt;
  if (!reset) return false;
  const checkedAt = Date.parse(sample.checkedAt);
  const resetAt = Date.parse(reset);
  return resetAt > checkedAt && resetAt <= checkedAt + FIVE_HOURS_MS;
}

function sameReset(a: string, b: string): boolean {
  return Math.abs(Date.parse(a) - Date.parse(b)) <= RESET_TOLERANCE_MS;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

function foldHits(r: UsageRollups, s: UsageSample, t: number): void {
  const kinds: [LimitHit["kind"], UsageWindow | undefined][] = [
    ["five-hour", s.fiveHour],
    ["weekly", s.sevenDay],
  ];
  for (const [kind, window] of kinds) {
    if (!window) continue;
    const pct = window.usedPercent;
    let open: LimitHit | undefined;
    for (const hit of r.hits)
      if (hit.identity === s.identity && hit.kind === kind) open = hit;
    let isOpen = !!open && open.until === undefined;
    if (isOpen) {
      const resetAt = open!.resetAt ? Date.parse(open!.resetAt) : Infinity;
      if (pct < 100 || t >= resetAt) {
        open!.until = new Date(Math.min(t, resetAt)).toISOString();
        isOpen = false;
      }
    }
    // A window whose reset has already passed reports stale quota.
    const expired =
      window.resetsAt !== undefined && Date.parse(window.resetsAt) <= t;
    if (!isOpen && pct >= 100 && !expired)
      r.hits.push({
        identity: s.identity,
        kind,
        at: s.checkedAt,
        ...(window.resetsAt ? { resetAt: window.resetsAt } : {}),
      });
  }
}

function prune(r: UsageRollups, now: number): void {
  const cutoff = now - ROLLUP_DAYS * DAY_MS;
  for (const [identity, hours] of Object.entries(r.hours)) {
    for (const key of Object.keys(hours))
      if (Date.parse(key) < cutoff) delete hours[key];
    if (!Object.keys(hours).length) delete r.hours[identity];
  }
  for (const [identity, windows] of Object.entries(r.windows)) {
    const kept = windows.filter((w) => Date.parse(w.resetAt) >= cutoff);
    if (kept.length) r.windows[identity] = kept;
    else delete r.windows[identity];
  }
  r.hits = r.hits.filter((hit) => Date.parse(hit.at) >= cutoff);
}

/**
 * Folds one sample into the rollups and returns a new object. Points follow
 * summarizeUsageSamples: increases over the window's high-water mark between
 * consecutive samples of one identity in the same five-hour window, at most
 * MAX_USAGE_GAP_MS apart; the first sample after a gap or new window is a
 * baseline. Reset times within ±2 minutes are the same window.
 */
export function foldSample(
  r: UsageRollups,
  s: UsageSample,
  now: number,
): UsageRollups {
  if (!accepts(r, s)) return r;
  const next = structuredClone(r);
  foldInto(next, s);
  prune(next, now);
  return next;
}

/** Out-of-order and duplicate samples (per identity) are ignored. */
function accepts(r: UsageRollups, s: UsageSample): boolean {
  const t = Date.parse(s.checkedAt);
  const prev = r.last[s.identity];
  return Number.isFinite(t) && !(prev && Date.parse(prev.checkedAt) >= t);
}

// Mutates `next`; callers own it (a clone, or the backfill accumulator).
function foldInto(next: UsageRollups, s: UsageSample): void {
  const t = Date.parse(s.checkedAt);
  const prev = next.last[s.identity];
  const hours = (next.hours[s.identity] ??= {});
  const hour = (hours[hourKey(t)] ??= {
    points: 0,
    windows: 0,
    coveredMinutes: 0,
  });
  if (validWindow(s)) {
    const reset = s.fiveHour!.resetsAt!;
    const pct = s.fiveHour!.usedPercent;
    const windows = (next.windows[s.identity] ??= []);
    // Windows are appended in time order, so a match is almost always last.
    let record: WindowRecord | undefined;
    for (let i = windows.length - 1; i >= 0 && !record; i--)
      if (sameReset(windows[i].resetAt, reset)) record = windows[i];
    if (!record) {
      record = { resetAt: reset, maxPercent: pct };
      windows.push(record);
      hour.windows += 1;
    }
    const high = record.maxPercent;
    const gap = prev ? t - Date.parse(prev.checkedAt) : Infinity;
    if (
      prev &&
      validWindow(prev) &&
      sameReset(prev.fiveHour!.resetsAt!, reset) &&
      gap > 0 &&
      gap <= MAX_USAGE_GAP_MS
    ) {
      hour.coveredMinutes = round2(hour.coveredMinutes + gap / 60_000);
      hour.points = round2(hour.points + Math.max(0, pct - high));
    }
    record.maxPercent = Math.max(high, pct);
  }
  foldHits(next, s, t);
  next.last[s.identity] = structuredClone(s);
}

/**
 * Backfill: folds samples per identity in time order into one accumulator
 * (cloning per sample would be quadratic) and prunes once at the end.
 */
export function foldSamples(
  samples: readonly UsageSample[],
  now: number,
): UsageRollups {
  const sorted = samples
    .slice()
    .sort((a, b) =>
      a.identity === b.identity
        ? Date.parse(a.checkedAt) - Date.parse(b.checkedAt)
        : a.identity < b.identity
          ? -1
          : 1,
    );
  const r = emptyRollups();
  for (const sample of sorted) if (accepts(r, sample)) foldInto(r, sample);
  prune(r, now);
  return r;
}
