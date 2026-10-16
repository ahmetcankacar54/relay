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
 * Records older than seven days are dropped when read. A file that cannot be read or unsealed
 * reads as empty. Changes run one at a time, so none is lost to another.
 */
export class DraftVault {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every record, newest first, with its text. Never throws. */
  list(): Promise<DraftRecord[]> {
    return this.serial(async () => {
      const { records, expired } = await this.load();
      // The text of an expired record does not stay on disk either.
      if (expired) await this.save(records).catch(() => {});
      return records;
    });
  }

  /** Keeps `drafts` for account `to`, each replacing an older one in its slot. */
  add(to: string, drafts: CapturedDraft[]): Promise<void> {
    return this.serial(async () => {
      const capturedAt = new Date(this.now()).toISOString();
      const slots = new Set<string>();
      const fresh: DraftRecord[] = [];
      for (const draft of drafts) {
        // Neither a conversation's nor the new-session draft: there is nowhere to re-type it.
        if (!draft.newSession && !draft.targetAlias) continue;
        const key = slot(to, draft.newSession ? undefined : draft.targetAlias);
        if (slots.has(key)) continue;
        slots.add(key);
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
      if (fresh.length === 0) return;
      const { records } = await this.load();
      const kept = records.filter(
        (record) => !slots.has(slot(record.to, record.targetAlias)),
      );
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

  /** The valid, unexpired records on disk, newest first; `expired` when any were dropped. */
  private async load(): Promise<{ records: DraftRecord[]; expired: boolean }> {
    let raw: unknown;
    try {
      const data = await readBytes(this.vault, FILE);
      if (!data) return { records: [], expired: false };
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
