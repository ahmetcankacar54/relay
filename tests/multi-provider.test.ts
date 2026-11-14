import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Accounts } from "../src/pages/Accounts";
import { AccountsTable, rowActions } from "../src/pages/accounts/AccountsTable";
import { AccountDetailBody } from "../src/pages/accounts/AccountDetail";
import { AddAccountFlow } from "../src/pages/accounts/AddAccountDialog";
import { suggestAccountName } from "../src/pages/accounts/AddAccountProviders";
import {
  accountProvider,
  filterAccounts,
  providerCounts,
  providerLabel,
  providerShortLabel,
} from "../src/pages/accounts/accountLabels";
import { ProviderBadge } from "../src/components/ProviderBadge";
import { accountHealth, usageSignInStatus } from "../src/lib/account-health";
import { overviewAccounts } from "../src/data/selectors";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type T } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type DetectedProviderSession, type Snapshot } from "../shared/types";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const NOW = Date.parse("2026-11-09T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const t: T = (tr: string) => tr;
const en: T = (_tr: string, e: string = _tr) => e;
const desktop = { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: "a@example.com" };
const base = { kind: "personal" as const, group: "personal", color: "olive", createdAt: iso(NOW) };
const claude: Account = {
  ...base, id: "cl", name: "Kişisel · Max", desktop,
  auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const legacy: Account = { ...base, id: "lg", name: "Eski hesap" };
const codex: Account = {
  ...base, id: "cx", name: "OpenAI · Codex", provider: "codex", color: "blue",
  auth: { loggedIn: true, email: "dev@example.com", checkedAt: iso(NOW), subscription: "Codex Pro" },
};
const antigravity: Account = {
  ...base, id: "ag", name: "Google · Antigravity", provider: "antigravity", color: "plum",
  auth: { loggedIn: true, email: "ag@example.com", checkedAt: iso(NOW) },
};
const signedOut: Account = { ...base, id: "so", name: "Codex dışarıda", provider: "codex" };
const accounts = [claude, legacy, codex, antigravity];
const ready = (id: string): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000), fiveHour: { usedPercent: 20 }, sevenDay: { usedPercent: 30 },
});
const usage: Record<string, AccountUsage> = { cl: ready("cl"), cx: ready("cx"), ag: ready("ag") };

function relayFor(extra: Partial<Relay> = {}, list: Account[] = accounts, api: object = {}): Relay {
  return {
    api: {
      desktopHistorySummary: () => new Promise(() => {}),
      extensionStatus: async () => undefined, checkExtension: async () => undefined,
      terminalStatus: async () => undefined, checkTerminal: async () => undefined,
      detectProviders: async () => [],
      ...api,
    },
    preview: false, error: "", notice: "", accounts: list, active: claude, settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "cl" },
    data: { settings: DEFAULT_SETTINGS, usage, accounts: list, authFlows: [], diagnostics: { platform: "linux" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async (_n: string, fn: () => Promise<unknown>) => void (await fn()),
    ...extra,
  } as unknown as Relay;
}
const wrap = (relay: Relay, child: ReturnType<typeof createElement>, translate: T = t) =>
  createElement(
    I18nContext.Provider,
    { value: { language: "tr", setLanguage() {}, t: translate } },
    createElement(RelayContext.Provider, { value: relay }, child),
  );
const render = (relay: Relay, child: ReturnType<typeof createElement>, translate: T = t) =>
  renderToStaticMarkup(wrap(relay, child, translate));

test("an account without a provider is a Claude account; every provider has its names and tint", () => {
  assert.equal(accountProvider(legacy), "claude");
  assert.equal(accountProvider(codex), "codex");
  assert.deepEqual(
    (["claude", "codex", "antigravity", "gemini"] as const).map((p) => providerLabel(p)),
    ["Claude", "OpenAI / Codex", "Antigravity", "Gemini"],
  );
  assert.deepEqual(
    (["claude", "codex", "antigravity", "gemini"] as const).map(providerShortLabel),
    ["Claude", "Codex", "Antigravity", "Gemini"],
  );
  assert.equal(providerLabel(undefined), "Claude");
  assert.deepEqual(providerCounts([...accounts, signedOut]), { claude: 2, codex: 2, antigravity: 1, gemini: 0 });
});

test("the provider filter narrows the list and keeps search and the other filters working", () => {
  const ids = (list: Account[]) => list.map((a) => a.id);
  assert.deepEqual(ids(filterAccounts(accounts, "", "all", "tr")), ["cl", "lg", "cx", "ag"]);
  assert.deepEqual(ids(filterAccounts(accounts, "", "all", "tr", "claude")), ["cl", "lg"]);
  assert.deepEqual(ids(filterAccounts(accounts, "", "all", "tr", "codex")), ["cx"]);
  assert.deepEqual(ids(filterAccounts(accounts, "", "all", "tr", "antigravity")), ["ag"]);
  assert.deepEqual(ids(filterAccounts(accounts, "dev@example", "all", "tr", "codex")), ["cx"]);
  assert.deepEqual(ids(filterAccounts(accounts, "dev@example", "all", "tr", "claude")), []);
  assert.deepEqual(ids(filterAccounts(accounts, "", "connected", "tr", "claude")), ["cl"]);
});

test("the provider badge names the provider in its own tint", () => {
  const html = render(relayFor(), createElement("div", null,
    createElement(ProviderBadge, { provider: "claude" }),
    createElement(ProviderBadge, { provider: "codex" }),
    createElement(ProviderBadge, { provider: "antigravity", full: true }),
    createElement(ProviderBadge, { provider: "codex", full: true }),
  ));
  assert.match(html, /data-provider="claude"[^>]*>Claude</);
  assert.match(html, /data-provider="codex"[^>]*>Codex</);
  assert.match(html, /data-provider="antigravity"[^>]*>Antigravity</);
  assert.match(html, /data-provider="codex"[^>]*>OpenAI \/ Codex</);
  assert.match(html, /emerald/);
  assert.match(html, /indigo/);
});

test("a Codex or Antigravity account is healthy while signed in, never missing a Claude app sign-in", () => {
  const ctx = { active: false, desktopRunning: true, waiting: false };
  for (const a of [codex, antigravity]) {
    const health = accountHealth(a, usage[a.id], ctx, t);
    assert.equal(health.tone, "ok", a.id);
    assert.equal(health.label, "Gateway için kayıtlı");
    assert.doesNotMatch(health.detail, /Claude uygulaması/);
    assert.equal(health.fix, undefined);
    assert.equal(usageSignInStatus(a, usage[a.id], false, t).tone, "ok");
  }
  // Never read yet is still ready; the other providers' rows have no Claude limits to wait for.
  assert.equal(accountHealth(codex, undefined, ctx, t).tone, "ok");
  // A Claude account without a saved Claude app sign-in still reports it.
  const missing = accountHealth(legacy, undefined, ctx, t);
  assert.equal(missing.label, "Claude uygulaması girişi yok");
  assert.equal(missing.fix, "desktop-link");
  // Signed out, cooling down and out-of-date readings are told apart.
  assert.equal(accountHealth(signedOut, undefined, ctx, t).label, "Giriş yok");
  assert.equal(accountHealth(signedOut, undefined, ctx, t).tone, "off");
  const cooling = { ...codex, cooldownUntil: iso(Date.now() + 3_600_000) };
  assert.equal(accountHealth(cooling, usage.cx, ctx, t).label, "Bekleme süresinde");
  const stale = { ...usage.cx, stale: true };
  assert.equal(accountHealth(codex, stale, ctx, t).label, "Limit verisi eski");
  assert.equal(accountHealth(codex, undefined, { ...ctx, waiting: true }, t).tone, "warn");
  assert.equal(accountHealth(codex, usage.cx, ctx, en).label, "Saved for gateway");
});

test("only Claude accounts are switched to in the Claude app; the others have no Claude app actions", () => {
  const relay = relayFor({ active: undefined });
  const keys = (a: Account) => rowActions(a, relay, t).map((x) => x.key);
  assert.ok(keys(claude).includes("desktop-reconnect"));
  assert.ok(keys(legacy).includes("desktop-link"));
  for (const a of [codex, antigravity]) {
    assert.deepEqual(keys(a), ["refresh", "remove"], a.id);
  }
  assert.ok(keys({ ...claude, id: "c2" }).includes("switch"));
});

test("the table badges every account's provider and shows Codex and Antigravity as gateway accounts", () => {
  const html = render(relayFor(), createElement(AccountsTable, { accounts, open() {}, link() {} }));
  for (const [name, provider, label] of [
    ["Kişisel · Max", "claude", "Claude"],
    ["OpenAI · Codex", "codex", "Codex"],
    ["Google · Antigravity", "antigravity", "Antigravity"],
  ] as const)
    assert.match(html, new RegExp(`${name}</span><span[^>]*data-provider="${provider}"[^>]*>${label}</span>`));
  // The legacy account has no provider field and reads as Claude.
  assert.match(html, /Eski hesap<\/span><span[^>]*data-provider="claude"/);
  // Their connection cell is one gateway badge; Claude's keeps its icons.
  assert.equal([...html.matchAll(/Bağlı · Gateway/g)].length, 2);
  assert.equal([...html.matchAll(/data-slot="gateway-pool"/g)].length, 2);
  assert.equal([...html.matchAll(/data-provider="codex"[^>]*>\s*<span[^>]*title="OpenAI \/ Codex/g)].length >= 0, true);
  assert.doesNotMatch(html, /OpenAI \/ Codex: giriş yok/);
  assert.equal([...html.matchAll(/data-slot="connection-icons"/g)].length, 4);
  // Not one non-Claude row asks for the Claude app.
  const rows = html.split("<tr").slice(1);
  for (const row of rows.filter((r) => /OpenAI · Codex|Google · Antigravity/.test(r)))
    assert.doesNotMatch(row, /Claude uygulaması girişi yok|Claude uygulaması: kayıtlı değil/);
  const signed = render(relayFor({}, [signedOut]), createElement(AccountsTable, { accounts: [signedOut], open() {}, link() {} }));
  assert.match(signed, /Giriş yok/);
  assert.doesNotMatch(signed, /data-slot="gateway-pool"/);
});

test("an account the gateway is serving reads Active in Proxy", () => {
  const relay = relayFor({
    desktop: {
      available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0,
      proxyStatus: { running: true, port: 8317, host: "127.0.0.1", stats: { totalRequests: 1, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 }, accounts: [{ id: "cx", name: "x", active: true }] },
    } as never,
  });
  const html = render(relay, createElement(AccountsTable, { accounts: [codex, antigravity], open() {}, link() {} }), en);
  assert.match(html, /Active in Proxy/);
  assert.equal([...html.matchAll(/<\/svg>Gateway pool<\/span>/g)].length, 1);
});

test("the Accounts page offers a provider filter with counts once more than one provider is used", () => {
  const html = render(relayFor(), createElement(Accounts));
  const group = /data-slot="provider-filter"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
  const items = [...group.matchAll(/<button[^>]*data-state="(on|off)"[^>]*>([\s\S]*?)<\/button>/g)].map(
    (m) => [m[1], m[2].replace(/<[^>]+>/g, "")],
  );
  assert.deepEqual(items, [
    ["on", "Tümü(4)"],
    ["off", "Claude(2)"],
    ["off", "OpenAI / Codex(1)"],
    ["off", "Antigravity(1)"],
  ]);
  assert.match(html, /aria-label="Sağlayıcıya göre filtrele"/);
  // A list of Claude accounts only has nothing to filter by provider.
  const claudeOnly = render(relayFor({}, [claude]), createElement(Accounts));
  assert.doesNotMatch(claudeOnly, /data-slot="provider-filter"/);
  // Every account shows with its provider while All is chosen.
  for (const name of ["Kişisel · Max", "Eski hesap", "OpenAI · Codex", "Google · Antigravity"]) assert.match(html, new RegExp(name));
  const english = render(relayFor(), createElement(Accounts), en);
  assert.match(english, /All<span[^>]*>\(4\)/);
});

test("a Codex account's page shows its provider, its sign-in and the gateway, not the Claude app", () => {
  const html = render(relayFor(), createElement(AccountDetailBody, { account: codex, now: NOW }));
  assert.match(html, /Sağlayıcı<\/dt><dd[^>]*>OpenAI \/ Codex</);
  assert.match(html, /Ağ geçidinin OpenAI \/ Codex isteklerinde kullandığı/);
  assert.doesNotMatch(html, /Girişi doğrula/, "the Claude CLI cannot check a Codex sign-in");
  assert.match(html, /Proxy Gateway/);
  assert.match(html, /Proxy kapalı/);
  assert.match(html, /1 \/ 2 hazır|0 \/ 2 hazır/);
  assert.doesNotMatch(html, /Claude uygulaması girişi/);
  assert.doesNotMatch(html, /Limit okuma girişi/);
  const running = relayFor({
    desktop: {
      available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0,
      proxyStatus: { running: true, port: 8317, host: "127.0.0.1", stats: { totalRequests: 0, activeRequests: 0, promptCacheHits: 0, cacheHitRate: 0 }, accounts: [{ id: "cx", name: "x", active: false, signedIn: true }] },
    } as never,
  });
  const pooled = render(running, createElement(AccountDetailBody, { account: codex, now: NOW }));
  assert.match(pooled, /Havuzda/);
  assert.match(pooled, /2 \/ 2 hazır/);
  // A Claude account keeps the Claude app and the usage sign-in.
  const kept = render(relayFor(), createElement(AccountDetailBody, { account: claude, now: NOW }));
  assert.match(kept, /Claude uygulaması/);
  assert.match(kept, /Limit okuma girişi/);
  assert.doesNotMatch(kept, /isteklerinde kullandığı/);
  assert.match(kept, /Sağlayıcı<\/dt><dd[^>]*>Claude</);
});

test("the Overview names each account's provider and offers no Claude switch on Codex or Antigravity", () => {
  const rows = overviewAccounts(claude, accounts, usage, NOW);
  const byId = Object.fromEntries(rows.map((r) => [r.account.id, r]));
  assert.notEqual(byId.cx.state, "not-linked");
  assert.notEqual(byId.ag.state, "not-linked");
  assert.equal(byId.cx.recommended, false);
  assert.equal(byId.ag.recommended, false);
  // The legacy Claude profile still waits for its Claude app sign-in.
  assert.equal(byId.lg.state, "not-linked");
});

test("suggested names follow the provider and stay unique", () => {
  assert.equal(suggestAccountName("claude", [], t), "Kişisel · Claude");
  assert.equal(suggestAccountName("claude", [], en), "Personal · Claude");
  assert.equal(suggestAccountName("codex", [], t), "OpenAI · Codex");
  assert.equal(suggestAccountName("antigravity", [], t), "Google · Antigravity");
  assert.equal(suggestAccountName("codex", ["openai · codex"], t), "OpenAI · Codex 2");
});

const SESSIONS: DetectedProviderSession[] = [
  { provider: "claude", detected: true, email: "claude@example.com", source: "Claude Desktop" },
  { provider: "codex", detected: true, email: "codex@example.com", source: "~/.codex/auth.json", plan: "pro" },
  { provider: "antigravity", detected: false },
];

test("the add dialog lists the sessions found, ticked, and adds the chosen ones in one click", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const connected: unknown[] = [];
    const api = {
      detectProviders: async () => SESSIONS,
      oneClickConnect: async (input: { provider: string; name: string }) => {
        connected.push(input);
        return {
          account: { ...codex, name: input.name },
          layers: { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" },
        };
      },
    };
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(wrap(relayFor({}, [claude], api), createElement(AddAccountFlow, { close() {} }))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const box = (provider: string) => find(container, (n) => attr(n, "role") === "checkbox" && attr(n, "data-provider") === provider);
    const text = textOf(container);
    assert.match(text, /Bu Mac’te 2 hesap bulduk/);
    assert.match(textOf(box("claude")!), /claude@example\.com/);
    assert.match(textOf(box("codex")!), /codex@example\.com[\s\S]*Codex CLI · ChatGPT Pro/);
    assert.equal(box("antigravity"), undefined);
    assert.deepEqual([attr(box("claude"), "aria-checked"), attr(box("codex"), "aria-checked")], ["true", "true"]);
    assert.match(text, /2 hesabı ekle/);
    // The other ways in, in plain words: no layer jargon.
    for (const re of [/Başka bir Claude hesabıyla giriş yap/, /OpenAI \/ Codex/, /Google Antigravity/]) assert.match(text, re);
    assert.doesNotMatch(text, /Desktop & İstemci|Limit & OAuth|Chrome & Proxy/);
    // Untick Claude: only Codex is added, with its suggested name and no form.
    await act(async () => dom.dispatch(box("claude")!, "click", { detail: 1 }));
    assert.equal(attr(box("claude"), "aria-checked"), "false");
    const add = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n).includes("Hesabı ekle"));
    await act(async () => dom.dispatch(add!, "click", { detail: 1 }));
    assert.deepEqual(connected, [{ provider: "codex", name: "OpenAI · Codex", kind: "personal" }]);
    const done = textOf(container);
    assert.match(done, /1 hesap eklendi/);
    assert.match(done, /OpenAI · Codex/);
    assert.match(done, /Eklenti ve ağ geçidi/);
    assert.doesNotMatch(done, /Claude uygulaması/);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("without a detected session, Codex asks for a key and the connect button waits for one", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    // Nothing detected: no badge, and Codex needs a key.
    await act(async () =>
      root.render(wrap(relayFor({}, [claude], { oneClickConnect: async () => assert.fail("not yet") }), createElement(AddAccountFlow, { close() {} }))),
    );
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    assert.doesNotMatch(textOf(container), /bulduk/);
    assert.match(textOf(container), /Nasıl eklemek istersin\?/);
    const card = find(container, (n) => attr(n, "data-way") === "codex");
    await act(async () => dom.dispatch(card!, "click", { detail: 1 }));
    assert.match(textOf(container), /Bu Mac'te Codex CLI girişi bulunamadı/);
    const connect = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n) === "Bağla");
    assert.equal(attr(connect, "disabled") !== undefined, true);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("Antigravity onboarding starts Google OAuth without asking for an API key", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const starts: object[] = [];
    const cancels: object[] = [];
    let closed = 0;
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(wrap(relayFor({}, [claude], {
      startAntigravityOAuth: async (input: object) => {
        starts.push(input);
        return { accountId: "ag-pending", state: "validstate123" };
      },
      pollAntigravityOAuth: async () => ({ status: "wait" }),
      cancelAntigravityOAuth: async (pending: object) => void cancels.push(pending),
    }), createElement(AddAccountFlow, { close: () => void closed++ }))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const card = find(container, (n) => attr(n, "data-way") === "antigravity");
    await act(async () => dom.dispatch(card!, "click", { detail: 1 }));
    assert.match(textOf(container), /Google ile bağlan/);
    assert.match(textOf(container), /API anahtarı gerekmez/);
    assert.doesNotMatch(textOf(container), /AIza|Gemini API anahtarı/);
    const connect = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n).includes("Google ile bağlan"));
    await act(async () => dom.dispatch(connect!, "click", { detail: 1 }));
    assert.deepEqual(starts, [{ name: "Google · Antigravity", kind: "personal" }]);
    assert.match(textOf(container), /Tarayıcıda Google girişini tamamla/);
    // Leaving while the sign-in waits cancels it, so no half-made account stays behind.
    const cancel = find(container, (n) => n.tagName?.toLowerCase() === "button" && textOf(n) === "İptal et");
    await act(async () => dom.dispatch(cancel!, "click", { detail: 1 }));
    assert.deepEqual(cancels, [{ accountId: "ag-pending", state: "validstate123" }]);
    assert.equal(closed, 1);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("asked for Codex, the add dialog opens on Codex even while a Claude sign-in waits", () => {
  // A half-made Claude profile is waiting for the Claude app: without a provider it is picked up again.
  const halfMade: Account = { ...base, id: "new", name: "Kişisel · Claude" };
  const waitingDesktop = {
    available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0,
    autoCapture: { accountId: "new", status: "waiting" },
  } as unknown as Relay["desktop"];
  const relay = relayFor({ desktop: waitingDesktop }, [claude, halfMade]);
  const codexFirst = render(relay, createElement(AddAccountFlow, { close() {}, start: "codex" }));
  assert.match(codexFirst, /OpenAI API anahtarı/);
  assert.match(codexFirst, /data-provider="codex"/);
  assert.doesNotMatch(codexFirst, /Claude uygulamasında giriş ekranını aç|Claude Code girişi/);
  // Antigravity likewise goes to its own sign-in.
  assert.match(render(relay, createElement(AddAccountFlow, { close() {}, start: "antigravity" })), /Google ile bağlan/);
  // Asked for Claude: the list of what was found and the ways in, not a sign-in at once.
  assert.match(render(relay, createElement(AddAccountFlow, { close() {}, start: "claude" })), /Başka bir Claude hesabıyla giriş yap/);
  // With no provider the half-made profile continues, and Back leads out of it.
  const resumed = render(relay, createElement(AddAccountFlow, { close() {} }));
  assert.match(resumed, /2 · Claude Code girişi/);
  assert.doesNotMatch(resumed, /Nasıl eklemek istersin|Başka bir hesap ekle/);
  assert.match(resumed, />Geri</);
});

test("a sign-in waiting for an account that already has its Claude app sign-in does not take over the dialog", () => {
  const busyDesktop = {
    available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0,
    autoCapture: { accountId: "cl", status: "waiting" },
  } as unknown as Relay["desktop"];
  const html = render(relayFor({ desktop: busyDesktop }, [claude]), createElement(AddAccountFlow, { close() {} }));
  assert.match(html, /Nasıl eklemek istersin\?/);
  assert.match(html, /data-way="codex"/);
  assert.doesNotMatch(html, /Yeni hesapla giriş yap|Claude uygulamasında giriş ekranını aç/);
});
