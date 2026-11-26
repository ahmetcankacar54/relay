import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { buildProxyStatus } from "../shared/proxy-status";
import { cleanEntry } from "../electron/core/gateway-request-log";
import { DEFAULT_PROXY_CONFIG } from "../shared/proxy-types";
import { pickLine, pickReasonLabel } from "../src/lib/proxy-ui";
import { ProxyPage } from "../src/pages/Proxy";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue, testT } from "./i18n";
import { DEFAULT_SETTINGS, type Account, type ProxyStatus, type Snapshot } from "../shared/types";

const tr = testT("tr");
const en = testT("en");
const account = (id: string, name = id): Account => ({
  id,
  name,
  kind: "personal",
  group: "default",
  color: "#000",
  createdAt: "2026-11-01T00:00:00.000Z",
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
      { value: i18nValue("tr") },
      createElement(
        TooltipProvider,
        null,
        createElement(RelayContext.Provider, { value: relayFor(proxy) }, createElement(ProxyPage, { initialTab })),
      ),
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
