import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GatewayRequestLog, cleanEntry } from "../electron/core/gateway-request-log";
import { attribute } from "../electron/core/token-attribution";
import { UsageManager } from "../electron/core/usage";
import { Store } from "../electron/core/store";
import type { Account } from "../shared/types";
import { testT } from "./i18n";

/** The windows of a real answer through the gateway (2026-11-13), as the gateway reads them. */
const LIVE = {
  fiveHour: { usedPercent: 0, resetsAt: new Date(1794582600 * 1000).toISOString() },
  sevenDay: { usedPercent: 28, resetsAt: new Date(1795060800 * 1000).toISOString() },
};

const account = (id: string): Account => ({
  id,
  name: id.toUpperCase(),
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: new Date().toISOString(),
});

test("the request log keeps 35 days across restarts, answers which account served a request id, and reads back only what it wrote", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-gateway-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "gateway-requests.jsonl");
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const day = 86_400_000;
  const old = { at: clock.now - 40 * day, status: 200, accountId: "a", requestId: "req_old" };
  fs.writeFileSync(file, JSON.stringify(old) + "\nnot json\n" + JSON.stringify({ at: "yesterday", status: 200 }) + "\n");
  const log = new GatewayRequestLog(file, { now: () => clock.now, feedSize: 2 });
  assert.deepEqual(log.load(), []);
  assert.equal(log.accountFor("req_old"), undefined, "older than 35 days");
  assert.equal(fs.readFileSync(file, "utf8"), "", "the file was rewritten without what it dropped");

  log.bind("req_early", "b");
  assert.equal(log.accountFor("req_early"), "b", "known from the headers, before the request is recorded");
  for (const [i, id] of ["req_1", "req_2", "req_3"].entries())
    log.record({ at: clock.now + i, status: 200, accountId: "a", requestId: id, model: "m".repeat(200), client: "claude-code" });
  assert.deepEqual(log.recent().map((e) => e.requestId), ["req_2", "req_3"]);
  assert.equal(log.recent()[0].model?.length, 80);
  // Windows keeps no POSIX mode bits: it reports 0o666 whatever was asked.
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const again = new GatewayRequestLog(file, { now: () => clock.now + day, feedSize: 2 });
  assert.deepEqual(again.load().map((e) => e.requestId), ["req_2", "req_3"]);
  assert.equal(again.accountFor("req_1"), "a");

  assert.equal(cleanEntry({ at: 1, status: 200, prompt: "secret", tokens: { input: -4, output: 9 } })?.tokens?.output, 9);
  assert.equal("prompt" in (cleanEntry({ at: 1, status: 200, prompt: "secret" }) ?? {}), false);
  assert.equal(cleanEntry({ at: 1, status: 2000 }), undefined);
});

test("a response that came through the gateway is the serving account's, whatever its entry point", () => {
  const accounts = [account("a"), account("b")];
  const deps = {
    timeline: { accountAt: () => undefined },
    samples: [],
    accounts,
    gatewayAccount: (id: string) => ({ req_a: "a", req_gone: "removed" })[id],
  };
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_a" }, deps), { kind: "account", accountId: "a", estimated: false });
  assert.deepEqual(attribute({ time: 1, entrypoint: "sdk-ts", requestId: "req_a" }, deps), { kind: "account", accountId: "a", estimated: false });
  // Not through the gateway, or an account since removed: as before.
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_other" }, deps), { kind: "terminal" });
  assert.deepEqual(attribute({ time: 1, entrypoint: "cli", requestId: "req_gone" }, deps), { kind: "terminal" });
  // A Relay profile's own sign-in still decides first.
  assert.deepEqual(attribute({ time: 1, profileAccountId: "b", requestId: "req_a" }, deps), { kind: "account", accountId: "b", estimated: false });
});

test("an answer's windows make the account fresh for everything that reads limits, while reads keep their own pace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-live-usage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(fs.realpathSync(root));
  const claude = store.create({ name: "Claude", kind: "personal" });
  const clock = { now: Date.UTC(2026, 10, 13, 12) };
  const accountUuid = "11111111-2222-4333-8444-555555555555";
  const orgId = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  store.update((state) => {
    state.accounts[0].auth = { loggedIn: true, accountUuid, orgId, email: "dev@example.com", checkedAt: new Date(clock.now).toISOString() };
    state.accounts[0].desktop = { accountUuid, orgId, savedAt: new Date(clock.now).toISOString() };
    state.settings.usageRefreshMinutes = 5;
  });
  const profile = { account: { uuid: accountUuid, email_address: "dev@example.com" }, organization: { uuid: orgId } };
  let reads = 0;
  const samples: unknown[] = [];
  const manager = new UsageManager(
    store,
    async () => ({ accessToken: "fixture-token", expiresAt: clock.now + 86_400_000, scopes: ["user:profile", "user:inference"] }),
    async (endpoint) => {
      if (endpoint === "profile") return profile;
      reads += 1;
      return {
        five_hour: { utilization: 10, resets_at: "2026-11-13T15:00:00Z" },
        seven_day: { utilization: 20, resets_at: "2026-11-18T08:00:00Z" },
        seven_day_opus: { utilization: 5, resets_at: "2026-11-18T08:00:00Z" },
      };
    },
    () => clock.now,
    (_account, usage) => samples.push(usage),
  );
  await manager.refresh(claude.id);
  assert.equal(reads, 1);
  const read = manager.snapshot()[claude.id];
  assert.equal(read.fiveHour?.usedPercent, 10);

  clock.now += 4 * 60_000;
  manager.observe(claude.id, LIVE);
  const live = manager.snapshot()[claude.id];
  assert.equal(live.status, "ready");
  assert.equal(live.stale, false);
  assert.equal(live.fiveHour?.usedPercent, 0);
  assert.equal(live.sevenDay?.usedPercent, 28);
  assert.equal(live.liveAt, new Date(clock.now).toISOString());
  assert.equal(live.checkedAt, live.liveAt);
  assert.deepEqual(live.modelWindows, read.modelWindows, "what only a read knows stays");
  assert.equal(samples.length, 2, "the read, then the first live reading");

  // The same percents a minute later add no sample; a moved percent does, once a minute.
  clock.now += 61_000;
  manager.observe(claude.id, LIVE);
  assert.equal(samples.length, 2);
  manager.observe(claude.id, { fiveHour: { usedPercent: 3 } });
  assert.equal(samples.length, 3);
  manager.observe(claude.id, { fiveHour: { usedPercent: 4 } });
  assert.equal(samples.length, 3, "not twice within a minute");

  // The read's own schedule: five minutes after the last read, not after the last answer.
  manager.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2, "polled although the live reading is a second old");

  // Codex and accounts without a sign-in are left alone.
  const codex = store.create({ name: "Codex", kind: "personal", provider: "codex" });
  manager.observe(codex.id, { fiveHour: { usedPercent: 50 } });
  assert.equal(manager.snapshot()[codex.id].fiveHour, undefined);
});

test("the feed says who asked, what kind of request, how long and how much was cached", async () => {
  const { requestDetail } = await import("../src/lib/proxy-ui");
  const tr = testT("tr");
  const en = testT("en");
  const entry = {
    client: "claude-code",
    requestClass: "subagent",
    ms: 1430,
    tokens: { input: 3, cacheRead: 9_000, cacheWrite: 997, output: 412 },
  };
  assert.equal(requestDetail(entry, tr, "tr-TR"), "Claude Code · alt ajan · 1,4 sn · 10K girdi, %90 önbellekten · 412 çıktı");
  assert.equal(requestDetail(entry, en, "en-US"), "Claude Code · subagent · 1.4 s · 10K in, 90% cached · 412 out");
  assert.equal(requestDetail({ client: "curl", ms: 220, note: "refused" }, en, "en-US"), "curl · 220 ms · not a limit: Anthropic turned the request down");
  assert.equal(requestDetail({}, en, "en-US"), "");
});

test("the Overview says which tools go through the gateway and where the last request went", async () => {
  const { gatewayLine } = await import("../src/lib/proxy-ui");
  const en = testT("en");
  const now = Date.UTC(2026, 10, 13, 12);
  const accounts = [{ id: "a", name: "Alto" }];
  const recent = [{ at: now - 120_000, accountId: "a" }];
  const claude = { id: "claude-code", bound: true };
  assert.deepEqual(gatewayLine({ running: true, clients: [claude], recent, accounts }, en, now), {
    tone: "ok",
    text: "Claude Code goes through the gateway, not the Claude app's account · last request Alto, 2 min ago",
  });
  assert.deepEqual(gatewayLine({ running: false, clients: [claude, { id: "codex", bound: true }], accounts }, en, now), {
    tone: "crit",
    text: "Claude Code and Codex CLI are bound to the gateway, but it is off: requests fail.",
  });
  const all = [claude, { id: "codex", bound: true }, { id: "omp", bound: true }];
  assert.equal(
    gatewayLine({ running: false, clients: all, accounts }, en, now)?.text,
    "Claude Code, Codex CLI and omp are bound to the gateway, but it is off: requests fail.",
  );
  assert.equal(gatewayLine({ running: false, clients: [{ id: "codex", bound: false }], accounts }, en, now), undefined);
  assert.equal(gatewayLine({ running: true, clients: [], accounts }, en, now), undefined);
  assert.equal(gatewayLine(undefined, en, now), undefined);
});
