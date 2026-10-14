import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Sidebar } from "../src/app/Sidebar";
import { LimitMeter } from "../src/components/LimitMeter";
import { Banners } from "../src/app/Banners";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account } from "../shared/types";

const t = (tr: string) => tr;

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
    createElement(Sidebar, {
      page: "genel",
      go: () => {},
      t,
      compact: true,
      status: { accounts: 0, planning: false, switching: false },
    }),
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
