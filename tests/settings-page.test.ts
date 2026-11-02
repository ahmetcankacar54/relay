import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { moveItem, dropIndex } from "../src/pages/settings/MenuBarItems";
import { PrivacyNotes, Settings } from "../src/pages/Settings";
import { SETTINGS_TABS } from "../src/app/routes";

/** Every Settings tab, one after another: the page shows one at a time. */
const AllSettings = () =>
  createElement(Fragment, null, ...SETTINGS_TABS.map((tab) => createElement(Settings, { key: tab, tab })));
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type RelaySettings, type Snapshot } from "../shared/types";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const settings = { ...DEFAULT_SETTINGS, usageRefreshMinutes: 0 as const };

function relayFor(): Relay {
  return {
    api: {
      claudeLaunch: async () => ({ quicOff: false }),
      menuBarTitle: async () => ({ items: ["five-hour"] }),
    }, preview: false, error: "", notice: "", accounts: [], active: undefined, settings, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    version: "0.4.2",
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: { settings, usage: {}, accounts: [], authFlows: [], diagnostics: { platform: "darwin", version: "2.1.0" } } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, setData() {},
  } as unknown as Relay;
}

test("the system group offers the diagnostics files, and say which ones to send", async () => {
  const calls: string[] = [];
  const relay = relayFor();
  relay.api = { showDiagnostics: async () => void calls.push("show") } as unknown as Relay["api"];
  relay.action = (async (name: string, fn: () => Promise<unknown>) => {
    calls.push(name);
    await fn();
  }) as Relay["action"];
  const html = (language: "tr" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(RelayContext.Provider, { value: relay }, createElement(AllSettings)),
      ),
    );
  assert.match(
    html("tr"),
    /Tanılama dosyaları<\/label><p[^>]*text-muted-foreground[^>]*>Yalnızca draft-events\.json ve usage-issues\.json dosyalarını gönder; klasörün geri kalanında kayıtlı girişlerin var\.<\/p>(?:(?!<button)[\s\S])*<button[^>]*>Finder’da göster<\/button>/,
  );
  assert.match(
    html("en"),
    /Diagnostics files<\/label><p[^>]*>Send only draft-events\.json and usage-issues\.json; the rest of the folder holds your saved sign-ins\.<\/p>(?:(?!<button)[\s\S])*<button[^>]*>Show in Finder<\/button>/,
  );
  // The button asks main; main takes no path from the renderer.
  const { showDiagnostics } = await import("../src/pages/Settings");
  await showDiagnostics(relay);
  assert.deepEqual(calls, ["diagnostics", "show"]);
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /handle\("show-diagnostics", async \(\) => \{/);
  const handler = main.slice(main.indexOf('handle("show-diagnostics"'));
  assert.match(handler.slice(0, 600), /shell\.showItemInFolder\(/);
  assert.match(handler.slice(0, 600), /"draft-events\.json"/);
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /showDiagnostics: \(\) => ipcRenderer\.invoke\("relay:show-diagnostics"\)/);
});

test("Settings has six tabs: automation, what comes along, planning, notifications, appearance, advanced", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
      createElement(RelayContext.Provider, { value: relayFor() }, createElement(AllSettings)),
    ),
  );
  const tabs = /<div[^>]*role="tablist"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  assert.deepEqual(
    [...tabs.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]),
    ["Otomasyon", "Geçişte taşınanlar", "Planlama", "Bildirimler", "Görünüm", "Gelişmiş"],
  );
  for (const re of [
    /Görünüm/, /Sistem/, /Açık/, /Koyu/, /Arayüz dili/, /Türkçe/, /English/,
    /Menü çubuğu/, /Limitleri otomatik yenile/, /Elle/, /Gizlilik ve güvenlik/, /Bulundu/, /2\.1\.0/,
    // The path the missing-CLI error names: Ayarlar → Claude Code CLI → Dosyayı seç.
    /Claude Code CLI<\/[^>]+>(?:(?!<button)[\s\S])*?2\.1\.0(?:(?!<button)[\s\S])*?<button[^>]*>Dosyayı seç<\/button>/,
    /Yerelde saklanır\. Kontrol sende\./, /Bağımsız araç · 0\.\d+\.\d+/,
  ])
    assert.match(html, re);
});

test("Settings offers the menu bar animation switch, on unless turned off", () => {
  const render = (menuBarAnimation?: boolean) => {
    const relay = relayFor();
    const value = { ...settings, ...(menuBarAnimation === undefined ? {} : { menuBarAnimation }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  const on = render();
  assert.match(on, /Panda animasyonları/);
  assert.match(on, /Kapalıyken panda yalnızca ifade değiştirir/);
  assert.match(on, /role="switch"[^>]*aria-checked="true"/);
  assert.match(render(false), /role="switch"[^>]*aria-checked="false"/);
});

test("the menu bar animation switch is shown on macOS only", () => {
  const render = (platform: string) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform } } as Snapshot;
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, data } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  assert.match(render("darwin"), /Panda animasyonları/);
  for (const platform of ["win32", "linux"]) {
    const html = render(platform);
    assert.doesNotMatch(html, /Panda animasyonları/, platform);
    assert.doesNotMatch(html, /menu-bar-animation-label/, platform);
    assert.match(html, /Görünüm/, platform);
  }
});

test("Settings offers the switch window, on unless turned off, on macOS only", () => {
  const render = (extra: { switchWindow?: boolean; platform?: string } = {}) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform: extra.platform ?? "darwin" } } as Snapshot;
    const value = { ...settings, ...(extra.switchWindow === undefined ? {} : { switchWindow: extra.switchWindow }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value, data } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  const control = (html: string) => /<button[^>]*aria-labelledby="switch-window-label"[^>]*>/.exec(html)?.[0] ?? "";
  const on = render();
  assert.match(on, /Geçişte panda penceresini göster/);
  assert.match(on, /Claude uygulaması yeniden başlarken menü çubuğunun altında kısa bir sahne oynar\./);
  assert.match(control(on), /aria-checked="true"/);
  assert.match(control(render({ switchWindow: false })), /aria-checked="false"/);
  for (const platform of ["win32", "linux"])
    assert.doesNotMatch(render({ platform }), /Geçişte panda penceresini göster|switch-window-label/, platform);
});

test("Settings offers the panda pranks setting on every platform", () => {
  const render = (extra: { pranks?: "sometimes" | "rarely" | "off"; platform?: string } = {}) => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform: extra.platform ?? "darwin" } } as Snapshot;
    const value = { ...settings, ...(extra.pranks === undefined ? {} : { pranks: extra.pranks }) };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value, data } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  // The group labelled by the row's label id, then the item that is switched on inside it.
  const selected = (html: string) => {
    const group = /<div[^>]*aria-labelledby="panda-pranks-label"[^>]*>.*?<\/div>/s.exec(html)?.[0] ?? "";
    return [...group.matchAll(/<button[^>]*data-state="on"[^>]*>(.*?)<\/button>/gs)].map((m) => m[1]);
  };
  for (const platform of ["darwin", "win32", "linux"]) {
    const html = render({ platform });
    for (const re of [/Panda şakaları/, /Ara sıra/, /Nadiren/, /Kapalı/, /Seyrek şakalar; imleci kısa süre saklayabilir\./])
      assert.match(html, re, platform);
    assert.match(html, /id="panda-pranks-label"/, platform);
    assert.deepEqual(selected(html), ["Ara sıra"], platform);
    assert.deepEqual(selected(render({ platform, pranks: "off" })), ["Kapalı"], platform);
    assert.deepEqual(selected(render({ platform, pranks: "rarely" })), ["Nadiren"], platform);
  }
});

test("Settings shows the panda pranks setting in English", () => {
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "en", setLanguage() {}, t: (_tr: string, en: string) => en } },
      createElement(RelayContext.Provider, { value: relayFor() }, createElement(AllSettings)),
    ),
  );
  for (const re of [/Panda pranks/, />Sometimes</, />Rarely</, />Off</, /Rare pranks; it may briefly hide the cursor\./])
    assert.match(html, re);
});

test("Settings explains the Keychain prompt in Turkish and English, under privacy and security", () => {
  const render = (language: "tr" | "en", child: ReturnType<typeof createElement> = createElement(AllSettings)) =>
    renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(RelayContext.Provider, { value: relayFor() }, child),
      ),
    );
  const notes = (language: "tr" | "en") =>
    render(language, createElement(PrivacyNotes, { t: (tr: string, en: string) => (language === "tr" ? tr : en) }));
  const tr = notes("tr");
  const en = notes("en");
  const note = (html: string) => /<p class="[^"]*text-muted-foreground[^"]*">(Relay [^<]*(?:Anahtarlık|Keychain)[^<]*)<\/p>/.exec(html)?.[1];
  assert.equal(
    note(tr),
    "Relay kayıtlı girişleri macOS Anahtarlık’ta tuttuğu bir anahtarla şifreler. Yeni bir Relay sürümünden sonra macOS parolanı bir kez sorabilir; “Her Zaman İzin Ver”i seç.",
  );
  assert.equal(
    note(en),
    "Relay encrypts saved sign-ins with a key it keeps in the macOS Keychain. After a new Relay version, macOS may ask for your password once; choose “Always Allow”.",
  );
  // After the note on how sign-ins are kept; the three notes sit in one closed section.
  assert.ok(tr.indexOf("Limit okuma girişi resmi Claude Code") < tr.indexOf("Anahtarlık’ta tuttuğu bir anahtarla şifreler"));
  const page = render("tr");
  assert.match(page, /id="settings-privacy"[\s\S]*>Gizlilik ve güvenlik</);
  assert.doesNotMatch(page, /Anahtarlık’ta tuttuğu bir anahtarla şifreler/);
  assert.ok(page.indexOf("Gizlilik ve güvenlik") < page.indexOf("Yerelde saklanır"));
});

test("Settings → Notifications holds the warnings, their threshold and the refresh interval", async () => {
  const render = (extra: Partial<RelaySettings> = {}, language: "tr" | "en" = "tr") => {
    const relay = relayFor();
    const value = { ...settings, ...extra };
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(RelayContext.Provider, { value: { ...relay, settings: value } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  const group = (html: string) =>
    /<div[^>]*aria-labelledby="settings-threshold-label"[^>]*>.*?<\/div>/s.exec(html)?.[0] ?? "";
  const html = render();
  // One group: the warnings switch, then the threshold, then the refresh interval.
  assert.match(html, /id="settings-notifications"[\s\S]*id="usage-warnings"[\s\S]*id="settings-threshold-label">Uyarı eşiği<[\s\S]*Limitleri otomatik yenile/);
  assert.match(html, /Beş saatlik veya haftalık kullanım bu paya ulaşınca\./);
  assert.deepEqual(
    [...group(html).matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((m) => m[1]),
    ["%80", "%90", "%95"],
  );
  assert.match(group(html), /data-state="on"[^>]*>%90</);
  assert.match(group(render({ usageWarningPercent: 95 })), /data-state="on"[^>]*>%95</);
  assert.match(group(render({}, "en")), />80%<\/button>/);
  // With warnings off the threshold waits; the switch beside it turns them on.
  const off = render({ usageWarnings: false });
  assert.match(group(off), /<button[^>]*disabled=""/);
  assert.match(off, /id="usage-warnings"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="usage-warnings"/);

  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const updates: Partial<RelaySettings>[] = [];
    const relay = relayFor();
    relay.api = { ...relay.api, updateSettings: async (patch: Partial<RelaySettings>) => void updates.push(patch) } as unknown as Relay["api"];
    relay.action = (async (_name: string, fn: () => Promise<unknown>) => void (await fn())) as Relay["action"];
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
          createElement(RelayContext.Provider, { value: relay }, createElement(Settings, { tab: "bildirimler" })),
        ),
      ),
    );
    const item = find(dom.container as unknown as Fake, (n) => n.tagName === "button" && textOf(n) === "%95");
    assert.ok(item);
    await act(async () => dom.dispatch(item, "click", { detail: 1 }));
    assert.deepEqual(updates, [{ usageWarningPercent: 95 }]);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the system group shows how Relay starts Claude, and changes it through main", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    const calls: unknown[] = [];
    let choice = { quicOff: true };
    const relay = relayFor();
    relay.api = {
      ...relay.api,
      claudeLaunch: async () => choice,
      setClaudeLaunch: async (patch: object) => {
        calls.push(patch);
        choice = { ...choice, ...patch };
        return choice;
      },
    } as unknown as Relay["api"];
    relay.action = (async (_name: string, fn: () => Promise<unknown>) => void (await fn())) as Relay["action"];
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(
          I18nContext.Provider,
          { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
          createElement(RelayContext.Provider, { value: relay }, createElement(Settings, { tab: "gelismis" })),
        ),
      ),
    );
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) =>
      (n?.attributes as Map<string, string> | undefined)?.get(name);
    const byId = (id: string) => find(container, (n) => attr(n, "id") === id);
    assert.equal(attr(byId("claude-quic-off"), "aria-checked"), "true");
    await act(async () => dom.dispatch(byId("claude-quic-off")!, "click", { detail: 1 }));
    assert.deepEqual(calls, [{ quicOff: false }]);
    assert.equal(attr(byId("claude-quic-off"), "aria-checked"), "false");
    // Claude refuses to start with a net log, so there is no switch diagnosis to turn on.
    assert.equal(byId("switch-net-log"), undefined);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the menu bar group says what the title can show, on macOS only", () => {
  const render = (language: "tr" | "en", platform = "darwin") => {
    const relay = relayFor();
    const data = { ...relay.data!, diagnostics: { ...relay.data!.diagnostics, platform } } as Snapshot;
    return renderToStaticMarkup(
      createElement(
        I18nContext.Provider,
        { value: { language, setLanguage() {}, t: (tr: string, en: string) => (language === "tr" ? tr : en) } },
        createElement(RelayContext.Provider, { value: { ...relay, data } as Relay }, createElement(AllSettings)),
      ),
    );
  };
  const tr = render("tr");
  // First in the menu bar group, before the panda's own rows.
  assert.match(tr, /id="settings-menu-bar"[\s\S]*Menü çubuğunda göster[\s\S]*Panda animasyonları/);
  for (const re of [
    /5 saatlik kullanım/, /Haftalık kullanım/, /5 saatlik dönemin kalan süresi/, /Bugünkü token/,
    /Bugünkü API karşılığı/, /Hesap adı/,
    /Pandanın yanında en çok 4 değer seç ve sırala\./,
  ])
    assert.match(tr, re);
  // Each item shows a sample of what it puts in the title.
  assert.match(tr, /Bugünkü token ?<span[^>]*>12,4M<\/span>/);
  assert.match(tr, /Bugünkü API karşılığı ?<span[^>]*>\$18,20<\/span>/);
  assert.match(tr, /5 saatlik dönemin kalan süresi ?<span[^>]*>1:50<\/span>/);
  const en = render("en");
  for (const re of [/Show in the menu bar/, /Tokens today ?<span[^>]*>12\.4M<\/span>/, /API value today/, /up to 4 values beside the panda\./])
    assert.match(en, re);
  for (const platform of ["win32", "linux"])
    assert.doesNotMatch(render("tr", platform), /Menü çubuğunda göster/, platform);
});

/** Settings on a fake DOM, with the menu bar choice kept in `state` and `saved`. */
async function menuBarSettings(state: { items: string[]; now?: () => unknown }) {
  const dom = fakeDom();
  dom.install();
  readableText();
  const saved: string[][] = [];
  const relay = relayFor();
  relay.api = {
    ...relay.api,
    menuBarTitle: async () => ({ items: state.items }),
    setMenuBarTitle: async (choice: { items: string[] }) => {
      saved.push(choice.items);
      state.items = choice.items;
      return { items: state.items };
    },
    ...(state.now ? { menuBarNow: async () => state.now!() } : {}),
  } as unknown as Relay["api"];
  relay.action = (async (_name: string, fn: () => Promise<unknown>) => void (await fn())) as Relay["action"];
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.container as unknown as Element);
  await act(async () =>
    root.render(
      createElement(
        I18nContext.Provider,
        { value: { language: "tr", setLanguage() {}, t: (tr: string) => tr } },
        createElement(RelayContext.Provider, { value: relay }, createElement(Settings, { tab: "gorunum" })),
      ),
    ),
  );
  const container = dom.container as unknown as Fake;
  const attr = (n: Fake | undefined, name: string) =>
    (n?.attributes as Map<string, string> | undefined)?.get(name);
  const byId = (id: string) => find(container, (n) => attr(n, "id") === id);
  const shown = (node: Fake = container): string[] =>
    attr(node, "aria-labelledby") === "menu-bar-shown-label"
      ? node.childNodes.map((li) => attr(li, "data-item")!)
      : node.childNodes.flatMap((child) => shown(child));
  const handle = (item: string) =>
    find(container, (n) => n.tagName === "button" && /sıra\. Taşımak için sürükle/.test(attr(n, "aria-label") ?? "") && attr(n, "aria-label")!.startsWith(item));
  return {
    dom,
    root,
    saved,
    container,
    attr,
    byId,
    shown,
    handle,
    row: (item: string) =>
      find(container, (n) => n.tagName === "li" && attr(n, "data-item") === item && attr(n.parentNode as Fake, "aria-labelledby") === "menu-bar-shown-label"),
    preview: () => textOf(find(container, (n) => attr(n, "data-slot") === "menu-bar-preview")),
    live: () => textOf(find(container, (n) => attr(n, "aria-live") === "polite")),
    click: (node: Fake | undefined) => act(async () => dom.dispatch(node!, "click", { detail: 1 })),
    done: async () => {
      await act(async () => root.unmount());
      dom.uninstall();
    },
  };
}

test("the menu bar's values are added from the list below and listed in their order", async () => {
  const s = await menuBarSettings({ items: ["five-hour"] });
  try {
    // Until changed: the five-hour percent alone, on sample figures without a menu bar to read.
    assert.deepEqual(s.shown(), ["five-hour"]);
    assert.equal(s.preview(), "%40");
    await s.click(s.byId("menu-bar-add-tokens"));
    assert.deepEqual(s.saved, [["five-hour", "tokens"]]);
    assert.deepEqual(s.shown(), ["five-hour", "tokens"]);
    assert.equal(s.preview(), "%40 · 12,4M");
    assert.match(s.live(), /Bugünkü token 2\. sıraya eklendi/);
    // Added items leave the list below; four at most, then the rest wait.
    assert.equal(s.byId("menu-bar-add-tokens"), undefined);
    await s.click(s.byId("menu-bar-add-cost"));
    await s.click(s.byId("menu-bar-add-week"));
    assert.deepEqual(s.saved.at(-1), ["five-hour", "tokens", "cost", "week"]);
    assert.equal(s.attr(s.byId("menu-bar-add-account"), "disabled"), "");
    assert.match(textOf(s.container), /Eklemek için önce birini kaldır; en çok 4 değer/);
  } finally {
    await s.done();
  }
});

test("a row moves with Option-arrows on its handle, and the move is said", async () => {
  const s = await menuBarSettings({ items: ["five-hour", "tokens", "cost"] });
  try {
    const key = (item: string, key: string, altKey = true) =>
      act(async () => s.dom.dispatch(s.handle(item)!, "keydown", { key, altKey }));
    await key("Bugünkü token", "ArrowUp");
    assert.deepEqual(s.saved.at(-1), ["tokens", "five-hour", "cost"]);
    assert.match(s.live(), /Bugünkü token, 1\. sırada/);
    // The first goes no earlier; arrows without Option leave the order alone.
    await key("Bugünkü token", "ArrowUp");
    await key("Bugünkü token", "ArrowDown", false);
    assert.equal(s.saved.length, 1);
    await key("5 saatlik kullanım", "ArrowDown");
    assert.deepEqual(s.saved.at(-1), ["tokens", "cost", "five-hour"]);
  } finally {
    await s.done();
  }
});

test("a row dragged by its handle lands where the pointer leaves it", async () => {
  const s = await menuBarSettings({ items: ["five-hour", "tokens", "cost", "reset"] });
  try {
    // Rows 40 px tall, one under another.
    ["five-hour", "tokens", "cost", "reset"].forEach((item, i) => {
      (s.row(item) as unknown as { box: object }).box = { left: 0, top: 100 + i * 40, width: 400, height: 40 };
    });
    const grip = s.handle("5 saatlik dönemin kalan süresi")!;
    const pointer = (type: string, clientY: number) =>
      act(async () => s.dom.dispatch(grip, type, { button: 0, pointerId: 1, clientY }));
    await pointer("pointerdown", 240);
    // Halfway up the list, the rows it passes make room.
    await pointer("pointermove", 160);
    assert.match(String((s.row("tokens") as unknown as { style: Record<string, unknown> }).style.transform), /translateY\(40px\)/);
    await pointer("pointermove", 110);
    await pointer("pointerup", 110);
    assert.deepEqual(s.saved.at(-1), ["reset", "five-hour", "tokens", "cost"]);
  } finally {
    await s.done();
  }
});

test("with nothing chosen the menu bar shows the panda alone, and says so", async () => {
  const s = await menuBarSettings({ items: [] });
  try {
    assert.equal(s.preview(), "Yalnızca panda");
    assert.match(textOf(s.container), /Hiç değer seçili değil; menü çubuğunda yalnızca panda görünür\./);
  } finally {
    await s.done();
  }
});

test("moving a row and the drop under the pointer", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 2), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b"], 0, 5), ["a", "b"]);
  // Middles at 120, 160, 200, 240; the last dragged to 150 passes one row.
  assert.equal(dropIndex([120, 160, 200, 240], 3, 150), 1);
  assert.equal(dropIndex([120, 160, 200, 240], 0, 300), 3);
  assert.equal(dropIndex([120, 160, 200, 240], 1, 100), 0);
});

test("main keeps the menu bar title beside the registry and redraws it on a change", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /new MenuBarTitle\(path\.join\(app\.getPath\("userData"\), "menu-bar\.json"\)\)/);
  const handler = main.slice(main.indexOf('handle("set-menu-bar-title"'));
  assert.match(handler.slice(0, 500), /z\.array\(z\.enum\(MENU_BAR_ITEMS\)\)/);
  assert.match(handler.slice(0, 500), /\.strict\(\)/);
  assert.match(handler.slice(0, 500), /tray\?\.update\(\)/);
  // The tray reads the choice and today's figures; the figures come from the widget's ledger read.
  assert.match(main, /titleItems: menuBarTitle\?\.current\.items/);
  assert.match(main, /today: trayToday/);
  assert.match(main, /trayToday = complete/);
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /menuBarTitle: \(\) => ipcRenderer\.invoke\("relay:menu-bar-title"\)/);
  assert.match(preload, /setMenuBarTitle: \(choice\) => ipcRenderer\.invoke\("relay:set-menu-bar-title", choice\)/);
  // The registry's settings stay as they are: no schema change for an older CLI to refuse.
  const store = readFileSync(new URL("../electron/core/store.ts", import.meta.url), "utf8");
  assert.doesNotMatch(store, /menuBar(Title|Items)/);
});
