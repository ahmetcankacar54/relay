import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { lastDraftWipeAt, wipeMarkerIn } from "../electron/core/desktop-wipe";

const BLOCK = 32 * 1024;
const HEADER = 7;

/** Chromium's Local Storage key: `_<origin>\0\x01<key>`. */
const key = (name: string, origin = "https://claude.ai") =>
  Buffer.from(`_${origin}\u0000\u0001${name}`, "latin1");
const MARKER = "chat-draft-wipe-completed-at";
/** A Local Storage string: 0x01 then Latin-1, or 0x00 then UTF-16LE. */
const latin1 = (text: string) =>
  Buffer.concat([Buffer.from([1]), Buffer.from(text, "latin1")]);
const utf16 = (text: string) =>
  Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")]);

function varint(n: number): Buffer {
  const bytes: number[] = [];
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

/** A write batch: its first sequence, then puts (key and value) and deletes (key alone). */
function batch(sequence: number, entries: Array<[Buffer, Buffer?]>): Buffer {
  const head = Buffer.alloc(12);
  head.writeBigUInt64LE(BigInt(sequence), 0);
  head.writeUInt32LE(entries.length, 8);
  const parts: Buffer[] = [head];
  for (const [k, v] of entries) {
    parts.push(Buffer.from([v ? 1 : 0]), varint(k.length), k);
    if (v) parts.push(varint(v.length), v);
  }
  return Buffer.concat(parts);
}

/**
 * A LevelDB log of `records`, as LevelDB writes it: 32 KiB blocks, a record that does not fit
 * split into FIRST, MIDDLE… LAST chunks, and a block's last bytes too few for a header left
 * as zeros. The checksums are zero; the reader does not need them.
 */
function log(records: Buffer[]): Buffer {
  const out: Buffer[] = [];
  let offset = 0;
  for (const record of records) {
    let at = 0;
    let first = true;
    do {
      const left = BLOCK - (offset % BLOCK);
      if (left < HEADER) {
        out.push(Buffer.alloc(left));
        offset += left;
        continue;
      }
      const room = left - HEADER;
      const length = Math.min(room, record.length - at);
      const end = at + length === record.length;
      const type = first && end ? 1 : first ? 2 : end ? 4 : 3;
      const header = Buffer.alloc(HEADER);
      header.writeUInt16LE(length, 4);
      header[6] = type;
      out.push(header, record.subarray(at, at + length));
      offset += HEADER + length;
      at += length;
      first = false;
    } while (at < record.length);
  }
  return Buffer.concat(out);
}

test("the marker's value is read from a write batch, among other keys", () => {
  const bytes = log([
    batch(10, [
      [key("chat-draft-wipe-started-at"), latin1("1792400847552")],
      [key(MARKER), latin1("1792400847786")],
      [key("composer-draft:epitaxy-local_x"), latin1("never looked at")],
    ]),
  ]);
  assert.deepEqual(wipeMarkerIn(bytes), { at: 1792400847786, sequence: 11 });
  // A UTF-16 value reads the same.
  assert.equal(
    wipeMarkerIn(log([batch(3, [[key(MARKER), utf16("1792400847786")]])]))?.at,
    1792400847786,
  );
});

test("the newest write of the marker wins by sequence number, and a delete after it leaves none", () => {
  const two = log([
    batch(50, [[key(MARKER), latin1("2000")]]),
    batch(40, [[key(MARKER), latin1("1000")]]),
  ]);
  assert.equal(wipeMarkerIn(two)?.at, 2000);
  const deleted = log([
    batch(50, [[key(MARKER), latin1("2000")]]),
    batch(60, [[key(MARKER)]]),
  ]);
  assert.deepEqual(wipeMarkerIn(deleted), { at: undefined, sequence: 60 });
});

test("another origin, another key or no marker at all is no marker", () => {
  assert.equal(
    wipeMarkerIn(
      log([
        batch(1, [
          [key(MARKER, "https://example.com"), latin1("5")],
          [key("chat-draft-wipe-completed-id"), latin1("x@5")],
          [Buffer.from(MARKER, "latin1"), latin1("5")],
        ]),
      ]),
    ),
    undefined,
  );
  assert.equal(wipeMarkerIn(Buffer.alloc(0)), undefined);
});

test("a marker in a record split over blocks is found", () => {
  // A large value first, so the batch runs over two blocks and the marker sits in the second.
  const big = latin1("y".repeat(BLOCK + 500));
  const bytes = log([
    batch(7, [[key("LSS-something"), big]]),
    batch(9, [
      [key("filler"), latin1("z".repeat(BLOCK))],
      [key(MARKER), latin1("123456")],
    ]),
  ]);
  assert.ok(bytes.length > 2 * BLOCK);
  assert.deepEqual(wipeMarkerIn(bytes), { at: 123456, sequence: 10 });
});

test("a torn last record, a broken batch or a value that is no time is skipped", () => {
  const whole = log([batch(1, [[key(MARKER), latin1("1000")]])]);
  const torn = log([
    batch(1, [[key(MARKER), latin1("1000")]]),
    batch(2, [[key(MARKER), latin1("2000")]]),
  ]);
  // Chromium is still writing the second record.
  assert.equal(wipeMarkerIn(torn.subarray(0, torn.length - 3))?.at, 1000);
  // A batch claiming more entries than it holds is dropped whole.
  const broken = batch(5, [[key(MARKER), latin1("5000")]]);
  broken.writeUInt32LE(3, 8);
  assert.equal(wipeMarkerIn(log([broken])), undefined);
  assert.equal(
    wipeMarkerIn(log([batch(1, [[key(MARKER), latin1("1000")]]), broken]))?.at,
    1000,
  );
  // A value that is not a time counts as a write of no time.
  assert.deepEqual(
    wipeMarkerIn(log([batch(4, [[key(MARKER), latin1("soon")]])])),
    { at: undefined, sequence: 4 },
  );
  // Zero padding, as at the end of a block, is read past.
  assert.equal(
    wipeMarkerIn(Buffer.concat([whole, Buffer.alloc(BLOCK - whole.length)]))
      ?.at,
    1000,
  );
});

let scratch: string | undefined;
after(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

test("the folder's .log files are read, the newest marker of all wins, and nothing else counts", async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "relay-wipe-"));
  const leveldb = path.join(scratch, "leveldb");
  await mkdir(leveldb);
  assert.equal(await lastDraftWipeAt(leveldb), undefined);
  await writeFile(
    path.join(leveldb, "000010.log"),
    log([batch(100, [[key(MARKER), latin1("1000")]])]),
  );
  await writeFile(
    path.join(leveldb, "000012.log"),
    log([batch(200, [[key(MARKER), latin1("2000")]])]),
  );
  // A table, and a file that is not LevelDB's, are not read.
  await writeFile(
    path.join(leveldb, "000011.ldb"),
    log([batch(300, [[key(MARKER), latin1("3000")]])]),
  );
  await writeFile(
    path.join(leveldb, "notes.log"),
    log([batch(400, [[key(MARKER), latin1("4000")]])]),
  );
  assert.equal(await lastDraftWipeAt(leveldb), 2000);
  // No folder at all.
  assert.equal(await lastDraftWipeAt(path.join(scratch, "absent")), undefined);
});
