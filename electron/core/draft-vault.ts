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

/** Where a read of the vault went wrong: its file, its seal, or its JSON. */
export type DraftReadStage = "read" | "unseal" | "parse";

/**
 * Diagnosis hooks. Each is told only what it may log: a stage, a fixed label and indexes,
 * never a record's text or a message that could echo it. None may throw into the vault.
 */
export interface DraftVaultHooks {
  /**
   * The file could not be read, unsealed or parsed, or does not hold a list. Told once per
   * change: the same failure on the next read is not told again, and a read that works
   * starts it over.
   */
  onReadError?: (stage: DraftReadStage, message: string) => void;
  /** The entry at `index` of the list is not a record the vault wrote. Told once per change. */
  onRecordRejected?: (index: number) => void;
  /** `list()` answered with `count` records, when that differs from its last answer. */
  onList?: (count: number) => void;
}

/**
 * A fixed label for a failed read or unseal, never the error's own message: a message from
 * unsealing may carry a piece of the data (and one from parsing does, so a parse failure has
 * its own fixed label). An errno code, or a fixed word for a refusal of this code, tells what
 * happened.
 */
function readLabel(stage: "read" | "unseal", error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (stage === "unseal")
    return /encryption is unavailable/i.test(message)
      ? "encryption-unavailable"
      : "unseal-failed";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(code))
    return code;
  if (/symbolic links|Invalid Desktop path/.test(message)) return "unsafe-path";
  if (/Unsupported Desktop file/.test(message)) return "unsupported-file";
  return "read-failed";
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
    private readonly hooks: DraftVaultHooks = {},
  ) {}
  /** What the diagnosis hooks were last told, so an unchanged state is told once. */
  private told: { read?: string; rejected?: string; count?: number } = {};

  /** Runs a diagnosis hook; one that throws changes nothing about the vault. */
  private tell(fn: () => void): void {
    try {
      fn();
    } catch {
      // A diagnosis must never disturb the drafts.
    }
  }
  private readFailed(stage: DraftReadStage, message: string): void {
    const signature = `${stage}:${message}`;
    if (this.told.read === signature) return;
    this.told.read = signature;
    this.tell(() => this.hooks.onReadError?.(stage, message));
  }

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
        this.counted(0);
        return [];
      }
      // The text of an expired record does not stay on disk either.
      if (loaded.expired) await this.save(loaded.records).catch(() => {});
      this.counted(loaded.records.length);
      return loaded.records;
    });
  }

  private counted(count: number): void {
    if (this.told.count === count) return;
    this.told.count = count;
    this.tell(() => this.hooks.onList?.(count));
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
    let data: Buffer | null;
    try {
      data = await readBytes(this.vault, FILE);
    } catch (error) {
      this.readFailed("read", readLabel("read", error));
      throw error;
    }
    if (!data) {
      this.told.read = undefined;
      return { records: [], expired: false };
    }
    let sealed: string;
    try {
      sealed = this.unseal(data);
    } catch (error) {
      this.readFailed("unseal", readLabel("unseal", error));
      return { records: [], expired: false };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(sealed);
    } catch {
      this.readFailed("parse", "invalid-json");
      return { records: [], expired: false };
    }
    if (!Array.isArray(raw)) {
      this.readFailed("parse", "not-an-array");
      return { records: [], expired: false };
    }
    this.told.read = undefined;
    const now = this.now();
    let expired = false;
    const records: DraftRecord[] = [];
    const rejected: number[] = [];
    raw.forEach((value, index) => {
      const record = parseRecord(value);
      if (!record) rejected.push(index);
      else if (now - Date.parse(record.capturedAt) > MAX_AGE_MS) expired = true;
      else records.push(record);
    });
    this.rejected(rejected);
    records.sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return { records: records.slice(0, MAX_RECORDS), expired };
  }

  private rejected(indexes: number[]): void {
    const signature = indexes.join(",");
    if ((this.told.rejected ?? "") === signature) return;
    this.told.rejected = signature;
    for (const index of indexes)
      this.tell(() => this.hooks.onRecordRejected?.(index));
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
