import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProxyPage } from "../src/pages/Proxy";
import { Sidebar } from "../src/app/Sidebar";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type T } from "../src/data/i18n";
import { antigravitySnippet, claudeCodeSnippet, codexSnippet, gatewayUrl, proxyCurlSnippet, quotaTone, resetLabel } from "../src/lib/proxy-ui";
import { DEFAULT_SETTINGS, type Account, type ProxyStatus, type Snapshot } from "../shared/types";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const KEY = "relay-sec-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const t: T = (tr: string) => tr;
const en: T = (_tr: string, e: string = _tr) => e;
const account = (id: string, name: string, provider?: Account["provider"]): Account => ({
  id, name, kind: "personal", group: "personal", color: "olive", createdAt: "2026-11-01T00:00:00.000Z",
  ...(provider ? { provider } : {}),
});
const status = (over: Partial<ProxyStatus> = {}): ProxyStatus => ({
  running: true,
  port: 8317,
  host: "127.0.0.1",
  clientApiKey: KEY,
  routingStrategy: "soonest-reset",
  affinityTtlSeconds: 300,
  stats: { totalRequests: 10, activeRequests: 1, promptCacheHits: 4, cacheHitRate: 40 },
  accounts: [
    { id: "c1", name: "Claude Max", provider: "claude", email: "c@example.com", active: true, signedIn: true, quotaPercent: 30, resetInMinutes: 90, inPool: true, requests: 0 },
    { id: "c2", name: "Claude Pro", provider: "claude", active: false, signedIn: true, quotaPercent: 95, resetInMinutes: 10, inPool: true, requests: 0 },
    // Relay reads no limits for Codex and Antigravity: the gateway reports none.
    { id: "x1", name: "Codex Pro", provider: "codex", active: false, signedIn: true, inPool: true, requests: 0 },
    { id: "g1", name: "Google Ultra", provider: "antigravity", active: false, signedIn: false, inPool: true, requests: 0 },
  ],
  ...over,
});
const accounts = [account("c1", "Claude Max"), account("c2", "Claude Pro", "claude"), account("x1", "Codex Pro", "codex"), account("g1", "Google Ultra", "antigravity")];

function relayFor(proxy: ProxyStatus | undefined, api: object = {}, known: Account[] = accounts): Relay {
  const settings = { ...DEFAULT_SETTINGS };
  return {
    api: { claudeLaunch: async () => ({ quicOff: false }), ...api },
    preview: false, error: "", notice: "", accounts: known, active: undefined, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    version: "0.18.1",
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, ...(proxy ? { proxyStatus: proxy } : {}) },
    data: { settings, usage: {}, accounts: known, authFlows: [], diagnostics: { platform: "darwin", version: "2.1.0" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {},
    action: async (_name: string, fn: () => Promise<unknown>) => void (await fn()),
    setData() {},
  } as unknown as Relay;
}
const provide = (relay: Relay, node: Parameters<typeof createElement>[0], translate: T = t) =>
  createElement(
    I18nContext.Provider,
    { value: { language: "tr", setLanguage() {}, t: translate } },
    createElement(RelayContext.Provider, { value: relay }, createElement(node as never)),
  );

test("the page's helpers: endpoint, Codex and cURL snippets, quota tone, reset words", () => {
  assert.equal(gatewayUrl("0.0.0.0", 9000), "http://127.0.0.1:9000");
  assert.equal(
    codexSnippet("127.0.0.1", 8317, KEY),
    `export OPENAI_BASE_URL=http://127.0.0.1:8317/v1 && export OPENAI_API_KEY=${KEY}`,
  );
  assert.match(codexSnippet("127.0.0.1", 8317, KEY, true), /OPENAI_API_KEY=relay-sec-••••/);
  assert.match(codexSnippet("127.0.0.1", 8317, undefined), /OPENAI_API_KEY=<relay-key>$/);
  const curl = proxyCurlSnippet("127.0.0.1", 8317, KEY);
  assert.match(curl, /^curl http:\/\/127\.0\.0\.1:8317\/v1\/messages/);
  assert.match(curl, new RegExp(`x-api-key: ${KEY}`));
  assert.doesNotMatch(proxyCurlSnippet("127.0.0.1", 8317, KEY, true), new RegExp(KEY));
  assert.equal(claudeCodeSnippet("127.0.0.1", 8317, KEY).includes("ANTHROPIC_BASE_URL"), true);
  assert.deepEqual([quotaTone(undefined), quotaTone(10), quotaTone(80), quotaTone(95)], ["none", "ok", "warn", "crit"]);
  assert.equal(resetLabel(5, t), "5 dk");
});

const tab = (relay: Relay, initialTab: "canli" | "araclar" | "kurallar", translate: T = t) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: translate === en ? "en" : "tr", setLanguage() {}, t: translate } },
      createElement(RelayContext.Provider, { value: relay }, createElement(ProxyPage, { initialTab })),
    ),
  );

test("the head reads what the gateway does in one line, with the address and a hidden key", () => {
  const html = tab(relayFor(status({ recent: [{ at: Date.now() - 4_000, accountId: "c1", status: 200 }] })), "canli");
  assert.match(html, /Ağ geçidi çalışıyor/);
  // Claude Max and Codex Pro can take requests; Claude Pro is nearly full but not at 100.
  assert.match(html, /3 hesap hazır · son istek \d+ sn önce · Claude Max/);
  assert.match(html, /data-slot="chip-endpoint"[^>]*>http:\/\/127\.0\.0\.1:8317/);
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.match(html, /relay-sec-••••/);
  const off = tab(relayFor(status({ running: false, error: "port busy" })), "canli", en);
  assert.match(off, /Gateway off/);
  assert.match(off, /role="alert"[^>]*>port busy/);
});

test("the Live tab lists the pool in order with both limit windows, and the latest requests", () => {
  const accountsWithWindows = status().accounts.map((a, i) =>
    i === 0
      ? { ...a, fiveHourPercent: 30, fiveHourResetMinutes: 90, weeklyPercent: 50, weeklyResetMinutes: 600, inPool: true, requests: 7, tokens: { input: 1, output: 1, cacheRead: 412_000, cacheWrite: 0 } }
      : i === 1
        ? { ...a, inPool: false, requests: 0 }
        : { ...a, inPool: true, requests: 0 },
  );
  const html = tab(
    relayFor(
      status({
        accounts: accountsWithWindows,
        routingStrategy: "strict-priority",
        recent: [
          { at: Date.now() - 1_000, accountId: "c1", model: "claude-sonnet-4-5", status: 200, affinity: true },
          { at: Date.now() - 2_000, accountId: "c2", model: "claude-sonnet-4-5", status: 429, failover: true },
          { at: Date.now() - 3_000, provider: "codex", status: 503, note: "no-account" },
        ],
      }),
    ),
    "canli",
  );
  const rows = [...html.matchAll(/data-account="(\w+)" data-in-pool="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(rows, ["c1:true", "c2:false", "x1:true", "g1:true"]);
  assert.match(html, /Hesaplar bu sırayla kullanılır/);
  // Both windows, with their resets, and what the account served.
  assert.match(html, /5 saat[\s\S]*?%30 · 1 sa 30 dk[\s\S]*?Hafta[\s\S]*?%50 · 10 sa/);
  assert.match(html, /7 istek · önbellek 412K/);
  // Half the week is left and it resets in 10 hours: that room is about to be lost.
  assert.match(html, /data-slot="at-risk"[^>]*>%50 yanacak/);
  assert.match(html, /Havuz dışı/);
  assert.match(html, /Google Ultra[\s\S]*?Giriş yok/);
  // Relay reads no Codex limits: said so, never an empty bar.
  assert.match(html, /Relay bu sağlayıcının limitini okuyamıyor/);
  // The feed: answered, moved on to the next account, and no account at all.
  assert.match(html, /claude-sonnet-4-5[\s\S]*?Claude Max[\s\S]*?200/);
  assert.match(html, /Claude Pro[\s\S]*?429 → sıradaki/);
  assert.match(html, /hesap yok[\s\S]*?503/);
  assert.match(html, /Önbellek[\s\S]*?%40/);
  // Signed-out accounts in the pool are named above the tabs.
  assert.match(html, /data-slot="proxy-attention"[\s\S]*?Google Ultra: giriş yok/);
});

test("an empty pool invites adding an account", () => {
  const html = tab(relayFor(status({ accounts: [] }), {}, []), "canli");
  assert.match(html, /Havuz boş[\s\S]*#\/hesaplar\?ekle[\s\S]*Hesap ekle/);
});

test("the Tools tab connects Claude Code and Codex in one click; other tools are copied, with a risk note", () => {
  const clients = [
    { id: "claude-code" as const, installed: true, bound: true, stale: false, file: "~/.claude/settings.json" },
    { id: "codex" as const, installed: true, bound: false, stale: true, file: "~/.codex/config.toml" },
  ];
  const html = tab(relayFor(status({ clients })), "araclar");
  assert.match(html, /data-client="claude-code" data-bound="true"[\s\S]*?Önerilen[\s\S]*?Bağlı[\s\S]*?Ayır/);
  assert.match(html, /data-client="codex" data-bound="false"[\s\S]*?Eski adres ya da anahtar[\s\S]*?Yeniden bağla/);
  assert.match(html, /Diğer araçlar \(elle kurulum\)/);
  assert.doesNotMatch(html, new RegExp(KEY));
  // A bound tool while the gateway is off: said once, above the tabs.
  const off = tab(relayFor(status({ running: false, clients })), "araclar");
  assert.match(off, /Claude Code bu geçide bağlı ama geçit kapalı/);
  assert.match(off, />Geçidi aç</);
  assert.equal(
    antigravitySnippet("127.0.0.1", 8317, KEY),
    `curl http://127.0.0.1:8317/v1/models -H "Authorization: Bearer ${KEY}" -H "x-relay-provider: antigravity"`,
  );
});

test("the Rules tab holds the strategies, the session time and who may connect, with Tailscale when found", () => {
  const html = tab(relayFor(status({ routingStrategy: "balanced", tailscaleAddress: "100.101.12.34" })), "kurallar");
  assert.match(html, /role="radiogroup"[^>]*aria-label="Yönlendirme stratejisi"/);
  for (const label of ["Önce yanacak olan \\(önerilen\\)", "Dengeli", "Sıralı"]) assert.match(html, new RegExp(label));
  assert.match(html, /role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Dengeli/);
  assert.match(html, /Oturum aynı hesapta kalsın[\s\S]*?%40/);
  assert.match(html, /Yalnızca bu Mac · <span[^>]*>127\.0\.0\.1/);
  assert.match(html, /Tailscale ağım · <span[^>]*>100\.101\.12\.34/);
  assert.match(html, /VPS\) ya da VPN/);
  // A Tailscale bind is a private network: no warning. Any other network address warns.
  assert.doesNotMatch(tab(relayFor(status({ host: "100.101.12.34", tailscaleAddress: "100.101.12.34" })), "kurallar"), /Bu adres yerel değil/);
  assert.match(tab(relayFor(status({ host: "192.168.1.5" })), "kurallar"), /Bu adres yerel değil/);
  const english = tab(relayFor(status()), "kurallar", en);
  for (const text of ["Expiring first \\(recommended\\)", "Balanced", "In order", "Who can connect"])
    assert.match(english, new RegExp(text));
});

test("turning on, reordering, leaving out, connecting a tool and regenerating the key go through the API", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const calls: unknown[][] = [];
    const pooled = status().accounts.map((a) => ({ ...a, inPool: true, requests: 0 }));
    let current = status({
      running: false,
      accounts: pooled,
      clients: [{ id: "claude-code", installed: true, bound: false, stale: false, file: "~/.claude/settings.json" }],
    });
    const api = {
      proxyStatus: async () => current,
      proxyToggle: async (enabled: boolean) => {
        calls.push(["toggle", enabled]);
        return (current = { ...current, running: enabled });
      },
      proxyConfigure: async (patch: object) => {
        calls.push(["configure", patch]);
        return current;
      },
      proxyBindClient: async (id: string) => {
        calls.push(["bind", id]);
        return (current = { ...current, clients: current.clients!.map((c) => ({ ...c, bound: true })) });
      },
      proxyRegenerateKey: async () => {
        calls.push(["regenerate"]);
        return current;
      },
    };
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const page = (initialTab: "canli" | "araclar" | "kurallar") =>
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t } },
        createElement(RelayContext.Provider, { value: relayFor(current, api) }, createElement(ProxyPage, { initialTab })),
      );
    await act(async () => root.render(page("canli")));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const labelled = (label: string) => find(container, (n) => attr(n, "aria-label") === label);
    const button = (label: string) => find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n).includes(label));

    await act(async () => dom.dispatch(labelled("Ağ geçidini aç veya kapat")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["toggle", true]);
    await act(async () => dom.dispatch(labelled("Claude Pro yukarı")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["configure", { accountOrder: ["c2", "c1", "x1", "g1"] }]);
    await act(async () => dom.dispatch(labelled("Codex Pro havuzda")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["configure", { excludedAccountIds: ["x1"] }]);

    // The key is replaced only after asking.
    await act(async () => dom.dispatch(labelled("Anahtarı yenile")!, "click", { detail: 1 }));
    assert.equal(calls.some((c) => c[0] === "regenerate"), false);
    assert.match(textOf(container), /Eski anahtar hemen çalışmaz olur/);
    await act(async () => dom.dispatch(button("Yeni anahtar üret")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["regenerate"]);

    // A fresh root per tab: the fake DOM keeps Radix's previous tab content mounted.
    await act(async () => root.unmount());
    let next = createRoot(dom.container as unknown as Element);
    await act(async () => next.render(page("araclar")));
    await act(async () => dom.dispatch(button("Bağla")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["bind", "claude-code"]);
    assert.match(textOf(container), /Ayır/);

    await act(async () => next.unmount());
    next = createRoot(dom.container as unknown as Element);
    await act(async () => next.render(page("kurallar")));
    const radio = (label: string) => find(container, (n) => attr(n, "role") === "radio" && textOf(n).includes(label));
    await act(async () => dom.dispatch(radio("Sıralı")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["configure", { routingStrategy: "strict-priority" }]);
    // A host preset fills the address; Uygula saves it with the port.
    await act(async () => dom.dispatch(radio("Tüm yerel ağ")!, "click", { detail: 1 }));
    await act(async () => dom.dispatch(button("Uygula")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["configure", { port: 8317, host: "0.0.0.0" }]);
    await act(async () => next.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the sidebar lists Proxy & Gateway after the usage pages, with a green dot and its address while it runs", () => {
  const render = (status: Record<string, unknown>, compact = false) =>
    renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(Sidebar, { page: "proxy", go: () => {}, t, compact, status: status as never })),
    );
  const off = render({ accounts: 2, planning: false, switching: false, proxyRunning: false });
  assert.match(off, /Hesaplar[\s\S]*Limitler[\s\S]*Rozetler[\s\S]*Proxy &amp; Gateway/);
  assert.match(off, /aria-current="page"[^>]*>[\s\S]*?Proxy &amp; Gateway/);
  assert.equal(off.match(/data-status="on"/g)?.length ?? 0, 0);
  const on = render({ accounts: 2, planning: false, switching: false, proxyRunning: true, proxyAddress: "127.0.0.1:8317" });
  assert.equal(on.match(/data-status="on"/g)?.length, 1);
  assert.match(on, /Proxy çalışıyor · 127\.0\.0\.1:8317/);
  const rail = render({ accounts: 2, planning: false, switching: false, proxyRunning: true, proxyAddress: "127.0.0.1:8317" }, true);
  assert.match(rail, /aria-label="Proxy &amp; Gateway · Proxy çalışıyor · 127\.0\.0\.1:8317"/);
});
