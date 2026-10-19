import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cliFixture } from "./cli-fixture";
import { localDate } from "../shared/planning";

const counts = (input: number, output = 0) => ({ input, output, cacheWrite: 0, cacheRead: 0, responses: 1 });

test("tokens shows the app's ledger for the range, marking estimated rows", async (t) => {
  const f = await cliFixture(t);
  const a = await f.saved("A");
  const b = await f.saved("B");
  const zone = f.store().state.settings.planning.timeZone;
  const today = localDate(Date.now(), zone);
  const yesterday = localDate(Date.now() - 86_400_000, zone);
  fs.writeFileSync(
    path.join(f.home, "token-ledger.json"),
    JSON.stringify({
      version: 2,
      zone,
      complete: true,
      files: { k1: { dev: 1, ino: 1, size: 100, offset: 100, mtimeMs: 1 } },
      days: {
        [today]: { [`acct:${a.id}`]: { "claude-x": counts(1000, 200) } },
        [yesterday]: { [`est:${b.id}`]: { "claude-x": counts(500) }, terminal: { "claude-x": counts(5) } },
      },
      seen: {},
    }),
    { mode: 0o600 },
  );
  const timeline = path.join(f.home, "active-account-timeline.json");
  const segments = { version: 1, segments: [{ accountUuid: a.desktop!.accountUuid, from: new Date(Date.now() - 3_600_000).toISOString() }] };
  fs.writeFileSync(timeline, JSON.stringify(segments), { mode: 0o600 });
  const before = fs.readFileSync(timeline, "utf8");
  const mtime = fs.statSync(timeline).mtimeMs;
  assert.equal(await f.run("tokens", "--days", "7", "--json"), 0);
  const view = JSON.parse(f.out());
  assert.equal(view.totals.input, 1505);
  assert.equal(view.totals.output, 200);
  const rowB = view.rows.find((r: any) => r.accountId === b.id);
  assert.equal(rowB.estimated, true);
  assert.equal(view.rows.find((r: any) => r.accountId === a.id).estimated, false);
  assert.equal(fs.readFileSync(timeline, "utf8"), before);
  assert.equal(fs.statSync(timeline).mtimeMs, mtime);
  f.clear();
  assert.equal(await f.run("tokens"), 0);
  assert.match(f.out(), /≈/);
  assert.match(f.out(), /Outside-Relay terminal/);
  f.clear();
  assert.equal(await f.run("tokens", "--account", "A", "--json"), 0);
  assert.equal(JSON.parse(f.out()).totals.input, 1000);
  assert.equal(await f.run("tokens", "--days", "5"), 2);
});

test("without a ledger it says Relay.app keeps one", async (t) => {
  const f = await cliFixture(t);
  assert.equal(await f.run("tokens"), 0);
  assert.match(f.out(), /Relay\.app/);
});

test("reading a small ledger does not allocate a buffer the size of the cap", async (t) => {
  const f = await cliFixture(t);
  fs.mkdirSync(f.home, { recursive: true });
  fs.writeFileSync(path.join(f.home, "token-ledger.json"), JSON.stringify({ version: 2, files: {}, days: {}, seen: {} }), { mode: 0o600 });
  const original = Buffer.alloc;
  let largest = 0;
  (Buffer as any).alloc = (size: number, ...rest: any[]) => {
    largest = Math.max(largest, size);
    return (original as any).call(Buffer, size, ...rest);
  };
  try {
    assert.equal(await f.run("tokens", "--json"), 0);
  } finally {
    (Buffer as any).alloc = original;
  }
  assert.ok(largest < 4 * 1024 * 1024, `allocated ${largest}`);
});
