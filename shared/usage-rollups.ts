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
  /** 2: coverage counts every polled gap, split across the hours it spans. */
  version: 2;
  /** identity → UTC hour start ISO → rollup */
  hours: Record<string, Record<string, HourRollup>>;
  /** identity → observed five-hour windows */
  windows: Record<string, WindowRecord[]>;
  hits: LimitHit[];
  /** identity → last folded sample, the baseline for the next increase */
  last: Record<string, UsageSample>;
}

export const emptyRollups = (): UsageRollups => ({
  version: 2,
  hours: {},
  windows: {},
  hits: [],
  last: {},
});

export function hourKey(time: number): string {
  return new Date(Math.floor(time / HOUR_MS) * HOUR_MS).toISOString();
}

// A usable five-hour window resets in (checkedAt, checkedAt + 5h].
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

const emptyHour = (): HourRollup => ({
  points: 0,
  windows: 0,
  coveredMinutes: 0,
});

function addCoverage(
  hours: Record<string, HourRollup>,
  from: number,
  to: number,
): void {
  for (let at = from; at < to;) {
    const end = Math.min(to, (Math.floor(at / HOUR_MS) + 1) * HOUR_MS);
    const hour = (hours[hourKey(at)] ??= emptyHour());
    hour.coveredMinutes = round2(hour.coveredMinutes + (end - at) / 60_000);
    at = end;
  }
}

function foldHits(r: UsageRollups, s: UsageSample, t: number): void {
  const kinds: [LimitHit["kind"], UsageWindow | undefined][] = [
    ["five-hour", s.fiveHour],
    ["weekly", s.sevenDay],
  ];
  for (const [kind, window] of kinds) {
    let open: LimitHit | undefined;
    for (const hit of r.hits)
      if (hit.identity === s.identity && hit.kind === kind) open = hit;
    let isOpen = !!open && open.until === undefined;
    if (isOpen) {
      // Like its window record, an open hit follows a drifting reset.
      if (
        window?.resetsAt &&
        open!.resetAt &&
        sameReset(open!.resetAt, window.resetsAt)
      )
        open!.resetAt = window.resetsAt;
      const resetAt = open!.resetAt ? Date.parse(open!.resetAt) : Infinity;
      // A passed reset closes the hit even if this poll lacks that window.
      if ((window && window.usedPercent < 100) || t >= resetAt) {
        open!.until = new Date(Math.min(t, resetAt)).toISOString();
        isOpen = false;
      }
    }
    if (!window) continue;
    const pct = window.usedPercent;
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
  for (const [identity, sample] of Object.entries(r.last))
    if (Date.parse(sample.checkedAt) < cutoff) delete r.last[identity];
}

/**
 * Folds one sample into the rollups and returns a new object. Points are
 * increases over the window's high-water mark between consecutive samples of
 * one identity in the same five-hour window, at most MAX_USAGE_GAP_MS apart;
 * the first sample after a gap or new window is a baseline. Reset times within
 * ±2 minutes are the same window. Coverage counts every gap of at most
 * MAX_USAGE_GAP_MS between consecutive samples, whatever their windows, and
 * credits each UTC hour the minutes that fall inside it.
 */
export function foldSample(
  r: UsageRollups,
  s: UsageSample,
  now: number,
): UsageRollups {
  const base = withoutFuture(r, now);
  if (!accepts(base, s)) return base;
  const next = base === r ? structuredClone(r) : base;
  foldInto(next, s);
  prune(next, now);
  return next;
}

/**
 * Drops what samples stamped later than `now` folded in (the clock moved
 * back), so the next sample is accepted again as a baseline: their last
 * samples, later hours, windows starting later and hits opening later; a hit
 * they closed is open again. Returns `r` itself when nothing is later.
 */
function withoutFuture(r: UsageRollups, now: number): UsageRollups {
  // Every folded sample is at or before its identity's last one.
  const later = (time: string) => Date.parse(time) > now;
  if (!Object.values(r.last).some((s) => later(s.checkedAt))) return r;
  const next = structuredClone(r);
  for (const [identity, sample] of Object.entries(next.last))
    if (later(sample.checkedAt)) delete next.last[identity];
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (const [identity, hours] of Object.entries(next.hours)) {
    for (const key of Object.keys(hours))
      if (Date.parse(key) > hour) delete hours[key];
    if (!Object.keys(hours).length) delete next.hours[identity];
  }
  // A sample sees only windows resetting within five hours after it.
  for (const [identity, windows] of Object.entries(next.windows)) {
    const kept = windows.filter(
      (w) => Date.parse(w.resetAt) - FIVE_HOURS_MS <= now,
    );
    if (kept.length) next.windows[identity] = kept;
    else delete next.windows[identity];
  }
  next.hits = next.hits.filter((hit) => !later(hit.at));
  for (const hit of next.hits)
    if (hit.until && later(hit.until)) delete hit.until;
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
  const hour = (hours[hourKey(t)] ??= emptyHour());
  const gap = prev ? t - Date.parse(prev.checkedAt) : Infinity;
  if (gap > 0 && gap <= MAX_USAGE_GAP_MS)
    addCoverage(hours, Date.parse(prev!.checkedAt), t);
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
    // Follow the latest reported reset so monotonic drift stays one window.
    record.resetAt = reset;
    const high = record.maxPercent;
    if (
      prev &&
      validWindow(prev) &&
      sameReset(prev.fiveHour!.resetsAt!, reset) &&
      gap > 0 &&
      gap <= MAX_USAGE_GAP_MS
    )
      hour.points = round2(hour.points + Math.max(0, pct - high));
    record.maxPercent = Math.max(high, pct);
  }
  foldHits(next, s, t);
  next.last[s.identity] = structuredClone(s);
}

/** Backfill: folds samples per identity in time order from empty rollups. */
export function foldSamples(
  samples: readonly UsageSample[],
  now: number,
): UsageRollups {
  return catchUp(emptyRollups(), samples, now);
}

/**
 * Folds every sample newer than its identity's last folded sample, in
 * identity and time order, into one clone (cloning per sample would be
 * quadratic) and prunes once. State stamped later than `now` is dropped
 * first. Returns `r` itself when nothing was dropped or folded.
 */
export function catchUp(
  r: UsageRollups,
  samples: readonly UsageSample[],
  now: number,
): UsageRollups {
  const base = withoutFuture(r, now);
  const pending = samples
    .filter((sample) => accepts(base, sample))
    .sort((a, b) =>
      a.identity === b.identity
        ? Date.parse(a.checkedAt) - Date.parse(b.checkedAt)
        : a.identity < b.identity
          ? -1
          : 1,
    );
  if (!pending.length) return base;
  const next = base === r ? structuredClone(r) : base;
  for (const sample of pending)
    if (accepts(next, sample)) foldInto(next, sample);
  prune(next, now);
  return next;
}
