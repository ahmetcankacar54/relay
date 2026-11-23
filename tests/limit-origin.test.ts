import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Store } from "../electron/core/store";
import { UsageManager } from "../electron/core/usage";
import { limitColumns, limitHeadline, limitOrigin } from "../shared/quota-windows";
import { LimitLine, limitOriginText } from "../src/components/LimitLine";
import { I18nContext } from "../src/data/i18n";
import { usageWindowRows } from "../src/data/selectors";
import { i18nValue, testT } from "./i18n";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const AT = new Date(NOW).toISOString();
const credential = { accessToken: "fixture-secret-never-rendered", expiresAt: NOW + 3_600_000, scopes: ["user:profile"] };
const profile = { account: { email_address: "a@example.com", uuid: "account-a" }, organization: { uuid: "org-a" } };
const answer = {
  five_hour: { utilization: 40, resets_at: "2026-11-20T15:00:00Z" },
  seven_day: { utilization: 20, resets_at: "2026-11-24T12:00:00Z" },
  seven_day_opus: { utilization: 10, resets_at: "2026-11-24T12:00:00Z" },
};

async function store(t: TestContext, setup: (s: Store) => string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-limit-origin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const s = new Store(root);
  return { s, id: setup(s) };
}

const signedIn = (s: Store) => {
  const a = s.create({ name: "Vertex", kind: "personal" });
  s.update((state) => {
    state.accounts[0].auth = { loggedIn: true, email: "a@example.com", checkedAt: AT };
  });
  return a.id;
};

test("a read through the Claude Code sign-in marks every window official, with its read time", async (t) => {
  const { s, id } = await store(t, signedIn);
  const manager = new UsageManager(s, async () => credential, async (endpoint) => (endpoint === "profile" ? profile : answer), () => NOW);
  const usage = await manager.refresh(id);
  assert.deepEqual([usage.fiveHour?.source, usage.sevenDay?.source, usage.modelWindows?.[0]?.source], ["official", "official", "official"]);
  assert.deepEqual([usage.fiveHour?.readAt, usage.sevenDay?.readAt, usage.modelWindows?.[0]?.readAt], [AT, AT, AT]);
});

test("a read through the Claude app's sign-in marks its windows as the app session", async (t) => {
  const { s, id } = await store(t, (st) => {
    const a = st.create({ name: "Alto", kind: "personal" });
    st.update((state) => {
      state.accounts[0].desktop = { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: AT };
    });
    return a.id;
  });
  const manager = new UsageManager(
    s,
    async () => assert.fail("no Claude Code credential"),
    undefined,
    () => NOW,
    undefined,
    undefined,
    undefined,
    undefined,
    { usable: () => true, read: async () => answer },
  );
  const usage = await manager.refresh(id);
  assert.equal(usage.fiveHour?.source, "app-session");
  assert.equal(usage.sevenDay?.readAt, AT);
});

test("a Codex or Antigravity read through its provider's own quota API is official", async (t) => {
  const { s, id } = await store(t, (st) => {
    const a = st.create({ name: "Codex", kind: "personal", provider: "codex" });
    st.update((state) => {
      state.accounts[0].auth = { loggedIn: true, email: "dev@example.com", checkedAt: AT };
    });
    return a.id;
  });
  const manager = new UsageManager(
    s,
    async () => assert.fail("no Claude credential"),
    async () => assert.fail("no Claude request"),
    () => NOW,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({
      limits: {
        fiveHour: { usedPercent: 10 },
        modelWindows: [{ key: "antigravity_gemini_5h", label: "Gemini", usedPercent: 30, period: "five_hour" }],
      },
    }),
  );
  const usage = await manager.refresh(id);
  assert.deepEqual(usage.fiveHour, { usedPercent: 10, source: "official", readAt: AT });
  assert.equal(usage.modelWindows?.[0]?.source, "official");
});

test("windows a gateway answer reported say so; what only the read knows keeps the read's source", async (t) => {
  const { s, id } = await store(t, signedIn);
  let now = NOW;
  const manager = new UsageManager(s, async () => credential, async (endpoint) => (endpoint === "profile" ? profile : answer), () => now);
  await manager.refresh(id);
  now += 120_000;
  manager.observe(id, { fiveHour: { usedPercent: 55, resetsAt: "2026-11-20T15:00:00Z" } });
  const usage = manager.snapshot()[id];
  assert.deepEqual(usage.fiveHour, { usedPercent: 55, resetsAt: "2026-11-20T15:00:00Z", source: "gateway", readAt: new Date(now).toISOString() });
  assert.equal(usage.sevenDay?.source, "official");
  assert.equal(usage.sevenDay?.readAt, AT);
  // A model the answer named is the gateway's too.
  manager.observe(id, { models: [{ model: "opus", weekly: true, usedPercent: 12 }] });
  assert.equal(manager.snapshot()[id].modelWindows?.find((w) => w.key === "seven_day_opus")?.source, "gateway");
});

test("a window whose reset passed since its reading is Relay's estimate", () => {
  const read = { usedPercent: 80, resetsAt: new Date(NOW - 60_000).toISOString(), source: "official" as const, readAt: new Date(NOW - 3_600_000).toISOString() };
  assert.deepEqual(limitOrigin(read, undefined, NOW), { source: "estimate", readAt: read.readAt });
  assert.deepEqual(limitOrigin({ ...read, resetsAt: new Date(NOW + 60_000).toISOString() }, undefined, NOW), { source: "official", readAt: read.readAt });
});

test("an untagged window takes its source from the account's sign-in and its age from the read", () => {
  const checkedAt = new Date(NOW - 5 * 60_000).toISOString();
  assert.deepEqual(limitOrigin({}, { source: "desktop", checkedAt }, NOW), { source: "app-session", readAt: checkedAt });
  assert.deepEqual(limitOrigin({}, { source: "cli", checkedAt }, NOW), { source: "official", readAt: checkedAt });
  assert.equal(limitOrigin({}, { checkedAt }, NOW), undefined);
  assert.equal(limitOrigin(undefined, { source: "cli", checkedAt }, NOW), undefined);
});

test("rows, columns and the headline keep each window's source", () => {
  const readAt = new Date(NOW - 60_000).toISOString();
  const usage = {
    accountId: "a",
    status: "ready" as const,
    stale: false,
    fiveHour: { usedPercent: 30, source: "gateway" as const, readAt },
    sevenDay: { usedPercent: 50, source: "official" as const, readAt },
  };
  assert.deepEqual(usageWindowRows(usage).map((r) => r.source), ["gateway", "official"]);
  assert.equal(limitHeadline(usage, NOW)?.source, "official");
  assert.equal(limitColumns(usage, NOW).five?.source, "gateway");
  const pools = {
    accountId: "b",
    status: "ready" as const,
    stale: false,
    modelWindows: [{ key: "antigravity_gemini_5h", label: "Gemini", usedPercent: 30, period: "five_hour" as const, source: "official" as const, readAt }],
  };
  assert.equal(limitColumns(pools, NOW).five?.source, "official");
  assert.equal(usageWindowRows(pools)[0].readAt, readAt);
});

test("the tooltip names each source and the reading's age", () => {
  const en = testT("en");
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  assert.equal(limitOriginText({ source: "official", readAt: ago(3) }, NOW, en, "en"), "Source: Official API · 3 min ago");
  assert.equal(limitOriginText({ source: "app-session", readAt: ago(0) }, NOW, en, "en"), "Source: Claude app sign-in · just now");
  assert.equal(limitOriginText({ source: "gateway", readAt: ago(90) }, NOW, en, "en"), `Source: Gateway answer · ${en("proxyUi.hAgo", { hours: 1 })}`);
  assert.equal(limitOriginText({ source: "estimate", readAt: ago(2 * 24 * 60) }, NOW, en, "en"), `Source: Estimate (reset since the reading) · ${en("libTime.daysAgo", { days: 2 })}`);
  assert.equal(limitOriginText({ source: "official" }, NOW, en, "en"), "Source: Official API");
  assert.equal(limitOriginText(undefined, NOW, en, "en"), undefined);
  // The age moves on with the row's clock.
  assert.equal(limitOriginText({ source: "official", readAt: ago(3) }, NOW + 5 * 60_000, en, "en"), "Source: Official API · 8 min ago");
  assert.equal(limitOriginText({ source: "official", readAt: ago(3) }, NOW, testT("tr"), "tr"), "Kaynak: Resmi API · 3 dk önce");
});

test("a limit line's tooltip ends with its source and age", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(LimitLine, {
        label: "5 hours",
        usedPercent: 40,
        resetsAt: new Date(NOW + 60 * 60_000).toISOString(),
        period: "five_hour",
        now: NOW,
        t: testT("en"),
        origin: { source: "official", readAt: new Date(NOW - 3 * 60_000).toISOString() },
      }),
    ),
  );
  const title = /title="([^"]*)"/.exec(html)?.[1] ?? "";
  assert.match(title, /^5 hours .*\nSource: Official API · 3 min ago$/);
});
