import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Private } from "../src/components/Private";
import { I18nContext, type T } from "../src/data/i18n";
import { fakeDom, find, readableText, type Fake } from "./fake-dom";

const t: T = (tr: string) => tr;
const wrap = (child: ReturnType<typeof createElement>) =>
  createElement(I18nContext.Provider, { value: { language: "tr", setLanguage() {}, t } }, child);

test("an account detail starts blurred, with a hidden-text label and the text kept for search", () => {
  const html = renderToStaticMarkup(wrap(createElement(Private, null, "a@example.com")));
  assert.match(html, /data-private="hidden"/);
  assert.match(html, /blur-\[5px\]/);
  assert.match(html, /select-none/);
  assert.match(html, /Gizli bilgi, göstermek için tıkla/);
  assert.match(html, /aria-hidden="true">a@example\.com</);
  // Nothing to hide: nothing is wrapped.
  assert.equal(renderToStaticMarkup(wrap(createElement(Private, null, ""))), "");
});

test("a click shows it, another hides it, and the click stays out of the row", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  try {
    let rowClicks = 0;
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        wrap(createElement("div", { onClick: () => rowClicks++ }, createElement(Private, null, "a@example.com"))),
      ),
    );
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake | undefined, name: string) => (n?.attributes as Map<string, string> | undefined)?.get(name);
    const el = () => find(container, (n) => attr(n, "data-private") !== undefined);
    await act(async () => dom.dispatch(el()!, "click", { detail: 1 }));
    assert.equal(attr(el(), "data-private"), "shown");
    assert.equal(rowClicks, 0);
    await act(async () => dom.dispatch(el()!, "click", { detail: 1 }));
    assert.equal(attr(el(), "data-private"), "hidden");
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("turned off in Settings, details show plainly", async () => {
  const store = new Map<string, string>([["relay.privacy.blur", "off"]]);
  const g = globalThis as unknown as { window?: unknown };
  const previous = g.window;
  g.window = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    addEventListener() {},
    removeEventListener() {},
  };
  try {
    assert.equal(renderToStaticMarkup(wrap(createElement(Private, null, "a@example.com"))), "a@example.com");
  } finally {
    g.window = previous;
  }
  const settings = fs.readFileSync(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /Hesap bilgilerini bulanıklaştır[\s\S]*?<Switch id="privacy-blur" checked=\{privacyBlur\}/);
});

test("the places that show an account's e-mail blur it", () => {
  const read = (path: string) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
  for (const [path, pattern] of [
    ["pages/accounts/AccountsTable.tsx", /<Private>\{a\.desktop\?\.email \?\? a\.auth\?\.email\}<\/Private>/],
    ["pages/accounts/AccountDetail.tsx", /<Private>\{\[email, a\.auth\?\.orgName\]/],
    ["pages/overview/ActiveAccountCard.tsx", /<Private>\{identity\}<\/Private>/],
    ["pages/Proxy.tsx", /<Private>\{account\.email\}<\/Private>/],
    ["app/ConnectionPanels.tsx", /<Private>\{flowAccount\.auth\.email\}<\/Private>/],
  ] as const)
    assert.match(read(path), pattern, path);
});

test("Copy goes through main: the window's clipboard API is refused in Relay's windows", () => {
  const main = fs.readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /handle\("copy-text", \(text\) => \{\s*clipboard\.writeText\(z\.string\(\)\.max\(16_384\)\.parse\(text\)\);/);
  const preload = fs.readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /copyText: \(text\) => ipcRenderer\.invoke\("relay:copy-text", text\)/);
  const proxy = fs.readFileSync(new URL("../src/pages/Proxy.tsx", import.meta.url), "utf8");
  assert.match(proxy, /api\.copyText\(text\)/);
  assert.doesNotMatch(proxy, /navigator\.clipboard/);
});
