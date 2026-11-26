import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "../src/app/Sidebar";
import { Banners } from "../src/app/Banners";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account } from "../shared/types";
import { i18nValue, testT } from "./i18n";

const t = testT("tr");
const language = "tr";
// The shell owns the single TooltipProvider; the compact rail's tooltips need it.
const inShell = (child: ReturnType<typeof createElement>) =>
  createElement(TooltipProvider, null, child);

test("sidebar lists the pages, marks the current one and puts the automation dot on its page", () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      page: "ayarlar",
      go: () => {},
      t,
      language,
      compact: false,
      status: { accounts: 4, planning: true, switching: false },
      summary: { name: "Kişisel · Max", running: true, fiveHour: 38 },
    }),
  );
  for (const label of [
    "Genel bakış",
    "Hesaplar",
    "Geçiş",
    "Planlama",
    "Kullanım",
    "Ayarlar",
  ])
    assert.match(html, new RegExp(label));
  // Early start is on: the dot sits on Planning.
  assert.match(html, />Planlama<\/span><span data-status="on"/);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Ayarlar/);
  assert.match(html, />4</);
  assert.equal(html.match(/data-status="on"/g)?.length, 1);
  assert.match(html, /Kişisel · Max/);
});

test("compact sidebar keeps accessible names", () => {
  const html = renderToStaticMarkup(
    inShell(createElement(Sidebar, {
      page: "genel",
      go: () => {},
      t,
      language,
      compact: true,
      status: { accounts: 0, planning: false, switching: false },
    })),
  );
  assert.match(html, /aria-label="Ayarlar"/);
});

test("banners read an injected relay and offer reconnect for expired usage sign-ins", () => {
  const account = {
    id: "a1",
    name: "Vertex",
    kind: "work",
    group: "work:a1",
    color: "olive",
    createdAt: "2026-10-14T00:00:00Z",
    auth: { loggedIn: true, checkedAt: "2026-10-14T00:00:00Z" },
  } as Account;
  const relay = {
    preview: true,
    error: "",
    notice: "Kaydedildi",
    accounts: [account],
    settings: DEFAULT_SETTINGS,
    desktop: { recoveryRequired: false },
    desktopBusy: false,
    data: {
      usage: {
        a1: {
          accountId: "a1",
          status: "error",
          issue: "expired",
          stale: true,
          checkedAt: "2026-10-14T00:00:00Z",
        },
      },
      authFlows: [],
    },
  } as unknown as Relay;
  const i18n = i18nValue("tr");
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18n },
      createElement(
        RelayContext.Provider,
        { value: relay },
        createElement(Banners),
      ),
    ),
  );
  assert.match(html, /Tarayıcı önizlemesi/);
  assert.match(html, /Kaydedildi/);
  assert.match(html, /Vertex/);
  assert.match(html, /Limit okuma girişini yenile/);
});

test("sidebar buttons override the legacy centred button style and the summary card shows a five-hour bar", () => {
  const sidebar = (running: boolean) =>
    renderToStaticMarkup(
      createElement(Sidebar, {
        page: "genel",
        go: () => {},
        t,
        language,
        compact: false,
        status: { accounts: 2, planning: false, switching: false },
        summary: { name: "Kişisel · Max", running, fiveHour: 94 },
      }),
    );
  const html = sidebar(true);
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 10, "the pages, Proxy & Gateway, the summary card and Settings");
  for (const b of buttons) {
    const tag = /^<button[^>]*>/.exec(b)?.[0] ?? "";
    assert.match(tag, /class="[^"]*text-left/);
    assert.doesNotMatch(tag, /justify-center/);
  }
  // The nine pages start their row on the left.
  const pages = buttons.filter((b) => !b.includes("Kişisel · Max"));
  assert.equal(pages.length, 9);
  for (const b of pages) assert.match(b, /class="[^"]*justify-start[^"]*text-left/);
  // The summary card: the name, the percent line, then the same bar as every limit in Relay, inside
  // the card's button. The ring is gone.
  const summary = buttons.find((b) => b.includes("Kişisel · Max")) ?? "";
  assert.match(summary, /Kişisel · Max<\/b><\/span><span[^>]*>%94<\/span><div[^>]*role="meter" aria-label="5 saatlik dönem %94 kullanıldı"[^>]*aria-valuenow="94"><div[^>]*style="width:94%"/);
  assert.doesNotMatch(summary, /role="img"|style="width:32px;height:32px"/);
  // Without a relay to read the reset from, the line is the percent alone.
  assert.match(summary, />%94</);
  // One meter in the whole sidebar: the card's.
  assert.equal(html.match(/role="meter"/g)?.length, 1);
  // With Claude closed, the line says so after the percent.
  assert.match(sidebar(false), />%94 · Claude kapalı</);
});

const sidebarAccount = (id: string, name: string, linked: boolean) =>
  ({
    id,
    name,
    kind: "personal",
    group: "personal",
    color: "olive",
    createdAt: "2026-10-14T00:00:00Z",
    planning: { plan: "pro", capacityWeight: 1 },
    ...(linked && {
      desktop: { accountUuid: `${id}-uuid`, orgId: "org", savedAt: "2026-10-14T00:00:00Z" },
      auth: { loggedIn: true, email: `${id}@example.com`, checkedAt: "2026-10-14T00:00:00Z" },
    }),
  }) as Account;
const ready = sidebarAccount("a", "Kişisel · Max", true);
const unlinked = sidebarAccount("b", "Studio", false);
const sidebarRelay = (resetsAt: string) =>
  ({
    accounts: [ready, unlinked],
    active: ready,
    settings: DEFAULT_SETTINGS,
    desktop: { running: true },
    data: {
      usage: {
        a: { accountId: "a", status: "ready", stale: false, checkedAt: new Date().toISOString(), fiveHour: { usedPercent: 94, resetsAt } },
      },
      authFlows: [],
    },
  }) as unknown as Relay;
const withRelay = (relay: Relay, page: "genel" | "hesaplar", running = true, compact = false) =>
  renderToStaticMarkup(
    createElement(
      RelayContext.Provider,
      { value: relay },
      inShell(
        createElement(Sidebar, {
          page,
          go: () => {},
          t,
          language,
          compact,
          status: { accounts: 2, planning: false, switching: false },
          summary: { name: "Kişisel · Max", running, fiveHour: 94 },
        }),
      ),
    ),
  );

test("the summary card gives the five-hour window's time left after its percent", () => {
  const relay = sidebarRelay(new Date(Date.now() + 110 * 60_000).toISOString());
  assert.match(withRelay(relay, "genel"), />%94 · 1 sa 50 dk</);
  assert.match(withRelay(relay, "genel", false), />%94 · 1 sa 50 dk · Claude kapalı</);
  // A window already reset has no time left to show.
  assert.match(withRelay(sidebarRelay(new Date(Date.now() - 60_000).toISOString()), "genel"), />%94</);
});

test("the sidebar lists no accounts under Hesaplar, on the Accounts page or an account's page", () => {
  const relay = sidebarRelay(new Date(Date.now() + 3_600_000).toISOString());
  // The accounts are the Accounts page's list; the sidebar keeps its pages only.
  for (const html of [withRelay(relay, "genel"), withRelay(relay, "hesaplar"), withRelay(relay, "hesaplar", true, true)]) {
    assert.doesNotMatch(html, /href="#\/hesaplar\//);
    assert.doesNotMatch(html, /aria-label="Hesap listesi"/);
  }
  // Hesaplar is followed by the next page, with nothing in between; the usage page is "Limit geçmişi".
  const html = withRelay(relay, "hesaplar");
  assert.ok(html.indexOf("Hesaplar</span>") < html.indexOf("Limit geçmişi</span>"));
  assert.doesNotMatch(html, /Studio|· Claude uygulaması girişi yok/);
  // An open account's page marks nothing in the sidebar but the Hesaplar item.
  const g = globalThis as { window?: unknown };
  const saved = g.window;
  g.window = { location: { hash: "#/hesaplar/b" }, addEventListener() {}, removeEventListener() {} };
  try {
    const open = withRelay(relay, "hesaplar");
    assert.doesNotMatch(open, /<a [^>]*aria-current/);
    assert.match(open, /<button[^>]*aria-current="page"[^>]*>[\s\S]*?Hesaplar<\/span>/);
  } finally {
    g.window = saved;
  }
});

test("compact rail centres its icon buttons", () => {
  const html = renderToStaticMarkup(
    inShell(createElement(Sidebar, {
      page: "genel",
      go: () => {},
      t,
      language,
      compact: true,
      status: { accounts: 0, planning: false, switching: false },
    })),
  );
  for (const b of html.match(/<button[^>]*>/g) ?? [])
    assert.match(b, /justify-center/);
});

// Hidden `sr-only` labels are absolutely positioned. If the page scroller is not their containing
// block they escape it and stretch the window, which then scrolls the whole shell into empty space.
test("the page scroller contains absolutely positioned page content", () => {
  const shell = fs.readFileSync(path.join(import.meta.dirname, "../src/app/Shell.tsx"), "utf8");
  const main = shell.match(/<main\s+className="([^"]*)"/)?.[1].split(/\s+/) ?? [];
  assert.ok(main.includes("overflow-y-auto"));
  assert.ok(main.includes("relative"));
});

// A short fade between pages. The wrapper is keyed by the page so the animation replays on every switch,
// keeps the page's flex column so nothing shifts, and stands still when the system asks for less motion.
test("the shell fades the current page in inside a keyed wrapper; the page toolbar and the sidebar strip drag the window", () => {
  const shell = fs.readFileSync(path.join(import.meta.dirname, "../src/app/Shell.tsx"), "utf8");
  const wrapper = /<div\s+key=\{page\}\s+className="([^"]*)"\s*>/.exec(shell);
  assert.ok(wrapper, "pages sit in a <div key={page}> wrapper");
  const classes = wrapper[1].split(/\s+/);
  for (const c of ["flex", "flex-1", "flex-col", "animate-in", "fade-in-0", "duration-150", "motion-reduce:animate-none"])
    assert.ok(classes.includes(c), c);
  const open = wrapper.index;
  const close = shell.indexOf("</div>", shell.indexOf("{page === \"ayarlar\""));
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "../src/app", file), "utf8");
  assert.match(read("PageHeader.tsx"), /data-slot="toolbar"[\s\S]*data-tauri-drag-region="deep"[\s\S]*sticky top-0/);
  assert.match(read("Sidebar.tsx"), /data-tauri-drag-region="deep" className="relative h-13 w-full shrink-0"/);
  for (const page of ["genel", "hesaplar", "kullanim", "ayarlar"]) {
    const at = shell.indexOf(`{page === "${page}"`);
    assert.ok(at > open && at < close, `${page} renders inside the wrapper`);
  }
});

// <main> is the page scroller and outlives the page, so it would keep the old page's scroll position.
test("the shell starts each page at the top by resetting the scroller when the page changes", () => {
  const shell = fs.readFileSync(path.join(import.meta.dirname, "../src/app/Shell.tsx"), "utf8");
  assert.match(shell, /<main\s+className="[^"]*"\s+ref=\{mainRef\}/);
  assert.match(shell, /useRef<HTMLElement>\(null\)/);
  assert.match(
    shell,
    /useLayoutEffect\(\(\) => \{\s*if \(mainRef\.current\) mainRef\.current\.scrollTop = 0;\s*\}, \[page\]\);/,
  );
});

test("muted text keeps AA contrast on the page, cards and muted grounds in light and dark", () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, "../src/styles/theme.css"), "utf8");
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
  assert.match(light, /--muted-foreground:\s*#645e58;/);
  assert.match(dark, /--muted-foreground:\s*#958e87;/);
  const token = (block: string, name: string) => {
    const hex = new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i").exec(block)?.[1];
    assert.ok(hex, name);
    return hex;
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const [scheme, block] of [["light", light], ["dark", dark]] as const) {
    const muted = token(block, "muted-foreground");
    for (const ground of ["background", "card", "popover", "muted", "sidebar"])
      assert.ok(contrast(muted, token(block, ground)) >= 4.5, `${scheme} muted text on --${ground}`);
  }
});
