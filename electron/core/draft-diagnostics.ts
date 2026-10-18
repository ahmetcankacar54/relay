import { readPrivateJson, writePrivateJson } from "./continuation-journal";

/** The log keeps this many of the newest entries. */
export const DRAFT_EVENT_LIMIT = 300;
/** A string in an entry, and its event name, are cut to this many characters. */
export const DRAFT_EVENT_STRING_LIMIT = 200;
/** An entry keeps at most this many fields besides its time and event. */
const MAX_FIELDS = 20;

type Scalar = string | number | boolean | null;
export interface DraftEventEntry {
  /** ISO time of the event. */
  at: string;
  event: string;
  [field: string]: Scalar;
}

/** What the draft restore tells a diagnosis log: an event name and its plain fields. */
export type DraftLog = (
  event: string,
  fields?: Record<string, unknown>,
) => void;

/** Tells `log`, when there is one. A log that throws changes nothing about a restore. */
export function logDraft(
  log: DraftLog | undefined,
  event: string,
  fields?: Record<string, unknown>,
): void {
  try {
    log?.(event, fields);
  } catch {
    // The log is an aid, never a part of a restore.
  }
}

const cut = (value: string) => value.slice(0, DRAFT_EVENT_STRING_LIMIT);

/** The first 8 characters of an id, which tell two apart; null when there is none. */
export const shortId = (id: string | undefined): string | null =>
  id ? id.slice(0, 8) : null;

const FULL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A log entry with every field that is a full account or org id cut to its `shortId`. Callers
 * cut the ids they log; this also cuts ones an older Relay wrote, as the log is rewritten.
 */
export function withShortIds<T extends object>(entry: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry))
    out[key] =
      typeof value === "string" && FULL_ID.test(value) ? shortId(value) : value;
  return out as T;
}

/**
 * The fields worth keeping: only strings, numbers, booleans and null, strings cut. A field
 * named `text` is dropped whatever it holds, `at` and `event` are the entry's own, and objects
 * and lists are dropped whole rather than looked into, so nothing nested travels along.
 */
function scalarFields(fields: Record<string, unknown> | undefined) {
  const kept: Record<string, Scalar> = {};
  let count = 0;
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key === "at" || key === "event" || key.toLowerCase() === "text")
      continue;
    if (count >= MAX_FIELDS) break;
    if (typeof value === "string") kept[key] = cut(value);
    else if (typeof value === "boolean" || value === null) kept[key] = value;
    else if (typeof value === "number" && Number.isFinite(value))
      kept[key] = value;
    else continue;
    count++;
  }
  return kept;
}

/**
 * An error or reason for the log. A message that quotes data, as a JSON parse error quotes
 * the text it could not parse, is replaced by a fixed word; any other is kept as it is.
 */
export function safeMessage(message: string): string {
  return /JSON|Unexpected (?:token|end|non-whitespace)|at position \d+/i.test(
    message,
  )
    ? "parse-error"
    : message;
}

function entriesIn(file: string): DraftEventEntry[] {
  try {
    const value = readPrivateJson(file) as {
      version?: unknown;
      entries?: unknown;
    } | null;
    if (value?.version !== 1 || !Array.isArray(value.entries)) return [];
    return value.entries.filter(
      (entry): entry is DraftEventEntry =>
        !!entry &&
        typeof entry.at === "string" &&
        typeof entry.event === "string",
    );
  } catch {
    // Missing, unreadable or corrupt: start a new log rather than lose the event.
    return [];
  }
}

/**
 * Append one event of the draft restore to the private diagnosis log, keeping the newest
 * {@link DRAFT_EVENT_LIMIT}. `entry.event` names it; its other fields are kept only when they
 * are strings (cut to 200 characters), numbers, booleans or null, and never one named `text`.
 * Callers pass ids, states, reasons, counts and times, never a draft's text. A failed write is
 * swallowed: the log is a diagnostic aid and must never disturb a restore. Returns whether it
 * saved.
 */
export function appendDraftEvent(
  file: string,
  entry: Record<string, unknown>,
  now: number,
): boolean {
  try {
    if (typeof entry.event !== "string" || !entry.event) return false;
    const next: DraftEventEntry = {
      at: new Date(now).toISOString(),
      event: cut(entry.event),
      ...scalarFields(entry),
    };
    const entries = [...entriesIn(file), next]
      .slice(-DRAFT_EVENT_LIMIT)
      .map(withShortIds);
    writePrivateJson(file, { version: 1, entries });
    return true;
  } catch {
    return false;
  }
}

/**
 * Events that say the same thing on every 10 s run that does nothing, as while Claude is
 * closed. The log keeps 300 entries, so such a run is said once, until something else happens.
 */
const REPEATED = new Set([
  "restore-start",
  "restore-end",
  "stalls",
  "retry-accessibility",
]);

/**
 * A filter that says whether an event is worth logging: every event is, but one of REPEATED
 * that is the same as the last of its kind with nothing else logged since. Keep one per log.
 */
export function draftEventFilter(): (
  event: string,
  fields?: Record<string, unknown>,
) => boolean {
  const last = new Map<string, string>();
  let quiet = false;
  return (event, fields) => {
    if (!REPEATED.has(event)) {
      last.clear();
      quiet = false;
      return true;
    }
    const signature = JSON.stringify(scalarFields(fields));
    const same = quiet && last.get(event) === signature;
    last.set(event, signature);
    quiet = true;
    return !same;
  };
}
