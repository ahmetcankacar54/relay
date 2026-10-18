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
  private segments: ActiveSegment[];
  private lastObservedAt?: number;
  /** The last observation the file holds. */
  private savedObservedAt?: number;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    const loaded = load(file);
    this.segments = loaded.segments;
    this.lastObservedAt = this.savedObservedAt = loaded.lastObservedAt;
    const current = this.now();
    let changed = false;
    // A segment the last run left open ended with that run, a little after its last observation,
    // and never later than now.
    const open = this.open();
    if (open) {
      const last = this.lastObservedAt ?? (isoTime(open.from) as number);
      this.close(open, Math.min(last + ACTIVE_TIMELINE_GRACE_MS, current));
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
      this.close(open, this.lastObservedAt + ACTIVE_TIMELINE_GRACE_MS);
      open = undefined;
      changed = true;
    }
    const account = state.running ? state.currentAccountUuid : undefined;
    if (!account) {
      if (open) {
        this.close(open, now);
        changed = true;
      }
    } else if (!open || open.accountUuid !== account) {
      if (open) this.close(open, now);
      const orgs = state.organizations;
      this.segments.push({
        accountUuid: account,
        ...(orgs?.length === 1 ? { orgId: orgs[0] } : {}),
        from: new Date(now).toISOString(),
      });
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
    for (let index = this.segments.length - 1; index >= 0; index--) {
      const segment = this.segments[index];
      const from = isoTime(segment.from) as number;
      const to = segment.to === undefined ? Infinity : (isoTime(segment.to) as number);
      if (time >= from && time < to)
        return {
          accountUuid: segment.accountUuid,
          ...(segment.orgId === undefined ? {} : { orgId: segment.orgId }),
          exact: true,
        };
    }
    return undefined;
  }

  /** When the timeline began to know, the start of its first segment; before it nothing is known. */
  exactSince(): number | undefined {
    const first = this.segments[0];
    return first ? isoTime(first.from) : undefined;
  }

  private open(): ActiveSegment | undefined {
    const last = this.segments[this.segments.length - 1];
    return last && last.to === undefined ? last : undefined;
  }

  /** Ends `segment` at `at`, never before it began. */
  private close(segment: ActiveSegment, at: number) {
    segment.to = new Date(
      Math.max(at, isoTime(segment.from) as number),
    ).toISOString();
  }

  /** Drops segments that ended long ago and any beyond the newest few thousand; whether any went. */
  private prune(now: number): boolean {
    const cutoff = now - ACTIVE_TIMELINE_RETENTION_MS;
    const kept = this.segments
      .filter(
        (segment) =>
          segment.to === undefined || (isoTime(segment.to) as number) >= cutoff,
      )
      .slice(-ACTIVE_TIMELINE_MAX_SEGMENTS);
    const dropped = kept.length !== this.segments.length;
    this.segments = kept;
    return dropped;
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
