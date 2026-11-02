import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ACTIVE_TIMELINE_MAX_SEGMENTS,
  ACTIVE_TIMELINE_RETENTION_MS,
  ActiveAccountTimeline,
} from "../electron/core/active-account-timeline";
import { DESKTOP_CACHE_MS, DesktopManager, type DesktopHost } from "../electron/core/desktop";
import { Store } from "../electron/core/store";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const A = randomUUID();
const B = randomUUID();
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const iso = (ms: number) => new Date(ms).toISOString();

function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "active-account-timeline.json");
  const clock = { now: T0 };
  const open = () => new ActiveAccountTimeline(file, () => clock.now);
  const saved = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { dir, file, clock, open, saved };
}

test("an open, a switch and a close give the right segments and answers", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 5 * MINUTE;
  timeline.observe({ running: true, currentAccountUuid: B, organizations: [ORG_B] });
  f.clock.now = T0 + 9 * MINUTE;
  timeline.observe({ running: false, currentAccountUuid: B, organizations: [ORG_B] });
  assert.deepEqual(f.saved().segments, [
    { accountUuid: A, orgId: ORG_A, from: iso(T0), to: iso(T0 + 5 * MINUTE) },
    {
      accountUuid: B,
      orgId: ORG_B,
      from: iso(T0 + 5 * MINUTE),
      to: iso(T0 + 9 * MINUTE),
    },
  ]);
  assert.deepEqual(timeline.accountAt(T0 + MINUTE), {
    accountUuid: A,
    orgId: ORG_A,
    exact: true,
  });
  // A segment is from-inclusive and to-exclusive, so the switch instant belongs to the new one.
  assert.equal(timeline.accountAt(T0 + 5 * MINUTE)?.accountUuid, B);
  assert.equal(timeline.accountAt(T0 + 8 * MINUTE)?.accountUuid, B);
  assert.equal(timeline.accountAt(T0 + 9 * MINUTE), undefined);
  assert.equal(timeline.accountAt(T0 + 10 * MINUTE), undefined);
});

test("watching the same account again keeps one segment and writes nothing new", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  const state = { running: true, currentAccountUuid: A, organizations: [ORG_A] };
  timeline.observe(state);
  const written = fs.statSync(f.file).mtimeMs;
  f.clock.now = T0 + 30_000;
  timeline.observe(state);
  assert.equal(f.saved().segments.length, 1);
  assert.equal(fs.statSync(f.file).mtimeMs, written);
  // The open segment answers for any later time.
  assert.equal(timeline.accountAt(T0 + 3 * DAY)?.accountUuid, A);
});

test("an unknown account or a closed Claude closes the open segment", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + MINUTE;
  // Running, but nobody signed in.
  timeline.observe({ running: true, organizations: [] });
  assert.equal(f.saved().segments[0].to, iso(T0 + MINUTE));
  f.clock.now = T0 + 2 * MINUTE;
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 3 * MINUTE;
  timeline.observe({ running: false, currentAccountUuid: A, organizations: [ORG_A] });
  const segments = f.saved().segments;
  assert.equal(segments.length, 2);
  assert.equal(segments[1].to, iso(T0 + 3 * MINUTE));
  // Closed twice in a row adds nothing.
  f.clock.now = T0 + 4 * MINUTE;
  timeline.observe({ running: false, organizations: [] });
  assert.equal(f.saved().segments.length, 2);
});

test("the org is kept only when there is exactly one", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A, ORG_B] });
  f.clock.now = T0 + MINUTE;
  timeline.observe({ running: true, currentAccountUuid: B });
  f.clock.now = T0 + 2 * MINUTE;
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  const segments = f.saved().segments;
  assert.equal("orgId" in segments[0], false);
  assert.equal("orgId" in segments[1], false);
  assert.equal(segments[2].orgId, ORG_A);
  assert.equal(timeline.accountAt(T0 + 30_000)?.orgId, undefined);
});

test("more than 10 minutes between observations closes the segment a minute after the last one", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  const state = { running: true, currentAccountUuid: A, organizations: [ORG_A] };
  timeline.observe(state);
  f.clock.now = T0 + 4 * MINUTE;
  timeline.observe(state);
  // Exactly 10 minutes is not a gap.
  f.clock.now = T0 + 14 * MINUTE;
  timeline.observe(state);
  assert.equal(f.saved().segments.length, 1);
  assert.equal(f.saved().segments[0].to, undefined);
  // 10 minutes and a second is: Relay may have been closed in between.
  f.clock.now = T0 + 14 * MINUTE + 10 * MINUTE + 1_000;
  timeline.observe(state);
  assert.deepEqual(f.saved().segments, [
    { accountUuid: A, orgId: ORG_A, from: iso(T0), to: iso(T0 + 15 * MINUTE) },
    {
      accountUuid: A,
      orgId: ORG_A,
      from: iso(f.clock.now),
    },
  ]);
  assert.equal(timeline.accountAt(T0 + 20 * MINUTE), undefined);
  assert.equal(timeline.accountAt(f.clock.now)?.accountUuid, A);
});

test("a gap followed by a closed Claude leaves only the closed segment", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 3 * 60 * MINUTE;
  timeline.observe({ running: false, organizations: [] });
  assert.deepEqual(f.saved().segments, [
    { accountUuid: A, orgId: ORG_A, from: iso(T0), to: iso(T0 + MINUTE) },
  ]);
});

test("a restart closes the segment the last run left open, a minute after its last look", (t) => {
  const f = fixture(t);
  const first = f.open();
  first.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 20_000;
  first.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 2 * 60 * MINUTE;
  const second = f.open();
  assert.deepEqual(f.saved().segments, [
    { accountUuid: A, orgId: ORG_A, from: iso(T0), to: iso(T0 + MINUTE) },
  ]);
  assert.equal(second.exactSince(), T0);
  assert.equal(second.accountAt(T0 + 30_000)?.accountUuid, A);
  assert.equal(second.accountAt(T0 + 90_000), undefined);
  // The new run starts clean: the same account opens a segment of its own.
  second.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  assert.equal(f.saved().segments.length, 2);
  assert.equal(f.saved().segments[1].from, iso(f.clock.now));
});

test("the last look is saved while a segment stays open, so a restart closes near the real end", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  const state = { running: true, currentAccountUuid: A, organizations: [ORG_A] };
  timeline.observe(state);
  // Seen every few seconds: saved about once a minute, not at every look.
  for (let seconds = 5; seconds < 60; seconds += 5) {
    f.clock.now = T0 + seconds * 1_000;
    timeline.observe(state);
  }
  assert.equal(f.saved().lastObservedAt, iso(T0));
  f.clock.now = T0 + 5 * MINUTE;
  timeline.observe(state);
  assert.equal(f.saved().lastObservedAt, iso(T0 + 5 * MINUTE));
  f.clock.now = T0 + 5 * MINUTE + 30_000;
  timeline.observe(state);
  f.clock.now = T0 + 3 * 60 * MINUTE;
  const restarted = f.open();
  // Closed a minute after the last saved look, which is never before the last real one.
  assert.equal(f.saved().segments[0].to, iso(T0 + 6 * MINUTE));
  assert.equal(restarted.accountAt(T0 + 5 * MINUTE + 30_000)?.accountUuid, A);
  assert.equal(restarted.accountAt(T0 + 6 * MINUTE), undefined);
});

test("a restart a few seconds after the last look does not close a segment in the future", (t) => {
  const f = fixture(t);
  const first = f.open();
  first.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 + 10_000;
  f.open();
  assert.equal(f.saved().segments[0].to, iso(T0 + 10_000));
});

test("segments that ended over 120 days ago are dropped, and at most 5 000 stay", (t) => {
  const f = fixture(t);
  f.clock.now = T0 + 200 * DAY;
  const now = f.clock.now;
  const segment = (from: number, to?: number) => ({
    accountUuid: A,
    orgId: ORG_A,
    from: iso(from),
    ...(to === undefined ? {} : { to: iso(to) }),
  });
  fs.writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      segments: [
        segment(now - 200 * DAY, now - 130 * DAY),
        // Ended exactly 120 days ago: kept.
        segment(now - 125 * DAY, now - ACTIVE_TIMELINE_RETENTION_MS),
        segment(now - 121 * DAY, now - 120 * DAY - 1),
        segment(now - 10 * DAY, now - 9 * DAY),
      ],
    }),
  );
  const timeline = f.open();
  assert.deepEqual(
    f.saved().segments.map((s: { from: string }) => s.from),
    [iso(now - 125 * DAY), iso(now - 10 * DAY)],
  );
  assert.equal(timeline.exactSince(), now - 125 * DAY);

  // The newest 5 000 stay, and the file still fits the private file limit.
  const many = Array.from({ length: ACTIVE_TIMELINE_MAX_SEGMENTS + 100 }, (_, i) => ({
    accountUuid: randomUUID(),
    orgId: randomUUID(),
    from: iso(now - 100 * DAY + i * 1_000),
    to: iso(now - 100 * DAY + i * 1_000 + 500),
  }));
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, segments: many }));
  const capped = f.open();
  const kept = f.saved().segments;
  assert.equal(kept.length, ACTIVE_TIMELINE_MAX_SEGMENTS);
  assert.equal(kept[0].from, many[100].from);
  assert.equal(capped.exactSince(), Date.parse(many[100].from));
  assert.ok(fs.statSync(f.file).size < 1_048_576);
});

test("a corrupt or foreign file starts an empty timeline and is replaced on the next change", (t) => {
  for (const content of [
    "{not json",
    JSON.stringify({ version: 2, segments: [] }),
    JSON.stringify({ version: 1, segments: "x" }),
    JSON.stringify([1, 2, 3]),
    "",
  ]) {
    const f = fixture(t);
    fs.writeFileSync(f.file, content);
    const timeline = f.open();
    assert.equal(timeline.exactSince(), undefined);
    assert.equal(timeline.accountAt(T0), undefined);
    timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
    assert.equal(f.saved().segments.length, 1);
    assert.equal(timeline.exactSince(), T0);
  }
});

test("entries that are not segments are skipped, and only the last one may stay open", (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.file,
    JSON.stringify({
      version: 1,
      lastObservedAt: iso(T0 + 30 * MINUTE),
      segments: [
        { accountUuid: A, from: iso(T0), to: iso(T0 + MINUTE) },
        null,
        { accountUuid: 5, from: iso(T0) },
        { accountUuid: A, from: "yesterday" },
        { accountUuid: A, orgId: 7, from: iso(T0 + 2 * MINUTE) },
        // Left open, but another segment follows it: it ended when that one began.
        { accountUuid: A, from: iso(T0 + 10 * MINUTE) },
        { accountUuid: B, orgId: ORG_B, from: iso(T0 + 20 * MINUTE) },
      ],
    }),
  );
  f.clock.now = T0 + 5 * 60 * MINUTE;
  f.open();
  assert.deepEqual(f.saved().segments, [
    { accountUuid: A, from: iso(T0), to: iso(T0 + MINUTE) },
    { accountUuid: A, from: iso(T0 + 10 * MINUTE), to: iso(T0 + 20 * MINUTE) },
    {
      accountUuid: B,
      orgId: ORG_B,
      from: iso(T0 + 20 * MINUTE),
      to: iso(T0 + 31 * MINUTE),
    },
  ]);
});

test("the timeline file is private to the user", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  f.clock.now = T0 + MINUTE;
  timeline.observe({ running: false, organizations: [] });
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("nothing is known before the first segment began", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  assert.equal(timeline.exactSince(), undefined);
  assert.equal(timeline.accountAt(T0), undefined);
  f.clock.now = T0 + 10 * MINUTE;
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  assert.equal(timeline.exactSince(), T0 + 10 * MINUTE);
  assert.equal(timeline.accountAt(T0 + 10 * MINUTE - 1), undefined);
  assert.equal(timeline.accountAt(T0), undefined);
  assert.equal(timeline.accountAt(T0 + 10 * MINUTE)?.exact, true);
});

test("a clock that steps back never makes a segment end before it began", (t) => {
  const f = fixture(t);
  const timeline = f.open();
  timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] });
  f.clock.now = T0 - 5 * MINUTE;
  timeline.observe({ running: false, organizations: [] });
  const [segment] = f.saved().segments;
  assert.ok(Date.parse(segment.to) >= Date.parse(segment.from));
});

test("a timeline that cannot be saved keeps working in memory", (t) => {
  const f = fixture(t);
  const timeline = new ActiveAccountTimeline(
    path.join(f.dir, "missing-folder", "timeline.json"),
    () => f.clock.now,
  );
  assert.doesNotThrow(() =>
    timeline.observe({ running: true, currentAccountUuid: A, organizations: [ORG_A] }),
  );
  assert.equal(timeline.accountAt(T0)?.accountUuid, A);
});

/** A small deterministic generator, so a failure names its seed. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Segment {
  accountUuid: string;
  orgId?: string;
  from: string;
  to: string;
}

/** Closed segments one after another, some touching, some empty, from `start`. */
function chronological(next: () => number, count: number, start: number): Segment[] {
  const pick = (n: number) => Math.floor(next() * n);
  const segments: Segment[] = [];
  let at = start;
  for (let i = 0; i < count; i++) {
    const from = at + (pick(3) === 0 ? 0 : pick(30) * MINUTE + pick(1_000));
    const to = from + (pick(5) === 0 ? 0 : 1 + pick(60) * MINUTE);
    segments.push({
      accountUuid: [A, B][pick(2)],
      ...(pick(2) === 0 ? { orgId: ORG_A } : {}),
      from: iso(from),
      to: iso(to),
    });
    at = to;
  }
  return segments;
}

/** What the timeline answered before it kept times as numbers: every segment, newest first. */
function linearAccountAt(segments: Segment[], time: number) {
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (time >= Date.parse(segment.from) && time < Date.parse(segment.to))
      return {
        accountUuid: segment.accountUuid,
        ...(segment.orgId === undefined ? {} : { orgId: segment.orgId }),
        exact: true,
      };
  }
  return undefined;
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

test("lookups agree with a scan of every segment, on random timelines saved out of order", (t) => {
  for (let seed = 1; seed <= 25; seed++) {
    const f = fixture(t);
    const next = random(seed);
    const segments = chronological(next, 1 + Math.floor(next() * 150), T0);
    const first = Date.parse(segments[0].from);
    const last = Date.parse(segments[segments.length - 1].to);
    fs.writeFileSync(
      f.file,
      JSON.stringify({ version: 1, segments: shuffled(segments, next) }),
    );
    f.clock.now = last + MINUTE;
    const timeline = f.open();
    assert.equal(timeline.exactSince(), first, `seed ${seed}`);
    const times = [
      first - 1,
      ...segments.flatMap((s) => {
        const from = Date.parse(s.from);
        const to = Date.parse(s.to);
        return [from - 1, from, from + 1, to - 1, to, to + 1];
      }),
      ...Array.from({ length: 300 }, () => first - MINUTE + next() * (last - first + 2 * MINUTE)),
      NaN,
      Infinity,
      -Infinity,
    ];
    for (const time of times)
      assert.deepEqual(
        timeline.accountAt(time),
        linearAccountAt(segments, time),
        `seed ${seed}, time ${time}`,
      );
    // A segment opened after loading is found too, and closing it ends it.
    f.clock.now = last + 2 * MINUTE;
    timeline.observe({ running: true, currentAccountUuid: B, organizations: [ORG_B] });
    assert.equal(timeline.accountAt(last + 3 * MINUTE)?.accountUuid, B);
    f.clock.now = last + 4 * MINUTE;
    timeline.observe({ running: false, organizations: [] });
    assert.equal(timeline.accountAt(last + 3 * MINUTE)?.accountUuid, B);
    assert.equal(timeline.accountAt(last + 4 * MINUTE), undefined);
    assert.deepEqual(timeline.accountAt(last - 1), linearAccountAt(segments, last - 1));
  }
});

test("5 000 segments answer 10 000 lookups in under 50 ms", (t) => {
  const f = fixture(t);
  const next = random(7);
  const segments = chronological(next, ACTIVE_TIMELINE_MAX_SEGMENTS, T0);
  const first = Date.parse(segments[0].from);
  const last = Date.parse(segments[segments.length - 1].to);
  fs.writeFileSync(f.file, JSON.stringify({ version: 1, segments }));
  f.clock.now = last + MINUTE;
  const timeline = f.open();
  const times = Array.from({ length: 10_000 }, () => first + next() * (last - first));
  let found = 0;
  const started = performance.now();
  for (const time of times) if (timeline.accountAt(time)) found++;
  const elapsed = performance.now() - started;
  assert.ok(found > 0);
  assert.ok(elapsed < 50, `took ${elapsed} ms`);
  for (const time of times.slice(0, 200))
    assert.deepEqual(timeline.accountAt(time), linearAccountAt(segments, time));
});

/** A Desktop manager on empty files whose Claude runs as `running` says. */
async function desktop(t: { after(fn: () => unknown): void }, account?: string) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "relay-timeline-desktop-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "Claude");
  await fsp.mkdir(root);
  if (account) {
    await fsp.writeFile(
      path.join(root, "config.json"),
      JSON.stringify({
        lastKnownAccountUuid: account,
        "oauth:tokenCacheV2": "encrypted",
      }),
    );
    await fsp.mkdir(path.join(root, "claude-code-sessions", account, ORG_A), {
      recursive: true,
    });
  }
  const state = { running: true, deep: 0, seems: 0 };
  const host: DesktopHost = {
    available: async () => true,
    running: async () => {
      state.deep++;
      return state.running;
    },
    seemsRunning: async () => {
      state.seems++;
      return state.running;
    },
    quit: async () => {},
    launch: async () => {},
    seal: (s) => Buffer.from(s),
    unseal: (b) => b.toString(),
    draftScratchDir: path.join(temp, "tmp"),
  };
  const clock = { now: 1_000_000 };
  const manager = new DesktopManager(
    root,
    new Store(path.join(temp, "Relay")),
    host,
    path.join(temp, ".claude"),
    () => clock.now,
  );
  await manager.initialize();
  return { manager, clock, state, host };
}

test("Desktop tells onState about each fresh reading, never a cached one", async (t) => {
  const d = await desktop(t, A);
  const told: { running: boolean; account?: string; orgs: string[] }[] = [];
  d.manager.onState = (s) =>
    told.push({ running: s.running, account: s.currentAccountUuid, orgs: s.organizations });
  // Three observers sharing one reading are one fresh reading.
  await Promise.all([
    d.manager.cachedSnapshot(),
    d.manager.cachedSnapshot(),
    d.manager.cachedSnapshot(),
  ]);
  assert.deepEqual(told, [{ running: true, account: A, orgs: [ORG_A] }]);
  d.clock.now += DESKTOP_CACHE_MS - 1;
  await d.manager.cachedSnapshot();
  assert.equal(told.length, 1);
  d.clock.now += 1;
  d.state.running = false;
  await d.manager.cachedSnapshot();
  assert.equal(told.length, 2);
  assert.equal(told[1].running, false);
  // A decision always reads fresh, even right after a reading that is still shared.
  await d.manager.snapshot();
  await d.manager.snapshot();
  assert.equal(told.length, 4);
  // …and observers that follow it share that reading.
  await d.manager.cachedSnapshot();
  assert.equal(told.length, 4);
});

test("a failed Desktop reading tells nothing", async (t) => {
  const d = await desktop(t, A);
  let told = 0;
  d.manager.onState = () => told++;
  d.host.seemsRunning = async () => {
    throw new Error("The process list could not be read.");
  };
  await assert.rejects(d.manager.cachedSnapshot(), /process list/);
  assert.equal(told, 0);
});

test("a hook that throws does not break the snapshot", async (t) => {
  const d = await desktop(t, A);
  d.manager.onState = () => {
    throw new Error("timeline failed");
  };
  assert.equal((await d.manager.snapshot()).currentAccountUuid, A);
  d.clock.now += 5_000;
  assert.equal((await d.manager.cachedSnapshot()).currentAccountUuid, A);
});

test("the timeline sees Desktop through the manager: open, switch and close", async (t) => {
  const f = fixture(t);
  const timeline = f.open();
  const d = await desktop(t, A);
  d.manager.onState = (s) => timeline.observe(s);
  f.clock.now = T0;
  await d.manager.snapshot();
  assert.equal(timeline.accountAt(T0)?.accountUuid, A);
  assert.equal(timeline.accountAt(T0)?.orgId, ORG_A);
  f.clock.now = T0 + MINUTE;
  d.state.running = false;
  await d.manager.snapshot();
  assert.equal(timeline.accountAt(T0 + MINUTE), undefined);
  assert.equal(timeline.accountAt(T0 + 30_000)?.accountUuid, A);
});

test("main builds the timeline in the user data folder and feeds it from Desktop", () => {
  const main = fs.readFileSync(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  assert.match(main, /from "\.\/core\/active-account-timeline"/);
  assert.match(
    main,
    /new ActiveAccountTimeline\(\s*path\.join\(app\.getPath\("userData"\), "active-account-timeline\.json"\),?\s*\)/,
  );
  assert.match(main, /desktop\.onState = \(state\) => activeTimeline\.observe\(state\);/);
  // Set before Desktop is first read, so the first reading is not missed.
  const hook = main.indexOf("desktop.onState =");
  for (const read of ["desktop.snapshot()", "desktop.cachedSnapshot()"])
    assert.ok(hook < main.indexOf(read), `${read} is read after the hook is set`);
  assert.ok(hook < main.indexOf("await desktop.initialize()"));
});
