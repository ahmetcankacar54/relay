import test from "node:test";
import assert from "node:assert/strict";
import {
  attribute,
  estimateAccountAt,
  indexSamples,
} from "../electron/core/token-attribution";
import { MAX_USAGE_GAP_MS, type UsageSample } from "../shared/usage-statistics";
import type { Account } from "../shared/types";

const T0 = Date.parse("2026-10-18T10:00:00Z");
const MIN = 60_000;
const iso = (t: number) => new Date(t).toISOString();

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function account(id: string, accountUuid?: string, orgId = ""): Account {
  return {
    id,
    name: id,
    kind: "personal",
    group: "",
    color: "",
    createdAt: iso(T0),
    ...(accountUuid
      ? { desktop: { accountUuid, orgId, savedAt: iso(T0) } }
      : {}),
  };
}

function sample(
  accountId: string,
  at: number,
  usedPercent: number,
  resetsAt?: number,
): UsageSample {
  return {
    accountId,
    identity: JSON.stringify(["uuid", `uuid-${accountId}`, "org"]),
    checkedAt: iso(at),
    fiveHour: {
      usedPercent,
      ...(resetsAt === undefined ? {} : { resetsAt: iso(resetsAt) }),
    },
  };
}

const accounts = [account("a", UUID_A, ORG_A), account("b", UUID_B, ORG_B)];
const noTimeline = { accountAt: () => undefined };
const timelineOf =
  (uuid: string, orgId?: string) =>
  (): { accountUuid: string; orgId?: string } => ({
    accountUuid: uuid,
    ...(orgId ? { orgId } : {}),
  });

test("a profile account id wins over the entrypoint, the timeline and the samples", () => {
  const result = attribute(
    { time: T0 + 2 * MIN, entrypoint: "cli", profileAccountId: "p" },
    {
      timeline: { accountAt: timelineOf(UUID_A, ORG_A) },
      samples: [sample("b", T0, 10), sample("b", T0 + 5 * MIN, 30)],
      accounts,
    },
  );
  assert.deepEqual(result, {
    kind: "account",
    accountId: "p",
    estimated: false,
  });
});

test("a terminal row while Claude runs on account A is terminal", () => {
  const result = attribute(
    { time: T0, entrypoint: "cli" },
    {
      timeline: { accountAt: timelineOf(UUID_A, ORG_A) },
      samples: [],
      accounts,
    },
  );
  assert.deepEqual(result, { kind: "terminal" });
});

test("the claude-desktop entrypoint is not terminal", () => {
  const result = attribute(
    { time: T0, entrypoint: "claude-desktop" },
    {
      timeline: { accountAt: timelineOf(UUID_A, ORG_A) },
      samples: [],
      accounts,
    },
  );
  assert.deepEqual(result, {
    kind: "account",
    accountId: "a",
    estimated: false,
  });
});

test("the timeline's account maps to the Relay account id", () => {
  const result = attribute(
    { time: T0 },
    {
      timeline: { accountAt: timelineOf(UUID_B, ORG_B) },
      samples: [],
      accounts,
    },
  );
  assert.deepEqual(result, {
    kind: "account",
    accountId: "b",
    estimated: false,
  });
});

test("the timeline match is case-insensitive and ignores an unknown organization", () => {
  const upper = attribute(
    { time: T0 },
    {
      timeline: {
        accountAt: timelineOf(UUID_A.toUpperCase(), ORG_A.toUpperCase()),
      },
      samples: [],
      accounts,
    },
  );
  assert.deepEqual(upper, {
    kind: "account",
    accountId: "a",
    estimated: false,
  });
  const noOrg = attribute(
    { time: T0 },
    { timeline: { accountAt: timelineOf(UUID_B) }, samples: [], accounts },
  );
  assert.deepEqual(noOrg, {
    kind: "account",
    accountId: "b",
    estimated: false,
  });
});

test("a matching account uuid in another organization does not match", () => {
  const result = attribute(
    { time: T0 },
    {
      timeline: { accountAt: timelineOf(UUID_A, ORG_B) },
      samples: [],
      accounts,
    },
  );
  assert.deepEqual(result, { kind: "unknown" });
});

test("a timeline account Relay does not know is unknown, not estimated", () => {
  const result = attribute(
    { time: T0 + MIN },
    {
      timeline: {
        accountAt: timelineOf("99999999-9999-4999-8999-999999999999"),
      },
      samples: [sample("a", T0, 10), sample("a", T0 + 5 * MIN, 30)],
      accounts,
    },
  );
  assert.deepEqual(result, { kind: "unknown" });
});

test("without a timeline reading the limit samples estimate the account", () => {
  const result = attribute(
    { time: T0 + MIN },
    {
      timeline: noTimeline,
      samples: [sample("a", T0, 10), sample("a", T0 + 5 * MIN, 30)],
      accounts,
    },
  );
  assert.deepEqual(result, {
    kind: "account",
    accountId: "a",
    estimated: true,
  });
});

test("with no timeline reading and no estimate the row is unknown", () => {
  const result = attribute(
    { time: T0 + MIN },
    { timeline: noTimeline, samples: [], accounts },
  );
  assert.deepEqual(result, { kind: "unknown" });
});

test("the account with the largest rise wins", () => {
  const samples = [
    sample("a", T0, 10),
    sample("a", T0 + 5 * MIN, 14),
    sample("b", T0, 40),
    sample("b", T0 + 5 * MIN, 55),
  ];
  assert.equal(estimateAccountAt(T0 + 2 * MIN, samples), "b");
});

test("only the pair that brackets the time counts", () => {
  const samples = [
    sample("a", T0, 10),
    sample("a", T0 + 5 * MIN, 60),
    sample("a", T0 + 10 * MIN, 61),
    sample("b", T0, 10),
    sample("b", T0 + 5 * MIN, 12),
    sample("b", T0 + 10 * MIN, 30),
  ];
  assert.equal(estimateAccountAt(T0 + 7 * MIN, samples), "b");
  assert.equal(estimateAccountAt(T0 + 2 * MIN, samples), "a");
});

test("samples are sorted by time before pairing", () => {
  const samples = [sample("a", T0 + 5 * MIN, 30), sample("a", T0, 10)];
  assert.equal(estimateAccountAt(T0 + MIN, samples), "a");
});

test("a reset between two samples counts the rise from zero", () => {
  const samples = [
    // Window reset: 90% -> 8% on a new window ending 5h later.
    sample("a", T0, 90, T0 + MIN),
    sample("a", T0 + 5 * MIN, 8, T0 + MIN + 5 * 60 * MIN),
    // Smaller honest rise on the other account.
    sample("b", T0, 10),
    sample("b", T0 + 5 * MIN, 15),
  ];
  assert.equal(estimateAccountAt(T0 + 2 * MIN, samples), "a");
});

test("a lower percent without a resetsAt still counts as a reset", () => {
  const samples = [sample("a", T0, 70), sample("a", T0 + 5 * MIN, 6)];
  assert.equal(estimateAccountAt(T0 + MIN, samples), "a");
});

test("a later resetsAt by at least an hour counts as a reset even when the percent is higher", () => {
  const samples = [
    sample("a", T0, 5, T0 + MIN),
    sample("a", T0 + 5 * MIN, 9, T0 + MIN + 60 * MIN),
    sample("b", T0, 10),
    sample("b", T0 + 5 * MIN, 17),
  ];
  // a: reset, so the rise is 9; b: rise 7.
  assert.equal(estimateAccountAt(T0 + MIN, samples), "a");
  const smallShift = [
    sample("a", T0, 5, T0 + MIN),
    sample("a", T0 + 5 * MIN, 9, T0 + MIN + 59 * MIN),
    sample("b", T0, 10),
    sample("b", T0 + 5 * MIN, 17),
  ];
  // a: not a reset, rise 4; b: rise 7.
  assert.equal(estimateAccountAt(T0 + MIN, smallShift), "b");
});

test("a gap over 35 minutes gives no estimate", () => {
  const samples = [
    sample("a", T0, 10),
    sample("a", T0 + MAX_USAGE_GAP_MS + MIN, 60),
  ];
  assert.equal(estimateAccountAt(T0 + 10 * MIN, samples), undefined);
});

test("a gap of exactly 35 minutes still estimates", () => {
  const samples = [sample("a", T0, 10), sample("a", T0 + MAX_USAGE_GAP_MS, 60)];
  assert.equal(estimateAccountAt(T0 + 10 * MIN, samples), "a");
});

test("no rise gives undefined", () => {
  const samples = [
    sample("a", T0, 20),
    sample("a", T0 + 5 * MIN, 20),
    sample("b", T0, 30),
    sample("b", T0 + 5 * MIN, 30),
  ];
  assert.equal(estimateAccountAt(T0 + MIN, samples), undefined);
});

test("a time outside every pair gives undefined", () => {
  const samples = [sample("a", T0, 10), sample("a", T0 + 5 * MIN, 30)];
  assert.equal(estimateAccountAt(T0 - MIN, samples), undefined);
  assert.equal(estimateAccountAt(T0 + 5 * MIN, samples), undefined);
  assert.equal(estimateAccountAt(T0 + 6 * MIN, samples), undefined);
});

test("samples without a five-hour window or with a bad timestamp are skipped", () => {
  const noWindow: UsageSample = {
    accountId: "a",
    identity: "x",
    checkedAt: iso(T0 + 5 * MIN),
  };
  const bad: UsageSample = { ...sample("a", T0, 10), checkedAt: "not a date" };
  assert.equal(
    estimateAccountAt(T0 + MIN, [sample("a", T0, 10), noWindow]),
    undefined,
  );
  assert.equal(
    estimateAccountAt(T0 + MIN, [bad, sample("a", T0 + 5 * MIN, 30)]),
    undefined,
  );
});

test("the estimate does not mutate its input", () => {
  const samples = [sample("a", T0 + 5 * MIN, 30), sample("a", T0, 10)];
  const before = JSON.stringify(samples);
  estimateAccountAt(T0 + MIN, samples);
  assert.equal(JSON.stringify(samples), before);
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

test("the indexed estimate agrees with the plain one on random samples", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const next = random(seed);
    const pick = (n: number) => Math.floor(next() * n);
    const samples: UsageSample[] = [];
    for (let i = 0; i < 120; i++) {
      const accountId = ["a", "b", "c"][pick(3)];
      // Coarse times so equal times and long gaps both occur.
      const at = T0 + pick(60) * 5 * MIN + (next() < 0.2 ? 31 * MIN : 0);
      const percent = pick(5) * 10;
      const resetsAt = next() < 0.3 ? undefined : T0 + pick(4) * 2 * 60 * MIN;
      const value = sample(accountId, at, percent, resetsAt);
      if (next() < 0.05) delete value.fiveHour;
      if (next() < 0.03) value.checkedAt = "not a date";
      samples.push(value);
    }
    const index = indexSamples(samples);
    for (let i = 0; i < 400; i++) {
      const time =
        i % 4 === 0
          ? Date.parse(samples[pick(samples.length)].checkedAt) || T0
          : T0 - 30 * MIN + (next() * 330 * 5 * MIN) / 5;
      assert.equal(
        index.estimate(time),
        estimateAccountAt(time, samples),
        `seed ${seed}, time ${time}`,
      );
    }
    for (const time of [NaN, Infinity, -Infinity, T0 - 1, T0 + 1e12])
      assert.equal(index.estimate(time), estimateAccountAt(time, samples));
  }
});

test("attribution over 50k samples handles 10k rows in under a second", () => {
  const samples: UsageSample[] = [];
  for (let i = 0; i < 50_000; i++)
    samples.push(
      sample(
        ["a", "b", "c", "d", "e"][i % 5],
        T0 + Math.floor(i / 5) * MIN,
        (i / 5) % 100,
      ),
    );
  const deps = { timeline: noTimeline, samples, accounts };
  const started = performance.now();
  let estimated = 0;
  for (let i = 0; i < 10_000; i++) {
    const result = attribute({ time: T0 + i * 60_000 + 30_000 }, deps);
    if (result.kind === "account") estimated++;
  }
  const elapsed = performance.now() - started;
  assert.ok(estimated > 0);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});
