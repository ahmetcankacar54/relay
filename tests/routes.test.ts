import test from "node:test";
import assert from "node:assert/strict";
import { NAV_PAGES, PAGES, SETTINGS_TABS, parseRoute, routeHash, settingsTab, shortcutPage } from "../src/app/routes";

test("hashes map to the sidebar's pages; the former pages open Settings, unknown ones the overview", () => {
  // Another window may still name every former page id.
  assert.deepEqual(PAGES, ["genel", "hesaplar", "proxy", "kullanim", "tokenlar", "rozetler", "planlama", "gecis", "ayarlar"]);
  assert.deepEqual(NAV_PAGES, ["genel", "hesaplar", "kullanim", "tokenlar", "rozetler", "proxy", "ayarlar"]);
  for (const page of NAV_PAGES) assert.equal(parseRoute(routeHash(page)), page);
  assert.equal(parseRoute(""), "genel");
  assert.equal(parseRoute("#/yok"), "genel");
  assert.equal(parseRoute("#/planlama?x=1"), "ayarlar");
  assert.equal(parseRoute("#/gecis"), "ayarlar");
  assert.equal(parseRoute("#/ayarlar/gecis"), "ayarlar");
});

test("the gateway is a top-level page; the old Settings link and tab hash land on it", () => {
  assert.ok((PAGES as readonly string[]).includes("proxy"));
  assert.ok((NAV_PAGES as readonly string[]).includes("proxy"));
  assert.equal(parseRoute("#/proxy"), "proxy");
  assert.equal(parseRoute("#/ayarlar/proxy"), "proxy");
  assert.equal(parseRoute("#/ayarlar/proxy?x=1"), "proxy");
  assert.equal(parseRoute(routeHash("proxy")), "proxy");
  // Settings itself still opens Settings, and an unknown tab still opens its first tab.
  assert.equal(parseRoute("#/ayarlar/gelismis"), "ayarlar");
  assert.equal(settingsTab("#/ayarlar/proxy"), "gecis");
});

test("Settings' tab comes from the hash, a former page's own tab, or the first", () => {
  assert.deepEqual(SETTINGS_TABS, ["gecis", "planlama", "genel", "gelismis"]);
  assert.equal(settingsTab("#/ayarlar/gelismis"), "gelismis");
  assert.equal(settingsTab("#/gecis"), "gecis");
  assert.equal(settingsTab("#/planlama"), "planlama");
  assert.equal(settingsTab("#/ayarlar"), "gecis");
  assert.equal(settingsTab("#/ayarlar/yok"), "gecis");
  // The former tabs, from older builds, notices and links, open the tab that holds them now.
  assert.equal(settingsTab("#/ayarlar/otomasyon"), "gecis");
  assert.equal(settingsTab("#/ayarlar/tasinanlar"), "gecis");
  assert.equal(settingsTab("#/ayarlar/bildirimler"), "gecis");
  assert.equal(settingsTab("#/ayarlar/gorunum"), "genel");
  assert.equal(routeHash("ayarlar/gecis"), "#/ayarlar/gecis");
});

test("command-number shortcuts open pages in sidebar order and command-comma opens settings", () => {
  const key = (k: string, metaKey = true) => ({ key: k, metaKey, ctrlKey: false });
  assert.equal(shortcutPage(key("1")), "genel");
  // The gateway's page came after the usage pages, so ⌘3–⌘5 kept their pages.
  assert.equal(shortcutPage(key("3")), "kullanim");
  assert.equal(shortcutPage(key("5")), "rozetler");
  assert.equal(shortcutPage(key("6")), "proxy");
  assert.equal(shortcutPage(key(",")), "ayarlar");
  assert.equal(shortcutPage(key("7")), undefined);
  assert.equal(shortcutPage(key("1", false)), undefined);
  assert.equal(shortcutPage({ key: "2", metaKey: false, ctrlKey: true }), "hesaplar");
});
