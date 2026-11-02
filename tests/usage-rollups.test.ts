import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLLUP_DAYS,
  catchUp,
  emptyRollups,
  foldSample,
  foldSamples,
  hourKey,
  type UsageRollups,
} from "../shared/usage-rollups";
import type { UsageSample } from "../shared/usage-statistics";

const minute = 60_000;
const day = 86_400_000;
// 07:50 UTC, so 5-minute steps cross into the 08:00 hour on the third sample.
const T0 = Date.parse("2026-10-13T07:50:00.000Z");
const iso = (m: number) => new Date(T0 + m * minute).toISOString();
const now = T0 + 10 * 60 * minute;

function s(
  identity: string,
  m: number,
  fivePct: number | undefined,
  resetMinutes: number,
  weekPct?: number,
  weekResetMinutes = 7 * 24 * 60,
): UsageSample {
  return {
    accountId: "a",
    identity,
    checkedAt: iso(m),
    ...(fivePct === undefined
      ? {}
      : { fiveHour: { usedPercent: fivePct, resetsAt: iso(resetMinutes) } }),
    ...(weekPct === undefined
      ? {}
      : {
          sevenDay: { usedPercent: weekPct, resetsAt: iso(weekResetMinutes) },
        }),
  };
}
function fold(samples: UsageSample[], at = now): UsageRollups {
  return samples.reduce(
    (r, sample) => foldSample(r, sample, at),
    emptyRollups(),
  );
}
const h = (m: number) => hourKey(T0 + m * minute);

test("hourKey is the UTC hour start", () => {
  assert.equal(ROLLUP_DAYS, 90);
  assert.equal(h(0), "2026-10-13T07:00:00.000Z");
  assert.equal(h(10), "2026-10-13T08:00:00.000Z");
  assert.deepEqual(emptyRollups(), {
    version: 2,
    hours: {},
    windows: {},
    hits: [],
    last: {},
  });
});

test("same window increases are attributed to the hour of the later sample", () => {
  const r = fold([s("x", 0, 10, 200), s("x", 5, 14, 200), s("x", 10, 20, 200)]);
  // 07:50 → 07:55 → 08:00: both gaps fall inside the 07:00 hour.
  assert.deepEqual(r.hours.x[h(0)], {
    points: 4,
    windows: 1,
    coveredMinutes: 10,
  });
  assert.deepEqual(r.hours.x[h(10)], {
    points: 6,
    windows: 0,
    coveredMinutes: 0,
  });
  const covered = Object.values(r.hours.x).reduce(
    (sum, hour) => sum + hour.coveredMinutes,
    0,
  );
  assert.equal(covered, 10);
  assert.deepEqual(r.windows.x, [{ resetAt: iso(200), maxPercent: 20 }]);
  assert.equal(r.last.x.checkedAt, iso(10));
});

test("a gap over 35 minutes makes the next sample a baseline", () => {
  const r = fold([s("x", 0, 10, 200), s("x", 40, 30, 200)]);
  const hours = Object.values(r.hours.x);
  assert.equal(
    hours.reduce((sum, v) => sum + v.points, 0),
    0,
  );
  assert.equal(
    hours.reduce((sum, v) => sum + v.coveredMinutes, 0),
    0,
  );
  assert.deepEqual(r.windows.x, [{ resetAt: iso(200), maxPercent: 30 }]);
});

test("coverage splits a gap across the UTC hours it spans", () => {
  // 23:50 → 00:15 is 10 minutes in one hour and 15 in the next.
  const at = (clock: string) => `2026-10-13T${clock}:00.000Z`;
  const poll = (checkedAt: string): UsageSample => ({
    accountId: "a",
    identity: "x",
    checkedAt,
    fiveHour: { usedPercent: 10, resetsAt: "2026-10-14T02:00:00.000Z" },
  });
  const r = fold(
    [poll(at("23:50")), { ...poll("2026-10-14T00:15:00.000Z") }],
    Date.parse("2026-10-14T01:00:00.000Z"),
  );
  assert.equal(r.hours.x[at("23:00")].coveredMinutes, 10);
  assert.equal(r.hours.x["2026-10-14T00:00:00.000Z"].coveredMinutes, 15);
});

test("coverage counts consecutive polls outside a valid window", () => {
  const r = fold([
    s("x", 0, undefined, 0, 10),
    s("x", 5, undefined, 0, 10),
    s("x", 15, 10, 200),
    s("x", 20, 12, 260),
    s("x", 70, 15, 260),
  ]);
  const hours = Object.values(r.hours.x);
  // 5 + 10 + 5 minutes; the 50-minute gap is not covered.
  assert.equal(
    hours.reduce((sum, v) => sum + v.coveredMinutes, 0),
    20,
  );
  // Points stay window-scoped: the window change is a baseline.
  assert.equal(
    hours.reduce((sum, v) => sum + v.points, 0),
    0,
  );
});

test("drops do not lower the high-water mark", () => {
  const r = fold([s("x", 0, 20, 200), s("x", 5, 15, 200), s("x", 10, 22, 200)]);
  assert.equal(r.hours.x[h(0)].points, 0);
  assert.equal(r.hours.x[h(10)].points, 2);
  assert.equal(r.windows.x[0].maxPercent, 22);
});

test("a new window is counted once and its first sample is a baseline", () => {
  const r = fold([
    s("x", 0, 10, 30),
    s("x", 25, 40, 30),
    s("x", 35, 5, 30 + 300),
    s("x", 40, 9, 30 + 300),
  ]);
  assert.deepEqual(r.windows.x, [
    { resetAt: iso(30), maxPercent: 40 },
    { resetAt: iso(330), maxPercent: 9 },
  ]);
  assert.equal(r.hours.x[h(0)].windows, 1);
  // 30 from the first window, 0 for the new window's baseline, then 4.
  assert.deepEqual(r.hours.x[h(25)], {
    points: 34,
    windows: 1,
    coveredMinutes: 30,
  });
});

test("resetsAt differing by 90 seconds is the same window", () => {
  const first = s("x", 0, 10, 200);
  const second = s("x", 5, 14, 200);
  second.fiveHour!.resetsAt = new Date(
    Date.parse(first.fiveHour!.resetsAt!) + 90_000,
  ).toISOString();
  const r = fold([first, second]);
  assert.equal(r.windows.x.length, 1);
  assert.equal(r.hours.x[h(0)].windows, 1);
  assert.equal(r.hours.x[h(0)].points, 4);
  assert.equal(r.windows.x[0].maxPercent, 14);
});

test("out-of-order or duplicate samples leave the rollups unchanged", () => {
  const r = fold([s("x", 0, 10, 200), s("x", 5, 14, 200)]);
  const copy = structuredClone(r);
  assert.deepEqual(foldSample(r, s("x", 5, 50, 200), now), copy);
  assert.deepEqual(foldSample(r, s("x", 1, 50, 200), now), copy);
  assert.deepEqual(r, copy);
});

test("foldSample does not mutate its input", () => {
  const r = fold([s("x", 0, 10, 200)]);
  const copy = structuredClone(r);
  const next = foldSample(r, s("x", 5, 14, 200), now);
  assert.deepEqual(r, copy);
  assert.notEqual(next, r);
});

test("limit hits open at 100 and close on a drop or at the window reset", () => {
  let r = fold([s("x", 0, 90, 200), s("x", 60, 100, 200)]);
  assert.deepEqual(r.hits, [
    { identity: "x", kind: "five-hour", at: iso(60), resetAt: iso(200) },
  ]);
  r = foldSample(r, s("x", 65, 100, 200), now);
  assert.equal(r.hits.length, 1);
  r = foldSample(r, s("x", 70, 95, 200), now);
  assert.deepEqual(r.hits, [
    {
      identity: "x",
      kind: "five-hour",
      at: iso(60),
      until: iso(70),
      resetAt: iso(200),
    },
  ]);

  // Weekly hit, then a sample past its reset while still at 100.
  const weekReset = 120;
  let w = fold([
    s("y", 0, 10, 200, 100, weekReset),
    s("y", 5, 10, 200, 100, weekReset),
  ]);
  assert.deepEqual(w.hits, [
    { identity: "y", kind: "weekly", at: iso(0), resetAt: iso(weekReset) },
  ]);
  w = foldSample(w, s("y", 130, 10, 200, 100, weekReset + 7 * 24 * 60), now);
  assert.deepEqual(w.hits[0], {
    identity: "y",
    kind: "weekly",
    at: iso(0),
    until: iso(weekReset),
    resetAt: iso(weekReset),
  });
  // The next week starts already exhausted: that is a new hit.
  assert.deepEqual(w.hits[1], {
    identity: "y",
    kind: "weekly",
    at: iso(130),
    resetAt: iso(weekReset + 7 * 24 * 60),
  });
});

test("records older than 90 days relative to now are pruned", () => {
  const r = fold([
    s("x", 0, 100, 200),
    s("x", 5, 100, 200),
    s("z", 0, 10, 200),
  ]);
  assert.ok(r.hours.x[h(0)]);
  const later = T0 + 90 * day + 6 * 60 * minute;
  const pruned = foldSample(
    r,
    s("z", 91 * 24 * 60, 10, 91 * 24 * 60 + 60),
    later,
  );
  assert.equal(pruned.hours.x?.[h(0)], undefined);
  assert.equal(pruned.hours.z[h(0)], undefined);
  assert.deepEqual(pruned.windows.x ?? [], []);
  assert.deepEqual(pruned.windows.z, [
    { resetAt: iso(91 * 24 * 60 + 60), maxPercent: 10 },
  ]);
  assert.deepEqual(pruned.hits, []);
  assert.ok(pruned.hours.z[h(91 * 24 * 60)]);
  assert.equal(pruned.last.x, undefined);
  assert.equal(pruned.last.z.checkedAt, iso(91 * 24 * 60));
});

test("monotonic reset drift within ±2 minutes per step stays one window", () => {
  const R = 200;
  const drift = (sample: UsageSample, seconds: number) => {
    sample.fiveHour!.resetsAt = new Date(
      T0 + R * minute + seconds * 1000,
    ).toISOString();
    return sample;
  };
  const r = fold([
    drift(s("x", 0, 10, R), 0),
    drift(s("x", 5, 20, R), 90),
    drift(s("x", 10, 30, R), 180),
    drift(s("x", 15, 40, R), 180),
  ]);
  const hours = Object.values(r.hours.x);
  assert.equal(
    hours.reduce((sum, v) => sum + v.points, 0),
    30,
  );
  assert.equal(
    hours.reduce((sum, v) => sum + v.windows, 0),
    1,
  );
  assert.equal(r.windows.x.length, 1);
  assert.equal(r.windows.x[0].maxPercent, 40);
});

test("an open hit closes at its reset even when the sample lacks that window", () => {
  let r = fold([s("x", 0, 90, 200), s("x", 60, 100, 200)]);
  r = foldSample(r, s("x", 210, undefined, 0, 50), now);
  assert.deepEqual(r.hits, [
    {
      identity: "x",
      kind: "five-hour",
      at: iso(60),
      until: iso(200),
      resetAt: iso(200),
    },
  ]);
});

test("catchUp folds only samples newer than each identity's last", () => {
  const all = [
    s("x", 0, 10, 200),
    s("x", 5, 14, 200),
    s("y", 1, 5, 200),
    s("x", 10, 20, 200),
    s("y", 6, 9, 200),
  ];
  const stale = foldSamples(all.slice(0, 2), now);
  assert.deepEqual(catchUp(stale, all, now), foldSamples(all, now));
  const current = foldSamples(all, now);
  assert.equal(catchUp(current, all, now), current);
  assert.deepEqual(stale, foldSamples(all.slice(0, 2), now));
});

test("foldSamples over shuffled input equals folding in order", () => {
  const ordered = [
    s("x", 0, 10, 200),
    s("x", 5, 14, 200, 50),
    s("x", 10, 20, 200, 100),
    s("x", 15, 18, 200, 99),
    s("x", 60, 40, 200),
    s("y", 2, 5, 230),
    s("y", 7, 25.55, 230),
    s("y", 12, 100, 230),
  ];
  const expected = ordered
    .slice()
    .sort((a, b) =>
      a.identity === b.identity
        ? Date.parse(a.checkedAt) - Date.parse(b.checkedAt)
        : a.identity < b.identity
          ? -1
          : 1,
    )
    .reduce((r, sample) => foldSample(r, sample, now), emptyRollups());
  const shuffled = [
    ordered[6],
    ordered[2],
    ordered[0],
    ordered[7],
    ordered[4],
    ordered[1],
    ordered[5],
    ordered[3],
  ];
  assert.deepEqual(foldSamples(shuffled, now), expected);
  assert.equal(expected.hours.y[h(0)].points, 20.55);
});

test("an open hit follows its window's drifting reset instead of reopening", () => {
  const R = T0 + 200 * minute;
  let r = fold([s("x", 0, 90, 200), s("x", 60, 100, 200)]);
  // 30 s after the stored reset, still full, the reset is reported 90 s later.
  const late = s("x", 200, 100, 200);
  late.checkedAt = new Date(R + 30_000).toISOString();
  late.fiveHour!.resetsAt = new Date(R + 120_000).toISOString();
  r = foldSample(r, late, now);
  assert.deepEqual(r.hits, [
    {
      identity: "x",
      kind: "five-hour",
      at: iso(60),
      resetAt: late.fiveHour!.resetsAt,
    },
  ]);
  assert.equal(r.windows.x.length, 1);
  // The next window closes the one hit at the drifted reset.
  r = foldSample(r, s("x", 205, 10, 500), now);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].until, late.fiveHour!.resetsAt);
});

test("last checks stamped later than now are clamped and nothing else changes", () => {
  // Folded while the clock ran ahead: minutes 120 and 180 are in the future
  // once the clock moves back to minute 30.
  const samples = [
    s("x", 0, 10, 200),
    s("x", 180, 100, 400),
    s("y", 0, 100, 200),
    s("y", 120, 50, 200),
  ];
  const r = fold(samples);
  const copy = structuredClone(r);
  const back = T0 + 30 * minute;
  const clamped = catchUp(r, [], back);
  assert.notEqual(clamped, r);
  assert.deepEqual(r, copy);
  // Hours, windows and hits stay, the future hit and the one it closed too.
  assert.deepEqual(clamped, {
    ...r,
    last: {
      x: { ...r.last.x, checkedAt: iso(30) },
      y: { ...r.last.y, checkedAt: iso(30) },
    },
  });
  // Samples up to the clamped check were folded already and are not replayed.
  assert.deepEqual(catchUp(r, [samples[0], samples[2]], back), clamped);
  assert.deepEqual(foldSample(r, s("x", 25, 20, 200), back), clamped);
  // Nothing in the future: catchUp keeps returning the same object.
  assert.equal(catchUp(clamped, [samples[0], samples[2]], back), clamped);
  // Samples after the clamped check are accepted again.
  const later = T0 + 40 * minute;
  assert.equal(
    catchUp(clamped, [s("x", 40, 20, 200)], later).last.x.checkedAt,
    iso(40),
  );
  assert.equal(
    foldSample(clamped, s("x", 40, 20, 200), later).last.x.checkedAt,
    iso(40),
  );
  // A kept window seen again is the same record: not counted twice.
  const again = foldSample(clamped, s("x", 200, 100, 400), T0 + 200 * minute);
  assert.deepEqual(again.windows.x, r.windows.x);
  assert.equal(
    Object.values(again.hours.x).reduce((sum, v) => sum + v.windows, 0),
    2,
  );
  assert.deepEqual(again.hits, r.hits);
});

test("coverage never credits an hour more than 60 minutes", () => {
  // 08:00 → 08:55 every 5 minutes, then the clock moves back to 08:53.
  const polls = Array.from({ length: 12 }, (_, i) =>
    s("x", 10 + 5 * i, 10, 300),
  );
  const r = fold(polls);
  assert.equal(r.hours.x[h(10)].coveredMinutes, 55);
  const clamped = catchUp(r, [], T0 + 63 * minute);
  // 08:53 → 08:59 overlaps the 08:53 → 08:55 already covered.
  const next = foldSample(clamped, s("x", 69, 10, 300), T0 + 69 * minute);
  assert.equal(next.last.x.checkedAt, iso(69));
  assert.equal(next.hours.x[h(10)].coveredMinutes, 60);
});

test("a hit closed by a sample before it opened ends where it began", () => {
  let r = fold([s("x", 0, 90, 200), s("x", 60, 100, 200)]);
  // The clock moves back to minute 30; the next sample is below 100.
  r = catchUp(r, [], T0 + 30 * minute);
  r = foldSample(r, s("x", 40, 50, 200), T0 + 40 * minute);
  assert.deepEqual(r.hits, [
    {
      identity: "x",
      kind: "five-hour",
      at: iso(60),
      until: iso(60),
      resetAt: iso(200),
    },
  ]);
});
