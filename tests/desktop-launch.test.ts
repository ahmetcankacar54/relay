import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  START_MS,
  launchProgress,
  logSince,
  markLog,
  waitForPage,
  watchClaudeLaunch,
  type ClaudeLogFiles,
  type PageWaitDeps,
} from "../electron/core/desktop-launch";

const started = (at: string) => `${at} [info] Starting app {\n  appVersion: '3.6556.2',\n}\n`;
const loaded = (at: string) =>
  `${at} [info] Loaded https://claude.ai (web commit 292b68a8, desktop commit 20c019a1)\n`;
const other = (at: string) => `${at} [info] [growthbook] loaded 455 features (0 changed)\n`;

async function logDir(t: any): Promise<ClaudeLogFiles> {
  const dir = await mkdtemp(path.join(tmpdir(), "relay-claude-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { current: path.join(dir, "main.log"), rotated: path.join(dir, "main1.log") };
}

test("the last start in the log decides, and only a page report after it counts", () => {
  assert.equal(launchProgress(""), "none");
  assert.equal(launchProgress(other("10:00:01")), "none");
  assert.equal(launchProgress(started("09:59:19") + other("09:59:20")), "started");
  assert.equal(launchProgress(started("10:00:29") + loaded("10:00:31")), "loaded");
  // The earlier launch's page loaded; the one after it has not yet.
  assert.equal(
    launchProgress(started("09:00:00") + loaded("09:00:02") + started("09:59:19")),
    "started",
  );
  // Another origin's report counts; a line that only mentions the words does not.
  assert.equal(
    launchProgress(started("1") + "x [info] Loaded https://staging.claude.ai (web commit abc)\n"),
    "loaded",
  );
  assert.equal(launchProgress(started("1") + "x [info] Loaded https://claude.ai\n"), "started");
});

test("a log is marked only when its recent part shows the page report Relay reads", async (t) => {
  const files = await logDir(t);
  assert.equal(await markLog(files), undefined, "no log");
  await writeFile(files.current, started("1") + other("2"));
  assert.equal(await markLog(files), undefined, "a log without a page report");
  await appendFile(files.current, loaded("3"));
  const text = started("1") + other("2") + loaded("3");
  assert.equal(await markLog(files), Buffer.byteLength(text));
});

test("a log rotated just before the mark is read on into the file it went to", async (t) => {
  const files = await logDir(t);
  await writeFile(files.rotated, started("1") + loaded("2"));
  await writeFile(files.current, other("3"));
  assert.equal(await markLog(files), Buffer.byteLength(other("3")));
});

test("what was logged since the mark, also across a rotation", async (t) => {
  const files = await logDir(t);
  const before = started("1") + loaded("2");
  await writeFile(files.current, before);
  const offset = (await markLog(files))!;
  assert.equal(await logSince(files, offset), "");
  await appendFile(files.current, started("3"));
  assert.equal(await logSince(files, offset), started("3"));
  // Claude moved the full log to main1.log and went on in a new main.log.
  await writeFile(files.rotated, before + started("3") + other("4"));
  await writeFile(files.current, loaded("5"));
  assert.equal(await logSince(files, offset), started("3") + other("4") + loaded("5"));
});

/** A clock that moves only when the watch sleeps, and a log written on a schedule. */
function world(schedule: Array<[number, string]>, running: (now: number) => boolean | Error = () => true) {
  let now = 0;
  let runningChecks = 0;
  const deps: PageWaitDeps = {
    read: async () =>
      schedule
        .filter(([at]) => at <= now)
        .map(([, text]) => text)
        .join(""),
    running: async () => {
      runningChecks++;
      const value = running(now);
      if (value instanceof Error) throw value;
      return value;
    },
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
  };
  return { deps, now: () => now, runningChecks: () => runningChecks };
}

test("a page that reports its build ends the wait at once", async () => {
  const w = world([
    [1_000, started("a")],
    [4_000, loaded("b")],
  ]);
  assert.equal(await waitForPage(w.deps, 30_000), "loaded");
  assert.equal(w.now(), 4_000);
});

test("a Claude whose page never reports its build is stalled at the deadline", async () => {
  const w = world([[1_000, started("a")]]);
  assert.equal(await waitForPage(w.deps, 30_000), "stalled");
  assert.equal(w.now(), 30_000);
  // Checked every 5 s and at the deadline, never on every poll.
  assert.ok(w.runningChecks() <= 7, `${w.runningChecks()} checks`);
});

test("a Claude quit while its page is stuck is left closed", async () => {
  const w = world([[1_000, started("a")]], (now) => now < 7_000);
  assert.equal(await waitForPage(w.deps, 30_000), "closed");
  assert.ok(w.now() < 30_000);
});

test("no start in the log means the watch cannot tell, and it stops early", async () => {
  const w = world([[0, other("a")]]);
  assert.equal(await waitForPage(w.deps, 30_000), "unknown");
  assert.equal(w.now(), START_MS);
});

test("a process check that fails at the deadline never calls the page stalled", async () => {
  const w = world([[1_000, started("a")]], () => new Error("ps failed"));
  assert.equal(await waitForPage(w.deps, 30_000), "unknown");
});

test("a log that cannot be read counts as nothing new", async () => {
  const w = world([]);
  w.deps.read = async () => {
    throw new Error("EACCES");
  };
  assert.equal(await waitForPage(w.deps, 30_000), "unknown");
});

test("a watch reads only what Claude logged after it began", async (t) => {
  const files = await logDir(t);
  // The last launch before the watch loaded; the one Relay starts next must log its own.
  await writeFile(files.current, started("1") + loaded("2"));
  const watch = await watchClaudeLaunch(files, async () => true);
  assert.ok(watch);
  await appendFile(files.current, started("3") + loaded("4"));
  assert.equal(await watch.wait(30_000), "loaded");
  assert.equal(await watchClaudeLaunch(await logDir(t), async () => true), undefined);
});
