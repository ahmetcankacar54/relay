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
    { id: "c1", name: "Claude Max", provider: "claude", email: "c@example.com", active: true, signedIn: true, quotaPercent: 30, resetInMinutes: 90 },
    { id: "c2", name: "Claude Pro", provider: "claude", active: false, signedIn: true, quotaPercent: 95, resetInMinutes: 10 },
    // Relay reads no limits for Codex and Antigravity: the gateway reports none.
    { id: "x1", name: "Codex Pro", provider: "codex", active: false, signedIn: true },
    { id: "g1", name: "Google Ultra", provider: "antigravity", active: false, signedIn: false },
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

test("the Proxy page shows a pool per provider, with its accounts counted", () => {
  const html = renderToStaticMarkup(provide(relayFor(status()), ProxyPage));
  assert.match(html, /Yerel API ağ geçidi/);
  const pools = [...html.matchAll(/data-slot="pool-card"[^>]*data-provider="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(pools, ["claude", "codex", "antigravity"]);
  assert.match(html, /OpenAI \/ Codex/);
  assert.match(html, /Antigravity/);
  const cards = html.split('data-slot="pool-card"').slice(1);
  // Claude has two accounts, one of them nearly full but still serving; its average is shown used.
  assert.match(cards[0], />2<[\s\S]*?ort\. %63 dolu[\s\S]*?aria-valuenow="63"[\s\S]*?2 hesap istek alabilir/);
  // Codex and Antigravity limits are unknown: never shown as empty, and no bar.
  assert.match(cards[1], />1<[\s\S]*?Kota bilinmiyor[\s\S]*?1 hesap istek alabilir/);
  assert.doesNotMatch(cards[1], /role="meter"|boş/);
  // An account without a sign-in cannot take requests.
  assert.match(cards[2], /Kota bilinmiyor[\s\S]*?0 hesap istek alabilir/);
  // The pool table names each account's provider.
  assert.match(html, /data-provider="codex"[^>]*>[\s\S]*?Codex<\/span>[\s\S]*?Codex Pro/);
  assert.match(html, /data-provider="antigravity"[^>]*>[\s\S]*?Google Ultra/);
  assert.match(html, /Son istek/);
  assert.match(html, /Google Ultra[\s\S]*?Giriş yok/);
  assert.doesNotMatch(html, /Aktif Havuz|Sırada/);
});

test("an empty provider pool offers adding an account for it", () => {
  const html = renderToStaticMarkup(
    provide(relayFor(status({ accounts: [status().accounts[0]] }), {}, [accounts[0]]), ProxyPage),
  );
  // Only a Claude account is known, though the other two cards still show.
  const cards = html.split('data-slot="pool-card"').slice(1);
  assert.equal(cards.length, 3);
  assert.match(cards[0], /Hesaplara git/);
  assert.match(cards[1], /Havuzda hesap yok[\s\S]*#\/hesaplar\?ekle[\s\S]*Hesap ekle/);
  assert.match(cards[2], /Havuzda hesap yok/);
});

test("the Proxy page holds the strategy selector, the telemetry, the snippets and both languages", () => {
  const html = renderToStaticMarkup(provide(relayFor(status({ routingStrategy: "balanced" })), ProxyPage));
  assert.match(html, /role="radiogroup"[^>]*aria-label="Yönlendirme stratejisi"/);
  for (const label of ["En yakın sıfırlama \\(önerilen\\)", "Dengeli kapasite", "Sıralı öncelik"]) assert.match(html, new RegExp(label));
  assert.match(html, /role="radio"[^>]*aria-checked="true"[^>]*>(?:(?!<\/button>)[\s\S])*Dengeli kapasite/);
  assert.equal([...html.matchAll(/role="radio"[^>]*aria-checked="true"/g)].length, 1);
  for (const label of ["Toplam istek", "Aktif akış", "Önbellek isabeti", "Önbellek oranı"]) assert.match(html, new RegExp(label));
  for (const label of ["Claude Code CLI", "Codex / Cursor / OpenAI SDK", "Antigravity modelleri · cURL", "cURL testi"]) assert.match(html, new RegExp(label.replace("/", "\\/")));
  assert.match(html, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8317/);
  assert.match(html, /OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8317\/v1/);
  assert.equal(
    antigravitySnippet("127.0.0.1", 8317, KEY),
    `curl http://127.0.0.1:8317/v1/models -H "Authorization: Bearer ${KEY}" -H "x-relay-provider: antigravity"`,
  );
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.match(html, /Çalışıyor · :8317/);
  const english = renderToStaticMarkup(provide(relayFor(status({ running: false })), ProxyPage, en));
  for (const text of ["Soonest reset \\(recommended\\)", "Balanced capacity", "Strict priority", "Stopped", "cURL test", "Active streams", "Cache hit ratio", "Local gateway for Claude Code"])
    assert.match(english, new RegExp(text));
});

test("choosing a strategy and a host preset goes through proxyConfigure", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const calls: object[] = [];
    let current = status();
    const api = {
      proxyStatus: async () => current,
      proxyConfigure: async (patch: object) => {
        calls.push(patch);
        return (current = { ...current, ...patch });
      },
    };
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(provide(relayFor(current, api), ProxyPage)));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const radio = (label: string) =>
      find(container, (n) => attr(n, "role") === "radio" && textOf(n).includes(label));
    assert.equal(attr(radio("En yakın sıfırlama"), "aria-checked"), "true");
    await act(async () => dom.dispatch(radio("Sıralı öncelik")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), { routingStrategy: "strict-priority" });
    assert.equal(attr(radio("Sıralı öncelik"), "aria-checked"), "true");
    // The strategy already chosen is not sent again.
    const before = calls.length;
    await act(async () => dom.dispatch(radio("Sıralı öncelik")!, "click", { detail: 1 }));
    assert.equal(calls.length, before);
    // A host preset only fills the field; Uygula saves it with the port.
    const preset = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n).includes("0.0.0.0"));
    await act(async () => dom.dispatch(preset!, "click", { detail: 1 }));
    const apply = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n) === "Uygula");
    assert.ok(apply, "the host change can be applied");
    await act(async () => dom.dispatch(apply!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), { port: 8317, host: "0.0.0.0" });
    await act(async () => root.unmount());
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
