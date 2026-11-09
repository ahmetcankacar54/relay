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
    { id: "a", name: "Personal", email: "p@example.com", active: true, signedIn: true, quotaPercent: 42, resetInMinutes: 130, inPool: true, requests: 0 },
    { id: "b", name: "Work", active: false, signedIn: true, quotaPercent: 100, resetInMinutes: 5, inPool: true, requests: 0 },
    { id: "c", name: "New", active: false, signedIn: false, inPool: true, requests: 0 },
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

test("main, the preload and the desktop snapshot carry the gateway; quitting stops it", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  for (const name of ["proxy-status", "proxy-toggle", "proxy-configure", "proxy-regenerate-key", "proxy-bind-client", "proxy-unbind-client"]) {
    assert.match(main, new RegExp(`handle\\("${name}"`), name);
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\("relay:${name}"`), name);
  }
  assert.match(main, /proxyStatus: proxyStatus\(\)/);
  assert.match(main, /settings\.proxy\?\.enabled\)\s*void serializeProxy\(startProxy\)/);
  assert.match(main, /app\.on\("will-quit", \(\) => \{[\s\S]*?proxyServer\?\.stop\(\)/);
});
