import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseDesktopTranscript } from "../electron/core/desktop-continuation-evidence";
import { TranscriptScanner } from "../electron/core/transcript-scan";

type Row = Record<string, any>;
const line = (row: unknown) => JSON.stringify(row) + "\n";
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-scan-test-"));
  return { root, file: path.join(root, "session.jsonl") };
}

/** What a full read and parse of the same file concludes. */
async function fullParse(file: string) {
  const data = await fs.readFile(file);
  const rows = parseDesktopTranscript(data);
  return {
    bytes: data.length,
    sha256: sha(data),
    cwds: new Set(
      rows
        .filter((row) => typeof row.cwd === "string")
        .map((row) => path.resolve(row.cwd)),
    ),
    last: rows
      .filter(
        (r: Row) =>
          !r.isSidechain && !r.isMeta && ["user", "assistant"].includes(r.type),
      )
      .at(-1),
  };
}

async function assertMatchesFullParse(
  scanner: TranscriptScanner,
  file: string,
) {
  const scanned = await scanner.scan(file);
  const expected = await fullParse(file);
  assert.equal(scanned.bytes, expected.bytes);
  assert.equal(scanned.sha256, expected.sha256);
  assert.deepEqual([...scanned.cwds].sort(), [...expected.cwds].sort());
  assert.deepEqual(scanned.last, expected.last);
}

const rows: Row[] = [
  {
    type: "user",
    uuid: "u1",
    cwd: "/work/app",
    message: { content: "Merhaba ğüşiöç" },
  },
  {
    type: "assistant",
    uuid: "a1",
    cwd: "/work/app/src",
    message: {
      content: [{ type: "text", text: "😀 ok" }],
      stop_reason: "end_turn",
    },
  },
  {
    type: "assistant",
    uuid: "s1",
    isSidechain: true,
    cwd: "/elsewhere",
    message: { content: "agent" },
  },
  { type: "user", uuid: "m1", isMeta: true, message: { content: "meta" } },
  { type: "summary", summary: "not a turn" },
];

test("an incremental scan matches a full parse after every append, across chunk and character boundaries", async () => {
  const { root, file } = await scratch();
  try {
    // Tiny chunks split rows and multi-byte characters between reads.
    const scanner = new TranscriptScanner({ chunkBytes: 7 });
    await fs.writeFile(file, rows.slice(0, 2).map(line).join(""));
    await assertMatchesFullParse(scanner, file);
    for (const row of rows.slice(2)) {
      const before = scanner.bytesRead;
      const size = (await fs.stat(file)).size;
      await fs.appendFile(file, line(row));
      await assertMatchesFullParse(scanner, file);
      // Only the appended row (and a few bytes proving the prefix) is read.
      assert.ok(
        scanner.bytesRead - before <= (await fs.stat(file)).size - size + 64,
      );
    }
    await fs.appendFile(file, "\n\n");
    await assertMatchesFullParse(scanner, file);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unchanged transcript is not read again", async () => {
  const { root, file } = await scratch();
  try {
    const scanner = new TranscriptScanner();
    await fs.writeFile(file, rows.map(line).join(""));
    const first = await scanner.scan(file);
    const read = scanner.bytesRead;
    assert.deepEqual(await scanner.scan(file), first);
    assert.equal(scanner.bytesRead, read);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a partial last line is incomplete until its newline arrives", async () => {
  const { root, file } = await scratch();
  try {
    const scanner = new TranscriptScanner();
    await fs.writeFile(file, line(rows[0]) + JSON.stringify(rows[1]));
    await assert.rejects(scanner.scan(file), /desktop-observation-incomplete/);
    await fs.appendFile(file, "\n");
    await assertMatchesFullParse(scanner, file);
    assert.equal((await scanner.scan(file)).last?.uuid, "a1");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a malformed, non-object or oversized line keeps the transcript unusable", async () => {
  for (const bad of ["{not json", "[1,2]", "42", "null", "x".repeat(80)]) {
    const { root, file } = await scratch();
    try {
      const scanner = new TranscriptScanner({ maxLineLength: 70 });
      await fs.writeFile(file, line(rows[0]) + bad + "\n");
      await assert.rejects(
        scanner.scan(file),
        /desktop-observation-incomplete/,
      );
      await fs.appendFile(file, line(rows[1]));
      await assert.rejects(
        scanner.scan(file),
        /desktop-observation-incomplete/,
      );
      await assert.rejects(
        new TranscriptScanner({ maxLineLength: 70 }).scan(file),
        /desktop-observation-incomplete/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("a rewritten or replaced transcript is scanned again from the start", async () => {
  const { root, file } = await scratch();
  try {
    const scanner = new TranscriptScanner();
    await fs.writeFile(file, rows.slice(0, 2).map(line).join(""));
    await scanner.scan(file);
    // Same file, new content that is at least as long.
    await fs.writeFile(
      file,
      line({ ...rows[0], cwd: "/rewritten" }) +
        line({ ...rows[1], uuid: "a2", cwd: "/rewritten" }) +
        line(rows[3]),
    );
    await assertMatchesFullParse(scanner, file);
    assert.equal((await scanner.scan(file)).last?.uuid, "a2");
    // Shorter content.
    await fs.writeFile(file, line(rows[0]));
    await assertMatchesFullParse(scanner, file);
    // A different file renamed into place.
    const replacement = path.join(root, "replacement.jsonl");
    await fs.writeFile(replacement, rows.map(line).join(""));
    await fs.rename(replacement, file);
    await assertMatchesFullParse(scanner, file);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("files over the size limit, empty files and non-files are handled like a full read", async () => {
  const { root, file } = await scratch();
  try {
    await fs.writeFile(file, rows.map(line).join(""));
    await assert.rejects(
      new TranscriptScanner({ maxBytes: 100 }).scan(file),
      /desktop-observation-incomplete/,
    );
    await fs.writeFile(file, "");
    const empty = await new TranscriptScanner().scan(file);
    assert.equal(empty.bytes, 0);
    assert.equal(empty.sha256, sha(Buffer.alloc(0)));
    assert.equal(empty.cwds.size, 0);
    assert.equal(empty.last, undefined);
    await assert.rejects(new TranscriptScanner().scan(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retain forgets transcripts that are no longer watched", async () => {
  const { root, file } = await scratch();
  try {
    const other = path.join(root, "other.jsonl");
    await fs.writeFile(file, rows.map(line).join(""));
    await fs.writeFile(other, rows.map(line).join(""));
    const scanner = new TranscriptScanner();
    await scanner.scan(file);
    await scanner.scan(other);
    scanner.retain(new Set([file]));
    let read = scanner.bytesRead;
    await scanner.scan(file);
    assert.equal(scanner.bytesRead, read);
    read = scanner.bytesRead;
    await scanner.scan(other);
    assert.equal(scanner.bytesRead - read, (await fs.stat(other)).size);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the row before trailing task notifications is kept until another row follows them", async () => {
  const { root, file } = await scratch();
  try {
    const notice = (uuid: string) => ({
      type: "user",
      uuid,
      origin: { kind: "task-notification" },
      message: { content: "<task-notification>\n</task-notification>" },
    });
    const stop = {
      type: "assistant",
      uuid: "q1",
      error: "rate_limit",
      message: { content: "limited" },
    };
    const scanner = new TranscriptScanner();
    await fs.writeFile(file, line(stop));
    assert.equal((await scanner.scan(file)).beforeNotifications, undefined);
    await fs.appendFile(file, line(notice("n1")));
    await fs.appendFile(file, line({ type: "user", isMeta: true }));
    await fs.appendFile(file, line(notice("n2")));
    const after = await scanner.scan(file);
    assert.equal(after.last?.uuid, "n2");
    assert.equal(after.beforeNotifications?.uuid, "q1");
    // A fresh scan of the whole file concludes the same.
    const fresh = await new TranscriptScanner().scan(file);
    assert.equal(fresh.beforeNotifications?.uuid, "q1");
    await fs.appendFile(
      file,
      line({ type: "user", uuid: "h1", message: { content: "go on" } }),
    );
    const prompted = await scanner.scan(file);
    assert.equal(prompted.last?.uuid, "h1");
    assert.equal(prompted.beforeNotifications, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
