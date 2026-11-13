import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProxyRouter } from "../electron/core/proxy/proxy-router";
import { ProxySessionCache } from "../electron/core/proxy/proxy-session-cache";
import { ProxyServer } from "../electron/core/proxy/proxy-server";
import { buildProxyStatus } from "../electron/core/proxy/proxy-status";
import { cleanEntry } from "../electron/core/proxy/proxy-request-log";
import { DEFAULT_PROXY_CONFIG } from "../shared/proxy-types";
import { pickLine, pickReasonLabel } from "../src/lib/proxy-ui";
import { ProxyPage } from "../src/pages/Proxy";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type T } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type ProxyStatus, type Snapshot } from "../shared/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const tr: T = (a: string) => a;
const en: T = (_a: string, b: string = _a) => b;
const account = (id: string, name = id): Account => ({
  id,
  name,
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: "2026-11-01T00:00:00.000Z",
});
const usageOf = (id: string, five: number, resetHours: number, now: number): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  fiveHour: { usedPercent: five, resetsAt: new Date(now + resetHours * HOUR).toISOString() },
});

test("the router says why it chose an account: the session's own, the strategy's pick, or the only one", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => now });
  const accounts = [account("a"), account("b"), account("c")];
  const usage = { a: usageOf("a", 93, 1, now), b: usageOf("b", 20, 2, now), c: usageOf("c", 10, 4, now) };

  const first = router.selectAccount("s-1", accounts, usage, "claude");
  assert.equal(first.account.id, "b", "A resets first but is near its limit");
  assert.equal(first.reason, "soonest-reset");
  assert.deepEqual(first.nearlyFull, ["a"]);

  const again = router.selectAccount("s-1", accounts, usage, "claude");
  assert.equal(again.reason, "bound");
  assert.equal(again.nearlyFull, undefined);

  const lone = router.selectAccount("s-2", [account("c")], usage, "claude");
  assert.equal(lone.reason, "only");

  const strict = new ProxyRouter({ strategy: "strict-priority", now: () => now });
  assert.equal(strict.selectAccount("s-3", accounts, usage, "claude").reason, "priority");
  const balanced = new ProxyRouter({ strategy: "balanced", now: () => now });
  assert.equal(balanced.selectAccount("s-4", accounts, usage, "claude").reason, "balanced");
});

test("a session whose account waits on its sign-in is served elsewhere and says which account it waits for", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const router = new ProxyRouter({ strategy: "soonest-reset", now: () => now });
  const accounts = [account("a"), account("b")];
  const usage = { a: usageOf("a", 20, 1, now), b: usageOf("b", 20, 3, now) };
  assert.equal(router.selectAccount("s-1", accounts, usage, "claude").account.id, "a");
  router.markUnavailable("a", 5 * MINUTE, "auth");
  const served = router.selectAccount("s-1", accounts, usage, "claude");
  assert.equal(served.account.id, "b");
  assert.equal(served.boundWaiting, "a");
});

test("the preview names a new session's account without binding anything", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const cache = new ProxySessionCache();
  const router = new ProxyRouter({ strategy: "soonest-reset", sessionCache: cache, now: () => now });
  const usage = { a: usageOf("a", 95, 1, now), b: usageOf("b", 20, 2, now) };
  const pick = router.preview([account("a"), account("b")], usage, "claude");
  assert.equal(pick?.account.id, "b");
  assert.deepEqual(pick?.nearlyFull, ["a"]);
  assert.equal(cache.count(), 0);
  assert.equal(router.preview([account("a")], usage, "codex"), undefined, "no account of that provider");
});

test("a request held on one account names it on the account that served it, and the log keeps the reason", async () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const usage = { a: usageOf("a", 20, 1, now), b: usageOf("b", 20, 3, now) };
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.headers.authorization === "Bearer tok-a") {
        res.writeHead(529, { "content-type": "application/json" });
        res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"usage":{"input_tokens":2,"output_tokens":3}}');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const server = new ProxyServer({
    config: { port: 0, host: "127.0.0.1", enabled: true, routingStrategy: "soonest-reset" },
    credentialResolver: async (a) => `tok-${a.id}`,
    usageProvider: () => ({ accounts: [account("a"), account("b")], usageMap: usage }),
    upstreams: { anthropicUrl: `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}` },
    now: () => now,
  });
  const { port } = await server.start();
  try {
    assert.deepEqual(server.nextPicks(), { claude: { accountId: "a", reason: "soonest-reset" } });
    await new Promise<void>((resolve, reject) =>
      http
        .request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "x-claude-code-session-id": "s-1" } }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        })
        .on("error", reject)
        .end(JSON.stringify({ model: "claude-opus-5-5" })),
    );
    const [served, held] = server.stats.recent();
    assert.equal(held.accountId, "a");
    assert.deepEqual(held.pick, { reason: "soonest-reset" });
    assert.equal(served.accountId, "b");
    assert.equal(served.pick?.after, "a");
    assert.equal(served.pick?.boundWaiting, "a", "an overload keeps the session bound to A");
  } finally {
    await server.stop();
    await new Promise<void>((resolve) => {
      upstream.closeAllConnections();
      upstream.close(() => resolve());
    });
  }
});

test("a pick read back from disk keeps known reasons and account ids only", () => {
  const entry = cleanEntry({
    at: 1,
    status: 200,
    pick: { reason: "soonest-reset", nearlyFull: ["a", 7, "x".repeat(65)], after: "b", overflow: true, extra: "no" },
  });
  assert.deepEqual(entry?.pick, { reason: "soonest-reset", nearlyFull: ["a"], after: "b", overflow: true });
  assert.equal(cleanEntry({ at: 1, status: 200, pick: { reason: "dice" } })?.pick, undefined);
});

test("the status carries the next pick and a sign-in the gateway cannot use, only for pool accounts", () => {
  const now = Date.UTC(2026, 10, 13, 12);
  const base = {
    config: { ...DEFAULT_PROXY_CONFIG, excludedAccountIds: ["c"] },
    accounts: [account("a"), account("b"), account("c")].map((a) => ({ ...a, auth: { loggedIn: true } }) as Account),
    usage: {},
    now,
    nextPick: { claude: { accountId: "a", reason: "balanced" as const } },
    gatewaySignIn: (id: string) => (id === "a" ? undefined : id === "b" ? ("missing" as const) : ("expired" as const)),
  };
  const status = buildProxyStatus({ ...base, running: true });
  assert.deepEqual(status.nextPick, { claude: { accountId: "a", reason: "balanced" } });
  assert.deepEqual(
    status.accounts.map((a) => a.gatewaySignIn),
    [undefined, "missing", undefined],
    "C is out of the pool: the gateway never reads it",
  );
  const stopped = buildProxyStatus({ ...base, running: false });
  assert.equal(stopped.nextPick, undefined);
  assert.equal(stopped.accounts[1].gatewaySignIn, undefined);
});

test("the page words why a request went to its account", () => {
  const names: Record<string, string> = { a: "Alto", b: "Vertex" };
  const nameOf = (id: string) => names[id];
  assert.equal(pickLine({ reason: "bound" }, nameOf, tr), "");
  assert.equal(
    pickLine({ reason: "soonest-reset", nearlyFull: ["a"] }, nameOf, tr),
    "haftası ilk biten hesap seçildi · Alto limite yakın, atlandı",
  );
  assert.equal(
    pickLine({ reason: "only", after: "a", boundWaiting: "a", noSignIn: ["b"] }, nameOf, en),
    "the only account available · tried Alto first · its session's account Alto is waiting; it goes back after · Vertex: sign-in unreadable",
  );
  assert.equal(pickLine({ reason: "bound", overflow: true }, nameOf, tr), "alt ajan, oturumdan ayrı hesapta");
  assert.equal(pickReasonLabel("balanced", en), "most room left");
});

function relayFor(proxy: ProxyStatus): Relay {
  const settings = { ...DEFAULT_SETTINGS };
  const known = proxy.accounts.map((a) => account(a.id, a.name));
  return {
    api: {},
    preview: false, error: "", notice: "", accounts: known, active: undefined, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    version: "0.21.4",
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, proxyStatus: proxy },
    data: { settings, usage: {}, accounts: known, authFlows: [], diagnostics: { platform: "darwin", version: "2.1.0" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {},
    action: async (_name: string, fn: () => Promise<unknown>) => void (await fn()),
    setData() {},
  } as unknown as Relay;
}
const render = (proxy: ProxyStatus, initialTab: "canli" | "kurallar") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: tr } },
      createElement(RelayContext.Provider, { value: relayFor(proxy) }, createElement(ProxyPage, { initialTab })),
    ),
  );
const proxy = (over: Partial<ProxyStatus> = {}): ProxyStatus => ({
  running: true,
  port: 8317,
  host: "127.0.0.1",
  routingStrategy: "soonest-reset",
  stats: { totalRequests: 2, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 },
  accounts: [
    { id: "a", name: "Alto", provider: "claude", active: false, signedIn: true, fiveHourPercent: 93, inPool: true, requests: 0 },
    { id: "b", name: "Vertex", provider: "claude", active: false, signedIn: true, inPool: true, requests: 0, gatewaySignIn: "missing" },
  ],
  ...over,
});

test("the pool shows a new session's account now, and an account whose sign-in the gateway cannot read", () => {
  const html = render(
    proxy({
      nextPick: { claude: { accountId: "a", reason: "soonest-reset", nearlyFull: ["b"] } },
      recent: [{ at: Date.now() - 3_000, accountId: "a", status: 200, pick: { reason: "soonest-reset", nearlyFull: ["b"] } }],
    }),
    "canli",
  );
  assert.match(html, /data-slot="next-pick"/);
  assert.match(html, /Yeni oturum şimdi → <span[^>]*>Alto<\/span> \(haftası ilk biten\); Vertex limite yakın, atlanıyor/);
  assert.match(html, /href="#\/hesaplar\/b"[^>]*data-slot="gateway-sign-in"/);
  assert.match(html, /Ağ geçidi girişi okuyamıyor/);
  assert.match(html, /data-slot="request-pick"[^>]*>Neden bu hesap: haftası ilk biten hesap seçildi · Vertex limite yakın, atlandı/);
});

test("a gateway open to other machines says to connect only your own", () => {
  const local = render(proxy(), "kurallar");
  assert.doesNotMatch(local, /Yalnızca kendi bilgisayarların bağlansın/);
  const tailnet = render(proxy({ host: "100.101.12.34", tailscaleAddress: "100.101.12.34" }), "kurallar");
  assert.match(tailnet, /Yalnızca kendi bilgisayarların bağlansın/);
  assert.match(render(proxy({ host: "0.0.0.0" }), "kurallar"), /Yalnızca kendi bilgisayarların bağlansın/);
});
