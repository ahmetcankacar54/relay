import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  RoutineLedger,
  RoutineManager,
  routineIdentityKey,
  routineKey,
  type RoutineState,
  type RoutineRecord,
} from "../electron/core/routines";
import {
  quotaStarterArgs,
  routineEnvironment,
  personalRoutineEligible,
} from "../electron/core/routine-runner";
import {
  planningAccount,
  planningSettings,
  planningUsage,
} from "./planning-fixtures";
const NOW = Date.parse("2026-10-13T05:59:45Z");
async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-routines-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const account = planningAccount();
  let now = NOW,
    calls = 0,
    refreshes = 0;
  const state: RoutineState = {
    accounts: [account],
    usage: { a: planningUsage(account) },
    workday: planningSettings(),
    blockedAccountIds: [],
    blocked: false,
  };
  const ledger = new RoutineLedger(dir);
  let onRefresh: (() => void) | undefined;
  let onVerify: (() => void) | undefined;
  let onRun: (() => void) | undefined;
  let confirm = true;
  const manager = new RoutineManager(
    {
      state: () => state,
      verify: async () => {
        onVerify?.();
        return true;
      },
      refresh: async () => {
        refreshes++;
        onRefresh?.();
        const u = planningUsage(account, now);
        u.fiveHour = structuredClone(state.usage.a.fiveHour ?? u.fiveHour);
        if (calls && confirm)
          u.fiveHour!.resetsAt = new Date(now + 5 * 3_600_000).toISOString();
        return u;
      },
      run: async () => {
        calls++;
        onRun?.();
      },
    },
    ledger,
    () => now,
  );
  return {
    account,
    state,
    ledger,
    manager,
    calls: () => calls,
    refreshes: () => refreshes,
    advance: (ms: number) => {
      now += ms;
      state.usage.a.checkedAt = new Date(now).toISOString();
    },
    setRefresh: (fn: () => void) => {
      onRefresh = fn;
    },
    setVerify: (fn: () => void) => {
      onVerify = fn;
    },
    setRun: (fn: () => void) => {
      onRun = fn;
    },
    unverified: () => {
      confirm = false;
    },
  };
}
test("disabled routines never refresh or send; startup and wake skip catch-up", async (t) => {
  const f = await fixture(t);
  f.state.workday.routineEnabled = false;
  await f.manager.tick();
  f.advance(15_001);
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.refreshes(), 0);
  f.state.workday.routineEnabled = true;
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.snapshot().entries[0].reason, "missed");
  const g = await fixture(t);
  await g.manager.tick();
  g.advance(5 * 60_000);
  await g.manager.tick();
  assert.equal(g.calls(), 0);
  assert.equal(g.manager.snapshot().entries[0].reason, "missed");
});
test("one quota message is claimed before request and verified only from a new server reset", async (t) => {
  const f = await fixture(t);
  await f.manager.tick();
  f.advance(15_001);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.manager.snapshot().entries[0].status, "verified");
  assert.ok(f.manager.snapshot().entries[0].observedResetAt);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  const restarted = new RoutineManager(
    {
      state: () => f.state,
      refresh: async () => assert.fail("no repeated refresh"),
      verify: async () => true,
      run: async () => assert.fail("no repeat"),
    },
    f.ledger,
    () => NOW + 30_000,
  );
  await restarted.tick();
  assert.equal(restarted.snapshot().entries[0].status, "verified");
});
test("CLI success without server reset is explicitly unverified and never retried", async (t) => {
  const f = await fixture(t);
  f.unverified();
  await f.manager.tick();
  f.advance(15_001);
  await f.manager.tick();
  assert.equal(f.manager.snapshot().entries[0].status, "sent-unverified");
  await f.manager.tick();
  assert.equal(f.calls(), 1);
});
test("a reconnect after sending cannot verify the previous account's routine", async (t) => {
  const f = await fixture(t);
  await f.manager.tick();
  f.advance(15_001);
  f.setRun(() => {
    f.account.auth!.orgId = "reconnected-organization";
  });
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.manager.snapshot().entries[0].status, "sent-unverified");
  assert.equal(f.manager.snapshot().entries[0].reason, "settings-changed");
  assert.equal(f.refreshes(), 1);
});
test("a failed claim persistence prevents all model requests", async (t) => {
  const f = await fixture(t);
  await f.manager.tick();
  f.advance(15_001);
  f.ledger.claim = async () => {
    throw new Error("fixture disk unavailable");
  };
  await f.manager.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.refreshes(), 0);
  assert.equal(f.manager.snapshot().error, "ledger-unavailable");
});
test("freshly checked active windows, running account and global operations skip the routine", async (t) => {
  for (const mode of ["active", "in-use", "blocked"] as const) {
    const f = await fixture(t);
    await f.manager.tick();
    f.advance(15_001);
    if (mode === "active")
      f.state.usage.a.fiveHour!.resetsAt = new Date(NOW + 60_000).toISOString();
    if (mode === "in-use") f.state.blockedAccountIds = ["a"];
    if (mode === "blocked") f.state.blocked = true;
    await f.manager.tick();
    assert.equal(f.calls(), 0);
    assert.equal(f.refreshes(), mode === "active" ? 1 : 0);
  }
});
test("stale cached usage is refreshed before a due slot can be skipped", async (t) => {
  const f = await fixture(t);
  await f.manager.tick();
  f.advance(15_001);
  f.state.usage.a.stale = true;
  f.state.usage.a.checkedAt = new Date(NOW - 300_000).toISOString();
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.refreshes(), 2);
  assert.equal(f.manager.snapshot().entries[0].status, "verified");
});
test("full-day shifts start the next anchor's warm-up while the current shift remains open", async (t) => {
  const f = await fixture(t);
  f.state.workday.start = f.state.workday.end = "00:00";
  f.state.workday.warmupLeadMinutes = 300;
  await f.manager.tick();
  f.advance(10 * 3_600_000);
  await f.manager.tick();
  f.advance(15_001);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  const verified = f.manager
    .snapshot()
    .entries.find((r) => r.status === "verified")!;
  assert.equal(verified.date, "2026-10-14");
  assert.equal(verified.scheduledAt, "2026-10-13T16:00:00.000Z");
});
test("overnight shift warm-up is keyed by the future shift start, not its completion day", async (t) => {
  const f = await fixture(t);
  f.state.workday.start = "22:00";
  f.state.workday.end = "06:00";
  f.state.workday.warmupLeadMinutes = 300;
  await f.manager.tick();
  f.advance(8 * 3_600_000);
  await f.manager.tick();
  f.advance(15_001);
  await f.manager.tick();
  assert.equal(f.calls(), 1);
  assert.equal(
    f.manager.snapshot().entries.find((r) => r.status === "verified")!.date,
    "2026-10-13",
  );
});
test("settings, account identity, stop, cooldown or quota changes during preflight revoke dispatch", async (t) => {
  for (const mode of [
    "disabled",
    "identity",
    "stopped",
    "cooldown",
    "quota",
  ] as const) {
    const f = await fixture(t);
    await f.manager.tick();
    f.advance(15_001);
    f.setVerify(() => {
      if (mode === "disabled") f.state.workday.routineEnabled = false;
      if (mode === "identity") f.account.auth!.orgId = "changed";
      if (mode === "stopped") f.manager.stop();
      if (mode === "cooldown")
        f.account.cooldownUntil = new Date(NOW + 60_000).toISOString();
    });
    if (mode === "quota")
      f.setRefresh(() => {
        f.account.cooldownUntil = new Date(NOW + 60_000).toISOString();
      });
    await f.manager.tick();
    assert.equal(f.calls(), 0);
    assert.equal(f.manager.snapshot().entries[0].status, "failed");
  }
});
test("coincident starts cannot enable multiple-account routines", async (t) => {
  const f = await fixture(t),
    b = { ...f.account, id: "b" };
  f.state.accounts.push(b);
  f.state.usage.b = planningUsage(b);
  f.state.workday.accountIds = ["a", "b"];
  f.state.workday.staggerMinutes = 0;
  await f.manager.tick();
  f.advance(15_001);
  await Promise.all([f.manager.tick(), f.manager.tick()]);
  assert.equal(f.calls(), 0);
  assert.equal((await f.ledger.list()).length, 0);
});
test("exclusive ledger claims survive crashes, concurrent instances and edits to scheduled time", async (t) => {
  const f = await fixture(t),
    identityKey = routineIdentityKey(f.account)!;
  const record: RoutineRecord = {
    key: routineKey(identityKey, "2026-10-13"),
    date: "2026-10-13",
    accountId: "a",
    identityKey,
    scheduledAt: new Date(NOW + 15_000).toISOString(),
    status: "claimed",
  };
  const other = new RoutineLedger(f.ledger.directory);
  const claims = await Promise.all([
    f.ledger.claim(record),
    other.claim(record),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    await f.ledger.claim({
      ...record,
      scheduledAt: new Date(NOW + 60_000).toISOString(),
    }),
    false,
  );
  const stat = await fs.stat(
    path.join(f.ledger.directory, `${record.key}.json`),
  );
  if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600);
  await fs.writeFile(path.join(f.ledger.directory, `${record.key}.json`), "");
  assert.equal(await other.claim(record), false);
  assert.deepEqual(await other.list(), []);
});
test("isolated starter disables every tool, MCP, customization and persistence without resume or bypass", () => {
  const args = quotaStarterArgs();
  for (const flag of [
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "*");
  assert.equal(args[args.indexOf("--max-turns") + 1], "1");
  for (const flag of [
    "--resume",
    "--continue",
    "--desktop",
    "--bare",
    "--dangerously-skip-permissions",
  ])
    assert.ok(!args.includes(flag));
  const env = routineEnvironment("/fixture/profile", "fake-token", {
    PATH: "/bin",
    ANTHROPIC_API_KEY: "unexpected",
    CLAUDE_CONFIG_DIR: "wrong",
    OTEL_EXPORTER_OTLP_HEADERS: "secret",
    DEBUG: "1",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, "/fixture/profile");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "fake-token");
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(env.DEBUG, undefined);
  const a = planningAccount();
  assert.equal(personalRoutineEligible(a), true);
  a.auth!.subscription = "team";
  a.planning!.plan = "max20";
  assert.equal(personalRoutineEligible(a), false);
});
