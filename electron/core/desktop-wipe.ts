import fs from "node:fs/promises";
import path from "node:path";

/**
 * When Claude Desktop last finished its draft wipe, read from the LevelDB log of its live
 * Local Storage. claude.ai stamps `chat-draft-wipe-completed-at` (ms since the epoch) once it
 * has removed the drafts after an account change, about 2–6 s after Claude starts. Relay only
 * reads: no copy, no lock, nothing written, and no key but that one is looked at.
 */

/** The marker's LevelDB key: Chromium's `_<origin>\0\x01<key>`, the key in Latin-1. */
const WIPE_KEY = Buffer.from(
  "_https://claude.ai\u0000\u0001chat-draft-wipe-completed-at",
  "latin1",
);
/** A log larger than this is not Local Storage's write-ahead log as Relay knows it. */
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const BLOCK = 32 * 1024;
const HEADER = 7;
const FULL = 1;
const FIRST = 2;
const MIDDLE = 3;
const LAST = 4;
const PUT = 1;
const DELETE = 0;

/** A varint32 at `at`, and where the bytes after it start; undefined past the end. */
function varint(
  bytes: Buffer,
  at: number,
): { value: number; next: number } | undefined {
  let value = 0;
  for (
    let shift = 0, i = at;
    i < bytes.length && shift <= 28;
    shift += 7, i++
  ) {
    const byte = bytes[i];
    value |= (byte & 0x7f) << shift;
    if (byte < 0x80) return { value: value >>> 0, next: i + 1 };
  }
  return undefined;
}

/**
 * The records of a LevelDB log: 32 KiB blocks of chunks, each a 7-byte header (checksum,
 * length, type) and its bytes, a record split over blocks as FIRST, MIDDLE… and LAST. A torn
 * tail, as when Chromium is writing it, ends the list; a chunk out of order drops its record.
 */
function logRecords(log: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let parts: Buffer[] | undefined;
  let at = 0;
  while (at + HEADER <= log.length) {
    const left = BLOCK - (at % BLOCK);
    if (left < HEADER) {
      at += left;
      continue;
    }
    const length = log.readUInt16LE(at + 4);
    const type = log[at + 6];
    const start = at + HEADER;
    if (type === 0 && length === 0) {
      // Zero padding: the rest of the block is empty.
      at += left;
      continue;
    }
    if (start + length > log.length || HEADER + length > left) break;
    const chunk = log.subarray(start, start + length);
    at = start + length;
    if (type === FULL) {
      parts = undefined;
      records.push(chunk);
    } else if (type === FIRST) parts = [chunk];
    else if (type === MIDDLE && parts) parts.push(chunk);
    else if (type === LAST && parts) {
      parts.push(chunk);
      records.push(Buffer.concat(parts));
      parts = undefined;
    } else parts = undefined;
  }
  return records;
}

/** A Local Storage value as a string: 0x01 then Latin-1, or 0x00 then UTF-16LE. */
function storageString(value: Buffer): string | undefined {
  if (value[0] === 1) return value.subarray(1).toString("latin1");
  if (value[0] === 0 && value.length % 2 === 1)
    return value.subarray(1).toString("utf16le");
  return undefined;
}

/**
 * The marker's newest value in `log`, by sequence number, with its sequence: a write batch is
 * an 8-byte sequence, a 4-byte count, then puts (tag 1, key, value) and deletes (tag 0, key),
 * each entry one sequence number after the last. A delete newer than every put wins as
 * undefined. A batch that does not parse is skipped whole.
 */
export function wipeMarkerIn(
  log: Buffer,
): { at: number | undefined; sequence: number } | undefined {
  let newest: { at: number | undefined; sequence: number } | undefined;
  for (const batch of logRecords(log)) {
    if (batch.length < 12) continue;
    const first = Number(batch.readBigUInt64LE(0));
    const count = batch.readUInt32LE(8);
    const found: { at: number | undefined; sequence: number }[] = [];
    let at = 12;
    let ok = true;
    for (let n = 0; n < count; n++) {
      const tag = batch[at++];
      const key = varint(batch, at);
      if ((tag !== PUT && tag !== DELETE) || !key) {
        ok = false;
        break;
      }
      const keyEnd = key.next + key.value;
      if (keyEnd > batch.length) {
        ok = false;
        break;
      }
      const isMarker = batch.subarray(key.next, keyEnd).equals(WIPE_KEY);
      at = keyEnd;
      let value: Buffer | undefined;
      if (tag === PUT) {
        const length = varint(batch, at);
        if (!length || length.next + length.value > batch.length) {
          ok = false;
          break;
        }
        value = batch.subarray(length.next, length.next + length.value);
        at = length.next + length.value;
      }
      if (!isMarker) continue;
      const text = value && storageString(value);
      const stamp =
        text !== undefined && /^\d{1,16}$/.test(text)
          ? Number(text)
          : undefined;
      found.push({ at: stamp, sequence: first + n });
    }
    if (!ok) continue;
    for (const entry of found)
      if (!newest || entry.sequence > newest.sequence) newest = entry;
  }
  return newest;
}

/**
 * The newest `chat-draft-wipe-completed-at` in the `.log` files of `leveldb`, Claude's
 * `Local Storage/leveldb` folder; undefined when none holds it, as once LevelDB has moved it
 * into a table, or when the folder cannot be read. Never throws.
 */
export async function lastDraftWipeAt(
  leveldb: string,
): Promise<number | undefined> {
  let names: string[];
  try {
    names = (await fs.readdir(leveldb)).filter((name) =>
      /^\d+\.log$/.test(name),
    );
  } catch {
    return undefined;
  }
  let newest: { at: number | undefined; sequence: number } | undefined;
  for (const name of names) {
    try {
      const file = path.join(leveldb, name);
      if ((await fs.stat(file)).size > MAX_LOG_BYTES) continue;
      const marker = wipeMarkerIn(await fs.readFile(file));
      if (marker && (!newest || marker.sequence > newest.sequence))
        newest = marker;
    } catch {
      // A log LevelDB removed meanwhile, or one that cannot be read: the others still count.
    }
  }
  return newest?.at;
}
