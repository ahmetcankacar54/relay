import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DRAFT_EVENT_LIMIT,
  DRAFT_EVENT_STRING_LIMIT,
  appendDraftEvent,
  draftEventFilter,
  shortId,
} from "../electron/core/draft-diagnostics";

const START = Date.parse("2026-10-17T09:00:00Z");
const SECOND = 1000;

function directory(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-draft-events-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const readLog = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the log keeps a version and the entries it was given, each with its time and event", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  assert.equal(
    appendDraftEvent(
      file,
      { event: "capture", count: 2, status: "captured" },
      START,
    ),
    true,
  );
  appendDraftEvent(file, { event: "shown", matched: true }, START + SECOND);
  assert.deepEqual(readLog(file), {
    version: 1,
    entries: [
      {
        at: new Date(START).toISOString(),
        event: "capture",
        count: 2,
        status: "captured",
      },
      {
        at: new Date(START + SECOND).toISOString(),
        event: "shown",
        matched: true,
      },
    ],
  });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test("a logged entry holds no full account or org id, and older entries lose theirs on the next write", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  const from = "aaaaaaaa-1111-4111-8111-111111111111";
  const to = "bbbbbbbb-2222-4222-8222-222222222222";
  // An entry written before ids were cut.
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 1, entries: [{ at: new Date(START).toISOString(), event: "capture", from, to }] }),
  );
  appendDraftEvent(file, { event: "restore-start", account: to, records: 1 }, START + SECOND);
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, UUID);
  assert.deepEqual(readLog(file).entries, [
    { at: new Date(START).toISOString(), event: "capture", from: "aaaaaaaa", to: "bbbbbbbb" },
    { at: new Date(START + SECOND).toISOString(), event: "restore-start", account: "bbbbbbbb", records: 1 },
  ]);
});

test("the log is private to the owner, as the other Relay journals are", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  appendDraftEvent(file, { event: "capture" }, START);
  appendDraftEvent(file, { event: "capture" }, START + SECOND);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("the log keeps only the newest 300 entries", (t) => {
  assert.equal(DRAFT_EVENT_LIMIT, 300);
  const file = path.join(directory(t), "draft-events.json");
  for (let i = 0; i < DRAFT_EVENT_LIMIT + 25; i++)
    appendDraftEvent(file, { event: "tick", n: i }, START + i * SECOND);
  const { entries } = readLog(file);
  assert.equal(entries.length, DRAFT_EVENT_LIMIT);
  assert.equal(entries[0].n, 25);
  assert.equal(entries.at(-1).n, DRAFT_EVENT_LIMIT + 24);
});

test("only strings, numbers, booleans and null are kept", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  appendDraftEvent(
    file,
    {
      event: "mixed",
      s: "text",
      n: 3,
      b: false,
      nothing: null,
      missing: undefined,
      object: { nested: "value" },
      list: ["a", "b"],
      call: () => "x",
      big: 10n,
      symbol: Symbol("s"),
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
    },
    START,
  );
  assert.deepEqual(readLog(file).entries[0], {
    at: new Date(START).toISOString(),
    event: "mixed",
    s: "text",
    n: 3,
    b: false,
    nothing: null,
  });
});

test("a field named text is never written, whatever its case or value", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  const SECRET = "the words of an unsent draft";
  appendDraftEvent(
    file,
    { event: "write", text: SECRET, Text: SECRET, TEXT: SECRET, id: "abc" },
    START,
  );
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes(SECRET), false);
  assert.deepEqual(Object.keys(readLog(file).entries[0]).sort(), [
    "at",
    "event",
    "id",
  ]);
});

test("a field cannot replace the time or the event", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  appendDraftEvent(file, { event: "real", at: "yesterday" }, START);
  const [entry] = readLog(file).entries;
  assert.equal(entry.event, "real");
  assert.equal(entry.at, new Date(START).toISOString());
  // An entry without an event is no entry.
  assert.equal(appendDraftEvent(file, { id: "x" }, START), false);
  assert.equal(readLog(file).entries.length, 1);
});

test("strings, and the event itself, are cut to 200 characters", (t) => {
  assert.equal(DRAFT_EVENT_STRING_LIMIT, 200);
  const file = path.join(directory(t), "draft-events.json");
  appendDraftEvent(
    file,
    { event: "e".repeat(500), error: "x".repeat(500), short: "ok" },
    START,
  );
  const [entry] = readLog(file).entries;
  assert.equal(entry.event.length, 200);
  assert.equal(entry.error.length, 200);
  assert.equal(entry.short, "ok");
});

test("an entry has a bounded number of fields", (t) => {
  const file = path.join(directory(t), "draft-events.json");
  const many: Record<string, unknown> = { event: "many" };
  for (let i = 0; i < 100; i++) many[`k${i}`] = i;
  appendDraftEvent(file, many, START);
  // The time and the event, and at most 20 fields.
  assert.ok(Object.keys(readLog(file).entries[0]).length <= 22);
});

test("a missing, corrupt or wrongly shaped file starts over, and a write failure is swallowed", (t) => {
  const root = directory(t);
  const missing = path.join(root, "missing", "draft-events.json");
  // The directory does not exist: the write fails and nothing is thrown.
  assert.equal(appendDraftEvent(missing, { event: "capture" }, START), false);
  assert.equal(fs.existsSync(missing), false);
  for (const content of [
    "{not json",
    "",
    "[]",
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: "nope" }),
  ]) {
    const file = path.join(root, "draft-events.json");
    fs.writeFileSync(file, content);
    assert.equal(appendDraftEvent(file, { event: "fresh" }, START), true);
    assert.deepEqual(readLog(file).entries, [
      { at: new Date(START).toISOString(), event: "fresh" },
    ]);
  }
  // Entries that are not well formed are dropped, the rest are kept.
  const file = path.join(root, "partial.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      entries: [
        { at: "2026-10-16T00:00:00.000Z", event: "keep" },
        { at: 7, event: "bad" },
        { event: "no time" },
        null,
        "text",
      ],
    }),
  );
  appendDraftEvent(file, { event: "new" }, START);
  assert.deepEqual(
    readLog(file).entries.map((entry: any) => entry.event),
    ["keep", "new"],
  );
});

test("a file that is a link is never followed", (t) => {
  const root = directory(t);
  const target = path.join(root, "elsewhere.json");
  fs.writeFileSync(target, "outside");
  const file = path.join(root, "draft-events.json");
  fs.symlinkSync(target, file);
  assert.equal(appendDraftEvent(file, { event: "capture" }, START), false);
  assert.equal(fs.readFileSync(target, "utf8"), "outside");
});

test("an id is cut to its first 8 characters", () => {
  assert.equal(shortId("12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "12345678");
  assert.equal(shortId("abc"), "abc");
  assert.equal(shortId(undefined), null);
  assert.equal(shortId(""), null);
});

test("the repeat filter drops what a run that did nothing says again, and nothing else", () => {
  const allow = draftEventFilter();
  const wait = { account: "a", records: 1, ready: false };
  const end = { status: "waiting", restored: 0, left: 1, reason: null };
  // The first time, everything is kept.
  assert.equal(allow("restore-start", wait), true);
  assert.equal(allow("restore-end", end), true);
  assert.equal(allow("stalls", { giveUp: 0, reason: null }), true);
  // The same run again, with nothing in between, is not.
  assert.equal(allow("restore-start", wait), false);
  assert.equal(allow("restore-end", end), false);
  assert.equal(allow("stalls", { giveUp: 0, reason: null }), false);
  // A change is kept.
  assert.equal(allow("restore-start", { ...wait, ready: true }), true);
  assert.equal(allow("restore-end", { ...end, reason: "not-ready" }), true);
  assert.equal(allow("restore-start", { ...wait, ready: true }), false);
  // A draft skipped the same way on each 10 s run is said once too.
  const skip = { id: "x", visits: false, returnKnown: true, screen: "/new" };
  assert.equal(allow("record-start", { id: "x" }), true);
  assert.equal(allow("skip", skip), true);
  assert.equal(allow("restore-start", { ...wait, ready: true }), false);
  assert.equal(allow("record-start", { id: "x" }), false);
  assert.equal(allow("skip", skip), false);
  // Any other event is always kept, and makes the next run's start count again.
  assert.equal(allow("watch-start", { places: 1 }), true);
  assert.equal(allow("watch-start", { places: 1 }), true);
  assert.equal(allow("restore-start", { ...wait, ready: true }), true);
  assert.equal(allow("restore-end", { ...end, reason: "not-ready" }), true);
  // An accessibility retry that moved nothing is said once, too.
  assert.equal(allow("retry-accessibility", { moved: 0 }), true);
  assert.equal(allow("retry-accessibility", { moved: 0 }), false);
  assert.equal(allow("retry-accessibility", { moved: 2 }), true);
});

test("main logs draft events to draft-events.json in the user data folder", () => {
  const main = fs.readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /from "\.\/core\/draft-diagnostics"/);
  assert.match(
    main,
    /path\.join\(app\.getPath\("userData"\), "draft-events\.json"\)/,
  );
  assert.match(
    main,
    /function logDraftEvent\(\s*event: string,\s*fields\?: Record<string, unknown>/,
  );
  // The scheduler's restorer, the Desktop manager and the panel's actions all log through it.
  assert.match(main, /restorer: \{[\s\S]*?log: logDraftEvent,/);
  assert.match(main, /desktop\.onDraftEvent = logDraftEvent;/);
  assert.match(main, /draftActions\(\{[\s\S]*?log: logDraftEvent,/);
});
