import test from "node:test";
import assert from "node:assert/strict";
import { NAV_PAGES, PAGES, SETTINGS_TABS, parseRoute, routeHash, settingsTab, shortcutPage } from "../src/app/routes";

test("hashes map to the sidebar's pages; the former pages open Settings, unknown ones the overview", () => {
  // Another window may still name every former page id.
  assert.deepEqual(PAGES, ["genel", "hesaplar", "kullanim", "planlama", "gecis", "ayarlar"]);
  assert.deepEqual(NAV_PAGES, ["genel", "hesaplar", "kullanim", "ayarlar"]);
  for (const page of NAV_PAGES) assert.equal(parseRoute(routeHash(page)), page);
  assert.equal(parseRoute(""), "genel");
  assert.equal(parseRoute("#/yok"), "genel");
  assert.equal(parseRoute("#/planlama?x=1"), "ayarlar");
  assert.equal(parseRoute("#/gecis"), "ayarlar");
  assert.equal(parseRoute("#/ayarlar/tasinanlar"), "ayarlar");
});

test("Settings' tab comes from the hash, a former page's own tab, or the first", () => {
  assert.deepEqual(SETTINGS_TABS, ["otomasyon", "tasinanlar", "planlama", "bildirimler", "gorunum", "gelismis"]);
  assert.equal(settingsTab("#/ayarlar/gelismis"), "gelismis");
  assert.equal(settingsTab("#/gecis"), "otomasyon");
  assert.equal(settingsTab("#/planlama"), "planlama");
  assert.equal(settingsTab("#/ayarlar"), "otomasyon");
  assert.equal(settingsTab("#/ayarlar/yok"), "otomasyon");
  assert.equal(routeHash("ayarlar/tasinanlar"), "#/ayarlar/tasinanlar");
});

test("command-number shortcuts open pages in sidebar order and command-comma opens settings", () => {
  const key = (k: string, metaKey = true) => ({ key: k, metaKey, ctrlKey: false });
  assert.equal(shortcutPage(key("1")), "genel");
  assert.equal(shortcutPage(key("3")), "kullanim");
  assert.equal(shortcutPage(key(",")), "ayarlar");
  assert.equal(shortcutPage(key("4")), undefined);
  assert.equal(shortcutPage(key("1", false)), undefined);
  assert.equal(shortcutPage({ key: "2", metaKey: false, ctrlKey: true }), "hesaplar");
});
