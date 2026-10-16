import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "../src/app/Sidebar";
import { LimitMeter } from "../src/components/LimitMeter";
import { Banners } from "../src/app/Banners";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account } from "../shared/types";

const t = (tr: string) => tr;
// The shell owns the single TooltipProvider; the compact rail's tooltips need it.
const inShell = (child: ReturnType<typeof createElement>) =>
  createElement(TooltipProvider, null, child);

test("sidebar lists the six pages, marks the current one and shows automation dots", () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      page: "planlama",
      go: () => {},
      t,
      compact: false,
      status: { accounts: 4, planning: true, switching: false },
      summary: { name: "Kişisel · Max", running: true, fiveHour: 38 },
    }),
  );
  for (const label of [
    "Genel bakış",
    "Hesaplar",
    "Kullanım",
    "Planlama",
    "Geçiş",
    "Ayarlar",
  ])
    assert.match(html, new RegExp(label));
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Planlama/);
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
      compact: true,
      status: { accounts: 0, planning: false, switching: false },
    })),
  );
  assert.match(html, /aria-label="Planlama"/);
});

test("limit meter shows the percent and uses the tone colour", () => {
  const html = renderToStaticMarkup(
    createElement(LimitMeter, {
      label: "Haftalık",
      percent: 78,
      detail: "4 gün",
    }),
  );
  assert.match(html, /%78/);
  assert.match(html, /bg-warn/);
  assert.match(html, /role="meter"/);
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
    },
  } as unknown as Relay;
  const i18n = {
    language: "tr" as const,
    setLanguage() {},
    t: (tr: string) => tr,
  };
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
  assert.match(html, /Yeniden bağlan/);
});

test("sidebar buttons override the legacy centred button style and keep the meter outside buttons", () => {
  const html = renderToStaticMarkup(
    createElement(Sidebar, {
      page: "genel",
      go: () => {},
      t,
      compact: false,
      status: { accounts: 2, planning: false, switching: false },
      summary: { name: "Kişisel · Max", running: true, fiveHour: 94 },
    }),
  );
  const buttons = html.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.equal(buttons.length, 7);
  for (const b of buttons) {
    assert.match(b, /class="[^"]*justify-start[^"]*text-left/);
    assert.doesNotMatch(b, /role="meter"/);
  }
  assert.match(html, /role="meter"/);
});

test("compact rail centres its icon buttons", () => {
  const html = renderToStaticMarkup(
    inShell(createElement(Sidebar, {
      page: "genel",
      go: () => {},
      t,
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
  const main = shell.match(/<main className="([^"]*)"/)?.[1].split(/\s+/) ?? [];
  assert.ok(main.includes("overflow-y-auto"));
  assert.ok(main.includes("relative"));
});
