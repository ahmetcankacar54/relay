import { randomUUID } from "node:crypto";
import { readBytes, writeBytes } from "./desktop-files";
import type { CapturedDraft } from "./drafts";

/** `pending` waits to be re-typed; `needs-copy` could not be and waits for the user. */
export type DraftState = "pending" | "needs-copy";

/** One captured draft, kept until it is re-typed or dismissed. Holds the text. */
export interface DraftRecord extends CapturedDraft {
  id: string;
  /** The account the draft is re-typed for. */
  to: string;
  capturedAt: string;
  state: DraftState;
  /** Why a `needs-copy` record could not be re-typed. */
  reason?: string;
}

/** What the panel may know of a record: never its text. */
export interface DraftSummary {
  id: string;
  to: string;
  title: string;
  newSession: boolean;
  attachments: boolean;
  state: DraftState;
  reason?: string;
  capturedAt: string;
}

/**
 * The slots a capture read for an account: its carried conversations, by alias, and the
 * new-session screen. A pending record in one of them that the capture did not fill is stale:
 * the account no longer has that draft, so it must not be re-typed.
 */
export interface DraftSlots {
  aliases: string[];
  newSession: boolean;
}

/** Inside the vault. Sealed, so the text is never on disk as it is. */
const FILE = "drafts/pending.bin";
const MAX_RECORDS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const STATES: readonly unknown[] = ["pending", "needs-copy"] satisfies DraftState[];

/** One slot per account and conversation, and one per account for the new-session draft. */
const slot = (to: string, targetAlias: string | undefined) =>
  JSON.stringify([to.toLowerCase(), targetAlias ?? null]);

/** A clean copy of `value` when it is a record the vault wrote, else undefined. */
function parseRecord(value: unknown): DraftRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const { id, to, capturedAt, state, reason, targetAlias, newSession } = raw;
  const { title, text, attachments } = raw;
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof to !== "string" ||
    to === "" ||
    typeof capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capturedAt)) ||
    !STATES.includes(state) ||
    (reason !== undefined && typeof reason !== "string") ||
    typeof title !== "string" ||
    typeof text !== "string" ||
    typeof attachments !== "boolean"
  )
    return undefined;
  // A conversation's draft has an alias; the new-session draft has none.
  if (
    newSession === true
      ? targetAlias !== undefined
      : newSession !== undefined ||
        typeof targetAlias !== "string" ||
        targetAlias === ""
  )
    return undefined;
  return {
    id,
    to,
    ...(newSession === true
      ? { newSession: true as const }
      : { targetAlias: targetAlias as string }),
    title,
    text,
    attachments,
    capturedAt,
    state: state as DraftState,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * The drafts captured at switches, sealed with `seal` in `<vault>/drafts/pending.bin`.
 *
 * It keeps at most 20 records, newest first, and only the newest per account and conversation.
 * Records older than seven days are dropped when read. A file that cannot be unsealed or
 * parsed reads as empty. A file that cannot be read at all fails every change, so a change
 * never overwrites records it could not see. Changes run one at a time, so none is lost to
 * another.
 */
export class DraftVault {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Every record, newest first, with its text. Never throws: when the file cannot be read it
   * answers with none, and leaves the file as it is.
   */
  list(): Promise<DraftRecord[]> {
    return this.serial(async () => {
      let loaded;
      try {
        loaded = await this.load();
      } catch {
        return [];
      }
      // The text of an expired record does not stay on disk either.
      if (loaded.expired) await this.save(loaded.records).catch(() => {});
      return loaded.records;
    });
  }

  /**
   * Keeps `drafts` for account `to`, each replacing an older one in its slot, whatever its
   * state. With `slots`, the slots the capture read, a pending record of `to` in one of them
   * that `drafts` does not fill is dropped too: the newest capture wins, even an empty one.
   */
  add(to: string, drafts: CapturedDraft[], slots?: DraftSlots): Promise<void> {
    return this.serial(async () => {
      const capturedAt = new Date(this.now()).toISOString();
      const filled = new Set<string>();
      const fresh: DraftRecord[] = [];
      for (const draft of drafts) {
        // Neither a conversation's nor the new-session draft: there is nowhere to re-type it.
        if (!draft.newSession && !draft.targetAlias) continue;
        const key = slot(to, draft.newSession ? undefined : draft.targetAlias);
        if (filled.has(key)) continue;
        filled.add(key);
        fresh.push({
          id: randomUUID(),
          to,
          ...(draft.newSession
            ? { newSession: true as const }
            : { targetAlias: draft.targetAlias }),
          title: draft.title,
          text: draft.text,
          attachments: draft.attachments,
          capturedAt,
          state: "pending",
        });
      }
      const read = new Set([
        ...(slots?.aliases ?? []).map((alias) => slot(to, alias)),
        ...(slots?.newSession ? [slot(to, undefined)] : []),
      ]);
      if (fresh.length === 0 && read.size === 0) return;
      const { records } = await this.load();
      const kept = records.filter((record) => {
        const key = slot(record.to, record.targetAlias);
        // A record waiting to be copied by hand is never re-typed, so it is not stale.
        return !filled.has(key) && !(record.state === "pending" && read.has(key));
      });
      if (fresh.length === 0 && kept.length === records.length) return;
      await this.save([...fresh, ...kept].slice(0, MAX_RECORDS));
    });
  }

  /** Changes a record's state or reason. A `reason` given as undefined is removed. */
  update(
    id: string,
    patch: Partial<Pick<DraftRecord, "state" | "reason">>,
  ): Promise<void> {
    return this.serial(async () => {
      const { records } = await this.load();
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) return;
      const next: DraftRecord = { ...records[index] };
      if (patch.state !== undefined) next.state = patch.state;
      if ("reason" in patch) {
        if (patch.reason === undefined) delete next.reason;
        else next.reason = patch.reason;
      }
      records[index] = next;
      await this.save(records);
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const { records } = await this.load();
      const left = records.filter((record) => record.id !== id);
      if (left.length !== records.length) await this.save(left);
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * The valid, unexpired records on disk, newest first; `expired` when any were dropped. A
   * missing file, or one that cannot be unsealed or parsed, holds none. Throws when the file
   * cannot be read at all: what it holds is then unknown, and must not be written over.
   */
  private async load(): Promise<{ records: DraftRecord[]; expired: boolean }> {
    // Throws on any failure but a missing file, a link included.
    const data = await readBytes(this.vault, FILE);
    if (!data) return { records: [], expired: false };
    let raw: unknown;
    try {
      raw = JSON.parse(this.unseal(data));
    } catch {
      return { records: [], expired: false };
    }
    if (!Array.isArray(raw)) return { records: [], expired: false };
    const now = this.now();
    let expired = false;
    const records: DraftRecord[] = [];
    for (const value of raw) {
      const record = parseRecord(value);
      if (!record) continue;
      if (now - Date.parse(record.capturedAt) > MAX_AGE_MS) expired = true;
      else records.push(record);
    }
    records.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return { records: records.slice(0, MAX_RECORDS), expired };
  }

  private async save(records: DraftRecord[]): Promise<void> {
    await writeBytes(
      this.vault,
      FILE,
      records.length ? this.seal(JSON.stringify(records)) : null,
    );
  }
}

export function summarize(record: DraftRecord): DraftSummary {
  return {
    id: record.id,
    to: record.to,
    title: record.title,
    newSession: record.newSession === true,
    attachments: record.attachments,
    state: record.state,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    capturedAt: record.capturedAt,
  };
}
