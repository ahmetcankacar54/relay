import { readPrivateJson, writePrivateJson } from "./continuation-journal";

/** One stretch of time in which one account was open in Claude Desktop. Ids and times only. */
export interface ActiveSegment {
  accountUuid: string;
  orgId?: string;
  /** ISO time the account opened. */
  from: string;
  /** ISO time it closed; missing while it is still open. */
  to?: string;
}

/** The timeline keeps this many of the newest segments. */
export const ACTIVE_TIMELINE_MAX_SEGMENTS = 5_000;
/** A segment that ended longer ago than this is dropped. */
export const ACTIVE_TIMELINE_RETENTION_MS = 120 * 24 * 60 * 60_000;
/** Observations further apart than this mean Relay may have been closed in between. */
export const ACTIVE_TIMELINE_GAP_MS = 10 * 60_000;
/** A segment cut off by a gap or a restart ends this long after the last observation. */
export const ACTIVE_TIMELINE_GRACE_MS = 60_000;
/**
 * While a segment stays open the last observation is saved at most this often, as Desktop is
 * read every few seconds and every save is a synchronous, flushed write. It equals the grace, so
 * a segment cut off after a restart ends no earlier than the last real observation.
 */
const HEARTBEAT_MS = ACTIVE_TIMELINE_GRACE_MS;

function isoTime(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** The segments and the last observation in `file`; any trouble reading it gives an empty timeline. */
function load(file: string): {
  segments: ActiveSegment[];
  lastObservedAt?: number;
} {
  try {
    const value = readPrivateJson(file) as {
      version?: unknown;
      lastObservedAt?: unknown;
      segments?: unknown;
    } | null;
    if (value?.version !== 1 || !Array.isArray(value.segments))
      return { segments: [] };
    const segments: ActiveSegment[] = [];
    for (const entry of value.segments as unknown[]) {
      const item = entry as Partial<Record<keyof ActiveSegment, unknown>> | null;
      if (!item || typeof item !== "object") continue;
      if (typeof item.accountUuid !== "string" || !item.accountUuid) continue;
      if (item.orgId !== undefined && typeof item.orgId !== "string") continue;
      if (isoTime(item.from) === undefined) continue;
      if (item.to !== undefined && isoTime(item.to) === undefined) continue;
      segments.push({
        accountUuid: item.accountUuid,
        ...(item.orgId === undefined ? {} : { orgId: item.orgId }),
        from: item.from as string,
        ...(item.to === undefined ? {} : { to: item.to as string }),
      });
    }
    // Saved in order; sorted anyway, by start then end, so lookups can search them.
    const end = (segment: ActiveSegment) =>
      segment.to === undefined ? Infinity : (isoTime(segment.to) as number);
    segments.sort(
      (a, b) =>
        (isoTime(a.from) as number) - (isoTime(b.from) as number) ||
        end(a) - end(b),
    );
    // Only the newest segment can still be open: an older one ended when the next began.
    segments.forEach((segment, index) => {
      if (segment.to === undefined && index < segments.length - 1)
        segment.to = segments[index + 1].from;
    });
    return { segments, lastObservedAt: isoTime(value.lastObservedAt) };
  } catch {
    // Missing, unreadable or corrupt: start a new timeline rather than guess.
    return { segments: [] };
  }
}

/**
 * Which Claude Desktop account was open when, kept in a private file so the tokens Claude Code
 * logs can be told apart by account. A segment opens when Claude runs with a known account and
 * closes when the account changes, Claude stops or the account is unknown. Only ids and times
 * are stored. A failed save is swallowed: the timeline keeps working in memory and must never
 * disturb Desktop readings.
 */
export class ActiveAccountTimeline {
  /** Chronological, and by construction never overlapping. */
  private segments: ActiveSegment[];
  /** Each segment's start in epoch ms, in step with `segments`, for binary search. */
  private fromMs: number[] = [];
  /** Each segment's end in epoch ms; Infinity while it is open. */
  private toMs: number[] = [];
  private lastObservedAt?: number;
  /** The last observation the file holds. */
  private savedObservedAt?: number;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    const loaded = load(file);
    this.segments = loaded.segments;
    for (const segment of this.segments) this.times(segment);
    this.lastObservedAt = this.savedObservedAt = loaded.lastObservedAt;
    const current = this.now();
    let changed = false;
    // A segment the last run left open ended with that run, a little after its last observation,
    // and never later than now.
    if (this.open()) {
      const last = this.lastObservedAt ?? this.fromMs[this.fromMs.length - 1];
      this.closeOpen(Math.min(last + ACTIVE_TIMELINE_GRACE_MS, current));
      changed = true;
    }
    if (this.prune(current)) changed = true;
    if (changed) this.save();
  }

  /** Records what Desktop shows now; call it with every freshly read Desktop state. */
  observe(state: {
    running: boolean;
    currentAccountUuid?: string;
    organizations?: string[];
  }): void {
    // Never earlier than the last observation, so a clock that stepped back cannot reorder time.
    const now = Math.max(this.now(), this.lastObservedAt ?? 0);
    let changed = false;
    let open = this.open();
    if (
      open &&
      this.lastObservedAt !== undefined &&
      now - this.lastObservedAt > ACTIVE_TIMELINE_GAP_MS
    ) {
      // Relay may have been closed in between: the account is not known to have stayed open.
      this.closeOpen(this.lastObservedAt + ACTIVE_TIMELINE_GRACE_MS);
      open = undefined;
      changed = true;
    }
    const account = state.running ? state.currentAccountUuid : undefined;
    if (!account) {
      if (open) {
        this.closeOpen(now);
        changed = true;
      }
    } else if (!open || open.accountUuid !== account) {
      if (open) this.closeOpen(now);
      const orgs = state.organizations;
      const segment: ActiveSegment = {
        accountUuid: account,
        ...(orgs?.length === 1 ? { orgId: orgs[0] } : {}),
        from: new Date(now).toISOString(),
      };
      this.segments.push(segment);
      this.times(segment);
      changed = true;
    }
    this.lastObservedAt = now;
    if (changed) {
      this.prune(now);
      this.save();
    } else if (
      this.open() &&
      now - (this.savedObservedAt ?? 0) >= HEARTBEAT_MS
    )
      this.save();
  }

  /** The account open at `time` (epoch ms), if the timeline saw one then. */
  accountAt(
    time: number,
  ): { accountUuid: string; orgId?: string; exact: true } | undefined {
    const since = this.exactSince();
    if (since === undefined || !(time >= since)) return undefined;
    // The last segment that began at or before `time`; as segments do not overlap, only it can hold it.
    let low = 0;
    let high = this.fromMs.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.fromMs[middle] <= time) low = middle + 1;
      else high = middle;
    }
    const index = low - 1;
    if (!(time < this.toMs[index])) return undefined;
    const segment = this.segments[index];
    return {
      accountUuid: segment.accountUuid,
      ...(segment.orgId === undefined ? {} : { orgId: segment.orgId }),
      exact: true,
    };
  }

  /** When the timeline began to know, the start of its first segment; before it nothing is known. */
  exactSince(): number | undefined {
    return this.fromMs[0];
  }

  private open(): ActiveSegment | undefined {
    const last = this.segments[this.segments.length - 1];
    return last && last.to === undefined ? last : undefined;
  }

  /** Appends a segment's times, read from its own ISO strings so they match a reload. */
  private times(segment: ActiveSegment) {
    this.fromMs.push(isoTime(segment.from) as number);
    this.toMs.push(
      segment.to === undefined ? Infinity : (isoTime(segment.to) as number),
    );
  }

  /** Ends the open segment, the newest, at `at`, never before it began. */
  private closeOpen(at: number) {
    const index = this.segments.length - 1;
    const segment = this.segments[index];
    segment.to = new Date(Math.max(at, this.fromMs[index])).toISOString();
    this.toMs[index] = isoTime(segment.to) as number;
  }

  /** Drops segments that ended long ago and any beyond the newest few thousand; whether any went. */
  private prune(now: number): boolean {
    const cutoff = now - ACTIVE_TIMELINE_RETENTION_MS;
    const kept = this.segments
      .map((_, index) => index)
      .filter((index) => this.toMs[index] >= cutoff)
      .slice(-ACTIVE_TIMELINE_MAX_SEGMENTS);
    if (kept.length === this.segments.length) return false;
    this.segments = kept.map((index) => this.segments[index]);
    this.fromMs = kept.map((index) => this.fromMs[index]);
    this.toMs = kept.map((index) => this.toMs[index]);
    return true;
  }

  private save() {
    try {
      writePrivateJson(this.file, {
        version: 1,
        ...(this.lastObservedAt === undefined
          ? {}
          : { lastObservedAt: new Date(this.lastObservedAt).toISOString() }),
        segments: this.segments,
      });
      this.savedObservedAt = this.lastObservedAt;
    } catch {
      // The timeline is an aid to attribution; a failed save loses history, not Desktop readings.
    }
  }
}
