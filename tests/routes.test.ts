import test from "node:test";
import assert from "node:assert/strict";
import { NAV_PAGES, PAGES, SETTINGS_TABS, parseRoute, routeHash, settingsTab, shortcutPage } from "../src/app/routes";

test("hashes map to the sidebar's pages; former Settings tabs open their pages, unknown ones the overview", () => {
  // Another window may still name every page id.
  assert.deepEqual(PAGES, ["genel", "hesaplar", "kullanim", "tokenlar", "rozetler", "planlama", "gecis", "ayarlar"]);
  assert.deepEqual(NAV_PAGES, ["genel", "hesaplar", "gecis", "planlama", "kullanim", "tokenlar", "rozetler", "ayarlar"]);
  for (const page of NAV_PAGES) assert.equal(parseRoute(routeHash(page)), page);
  assert.equal(parseRoute(""), "genel");
  assert.equal(parseRoute("#/yok"), "genel");
  assert.equal(parseRoute("#/planlama?x=1"), "planlama");
  assert.equal(parseRoute("#/gecis"), "gecis");
  // Links from older builds and notices to the former Settings tabs land on the pages.
  for (const tab of ["gecis", "otomasyon", "tasinanlar", "bildirimler"])
    assert.equal(parseRoute(`#/ayarlar/${tab}`), "gecis", tab);
  assert.equal(parseRoute("#/ayarlar/planlama"), "planlama");
  assert.equal(parseRoute("#/ayarlar/gelismis"), "ayarlar");
});

test("Settings' tab comes from the hash, a former tab's new tab, or the first", () => {
  assert.deepEqual(SETTINGS_TABS, ["genel", "gelismis"]);
  assert.equal(settingsTab("#/ayarlar/gelismis"), "gelismis");
  assert.equal(settingsTab("#/ayarlar"), "genel");
  assert.equal(settingsTab("#/ayarlar/yok"), "genel");
  assert.equal(settingsTab("#/ayarlar/gorunum"), "genel");
  assert.equal(routeHash("ayarlar/gelismis"), "#/ayarlar/gelismis");
});

test("command-number shortcuts open pages in sidebar order and command-comma opens settings", () => {
  const key = (k: string, metaKey = true) => ({ key: k, metaKey, ctrlKey: false });
  assert.equal(shortcutPage(key("1")), "genel");
  assert.equal(shortcutPage(key("3")), "gecis");
  assert.equal(shortcutPage(key("7")), "rozetler");
  assert.equal(shortcutPage(key(",")), "ayarlar");
  assert.equal(shortcutPage(key("8")), undefined);
  assert.equal(shortcutPage(key("1", false)), undefined);
  assert.equal(shortcutPage({ key: "2", metaKey: false, ctrlKey: true }), "hesaplar");
});
