import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProxyPage } from "../src/pages/Proxy";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type T } from "../src/data/i18n";
import {
  claudeCodeSnippet,
  clientHost,
  codexSnippet,
  gatewayUrl,
  isLoopbackHost,
  maskKey,
  parsePort,
  resetLabel,
  validHost,
} from "../src/lib/proxy-ui";
import { DEFAULT_SETTINGS, type ProxyStatus, type Snapshot } from "../shared/types";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const KEY = "relay-sec-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const status = (over: Partial<ProxyStatus> = {}): ProxyStatus => ({
  running: true,
  port: 8317,
  host: "127.0.0.1",
  clientApiKey: KEY,
  stats: { totalRequests: 1234, activeRequests: 2, promptCacheHits: 97, cacheHitRate: 84.5 },
  accounts: [
    { id: "a", name: "Personal", email: "p@example.com", active: true, signedIn: true, quotaPercent: 42, resetInMinutes: 130 },
    { id: "b", name: "Work", active: false, signedIn: true, quotaPercent: 100, resetInMinutes: 5 },
    { id: "c", name: "New", active: false, signedIn: false },
  ],
  ...over,
});
const t: T = (tr: string, _en: string = tr) => tr;
const en: T = (_tr: string, e: string = _tr) => e;

function relayFor(proxy: ProxyStatus | undefined, api: object = {}): Relay {
  const settings = { ...DEFAULT_SETTINGS };
  return {
    api: { claudeLaunch: async () => ({ quicOff: false }), ...api },
    preview: false,
    error: "",
    notice: "",
    accounts: [],
    active: undefined,
    settings,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    hasUnclaimedDesktop: false,
    targetOrg: "",
    historyRevision: 0,
    version: "0.18.0",
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
      ...(proxy ? { proxyStatus: proxy } : {}),
    },
    data: { settings, usage: {}, accounts: [], authFlows: [], diagnostics: { platform: "darwin", version: "2.1.0" } } as unknown as Snapshot,
    requestDesktop() {},
    setSetupId() {},
    cancelDesktopRequest() {},
    setOrg() {},
    setNotice() {},
    startCli: async () => {},
    refreshUsage: async () => {},
    action: async (_name: string, fn: () => Promise<unknown>) => void (await fn()),
    setData() {},
  } as unknown as Relay;
}
/** A switch's state, whatever the order of its attributes. */
const checked = (html: string, id: string) =>
  new RegExp(`<button[^>]*role="switch"[^>]*aria-checked="(true|false)"[^>]*id="${id}"`).exec(html)?.[1];
const render = (relay: Relay, node: Parameters<typeof createElement>[0], translate: T = t) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: translate } },
      createElement(RelayContext.Provider, { value: relay }, createElement(node as never)),
    ),
  );

test("the client address is one a client can dial, and the key shows only its tail", () => {
  assert.equal(gatewayUrl("127.0.0.1", 8317), "http://127.0.0.1:8317");
  assert.equal(clientHost("0.0.0.0"), "127.0.0.1");
  assert.equal(clientHost("::"), "[::1]");
  assert.equal(clientHost("fd7a::1"), "[fd7a::1]");
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("100.64.0.2"), false);
  assert.equal(maskKey(KEY), "relay-sec-••••••••••••DEFG");
  assert.doesNotMatch(maskKey(KEY), /abcdef/);
  assert.equal(maskKey("relay-sec-ab"), "relay-sec-••");
});

test("the setup snippets carry the address and the key, or a placeholder before there is one", () => {
  assert.equal(
    claudeCodeSnippet("127.0.0.1", 8317, KEY),
    `export ANTHROPIC_BASE_URL=http://127.0.0.1:8317 && export ANTHROPIC_AUTH_TOKEN=${KEY}`,
  );
  assert.match(claudeCodeSnippet("127.0.0.1", 8317, KEY, true), /ANTHROPIC_AUTH_TOKEN=relay-sec-••••/);
  assert.match(claudeCodeSnippet("127.0.0.1", 8317, undefined), /ANTHROPIC_AUTH_TOKEN=<relay-key>$/);
  assert.equal(
    codexSnippet("127.0.0.1", 9000, KEY),
    `export OPENAI_BASE_URL=http://127.0.0.1:9000/v1 && export OPENAI_API_KEY=${KEY}`,
  );
});

test("port and host fields accept only what the gateway accepts", () => {
  assert.equal(parsePort("8317"), 8317);
  assert.equal(parsePort(" 65535 "), 65535);
  for (const bad of ["", "0", "65536", "80a", "1.5", "-1", "123456"]) assert.equal(parsePort(bad), undefined, bad);
  assert.equal(validHost("127.0.0.1"), true);
  assert.equal(validHost("::1"), true);
  for (const bad of ["", "  ", "a b", "http://x", "a@b", "x?y"]) assert.equal(validHost(bad), false, bad);
});

test("a reset reads as time left, in both languages", () => {
  assert.equal(resetLabel(undefined, t), "—");
  assert.equal(resetLabel(0, t), "şimdi");
  assert.equal(resetLabel(5, t), "5 dk");
  assert.equal(resetLabel(130, t), "2 sa 10 dk");
  assert.equal(resetLabel(120, en), "2 h");
  assert.equal(resetLabel(3 * 1440 + 125, en), "3 d 2 h");
});

test("a running gateway reads Çalışıyor with its port; the key is hidden and the monitor is filled", () => {
  const html = render(relayFor(status()), ProxyPage);
  assert.match(html, /Çalışıyor · :8317/);
  assert.doesNotMatch(html, /Durduruldu/);
  assert.equal(checked(html, "proxy-enabled"), "true");
  assert.match(html, /value="127\.0\.0\.1"/);
  assert.match(html, /id="proxy-port"[^>]*value="8317"|value="8317"[^>]*id="proxy-port"/);
  // The real key never reaches the markup; its tail does.
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.match(html, /relay-sec-••••••••••••DEFG/);
  assert.match(html, /Yenile/);
  assert.match(html, /Claude Code CLI/);
  assert.match(html, /export ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:8317 &amp;&amp; export ANTHROPIC_AUTH_TOKEN=relay-sec-••••/);
  assert.match(html, /Codex \/ Cursor \/ OpenAI SDK/);
  assert.match(html, /export OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:8317\/v1 &amp;&amp; export OPENAI_API_KEY=relay-sec-••••/);
  assert.match(html, /cURL testi/);
  assert.match(html, /En yakın sıfırlama \(önerilen\)/);
  for (const re of [/Toplam istek/, /1\.234/, /Aktif akış/, /Önbellek isabeti/, /Önbellek oranı/, /%84,5/])
    assert.match(html, re);
  // Accounts with their quota and reset countdown; the last one used, a full one and one not signed in.
  assert.match(html, /Personal[\s\S]*Son istek[\s\S]*p@example\.com/);
  assert.match(html, /aria-valuenow="42"[\s\S]*%42[\s\S]*2 sa 10 dk/);
  assert.match(html, /Work[\s\S]*Dolu[\s\S]*aria-valuenow="100"/);
  assert.match(html, /New[\s\S]*Giriş yok/);
  assert.equal([...html.matchAll(/data-active="true"/g)].length, 1);
  // Two accounts signed in, one of them full: one can take requests.
  assert.match(html, /1 hesap istek alabilir/);
  assert.doesNotMatch(html, /Sağlayıcılar arası yedekleme|proxy-cross-provider/);
});

test("a stopped gateway reads Durduruldu, says why it did not start, and holds the English too", () => {
  const off = render(relayFor(status({ running: false, error: "127.0.0.1:8317 is already in use." })), ProxyPage);
  assert.match(off, /Durduruldu/);
  assert.doesNotMatch(off, /Çalışıyor ·/);
  assert.equal(checked(off, "proxy-enabled"), "false");
  assert.match(off, /role="alert"[^>]*>127\.0\.0\.1:8317 is already in use\./);
  assert.match(off, /sayaçlar proxy açıkken dolar/);
  const english = render(relayFor(status({ running: false })), ProxyPage, en);
  assert.match(english, /Stopped/);
  assert.match(english, /Live routing monitor/);
  assert.doesNotMatch(english, /Cross-provider fallback/);
  assert.doesNotMatch(english, /Durduruldu/);
});

test("a gateway on a network address warns that anyone with the key can spend the accounts", () => {
  assert.doesNotMatch(render(relayFor(status()), ProxyPage), /yerel değil/);
  assert.match(render(relayFor(status({ host: "100.64.0.2" })), ProxyPage), /Bu adres yerel değil/);
});

test("the page turns the gateway on, changes the strategy, and regenerates the key only after asking", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const calls: unknown[][] = [];
    let current = status({ running: false });
    const api = {
      proxyStatus: async () => current,
      proxyToggle: async (enabled: boolean) => {
        calls.push(["toggle", enabled]);
        return (current = { ...current, running: enabled });
      },
      proxyConfigure: async (patch: object) => {
        calls.push(["configure", patch]);
        return (current = { ...current, ...patch });
      },
      proxyRegenerateKey: async () => {
        calls.push(["regenerate"]);
        return (current = { ...current, clientApiKey: "relay-sec-new" });
      },
    };
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: { language: "tr", setLanguage() {}, t } },
          createElement(RelayContext.Provider, { value: relayFor(current, api) }, createElement(ProxyPage)),
        ),
      ),
    );
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const byId = (id: string) => find(container, (n) => attr(n, "id") === id);
    const button = (label: string) =>
      find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n).includes(label));
    assert.match(textOf(container), /Durduruldu/);

    await act(async () => dom.dispatch(byId("proxy-enabled")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["toggle", true]);
    assert.match(textOf(container), /Çalışıyor · :8317/);

    await act(async () => dom.dispatch(button("Dengeli kapasite")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["configure", { routingStrategy: "balanced" }]);

    // Yenile asks first: the old key stops working.
    await act(async () => dom.dispatch(button("Yenile")!, "click", { detail: 1 }));
    assert.equal(calls.some((c) => c[0] === "regenerate"), false);
    assert.match(textOf(container), /Eski anahtar hemen çalışmaz olur/);
    await act(async () => dom.dispatch(button("Yeni anahtar üret")!, "click", { detail: 1 }));
    assert.deepEqual(calls.at(-1), ["regenerate"]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("main, the preload and the desktop snapshot carry the gateway; quitting stops it", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  for (const name of ["proxy-status", "proxy-toggle", "proxy-configure", "proxy-regenerate-key"]) {
    assert.match(main, new RegExp(`handle\\("${name}"`), name);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\("relay:${name}"`), name);
  }
  assert.match(main, /proxyStatus: proxyStatus\(\)/);
  assert.match(main, /settings\.proxy\?\.enabled\)\s*void serializeProxy\(startProxy\)/);
  assert.match(main, /app\.on\("will-quit", \(\) => \{[\s\S]*?proxyServer\?\.stop\(\)/);
});
