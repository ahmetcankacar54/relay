import test from "node:test";
import assert from "node:assert/strict";
import { PAGES, parseRoute, routeHash, shortcutPage } from "../src/app/routes";

test("hashes map to pages and unknown ones fall back to the overview", () => {
  assert.deepEqual(PAGES, ["genel", "hesaplar", "kullanim", "planlama", "gecis", "ayarlar"]);
  for (const page of PAGES) assert.equal(parseRoute(routeHash(page)), page);
  assert.equal(parseRoute(""), "genel");
  assert.equal(parseRoute("#/yok"), "genel");
  assert.equal(parseRoute("#/planlama?x=1"), "planlama");
});

test("command-number shortcuts open pages in sidebar order and command-comma opens settings", () => {
  const key = (k: string, metaKey = true) => ({ key: k, metaKey, ctrlKey: false });
  assert.equal(shortcutPage(key("1")), "genel");
  assert.equal(shortcutPage(key("5")), "gecis");
  assert.equal(shortcutPage(key(",")), "ayarlar");
  assert.equal(shortcutPage(key("6")), undefined);
  assert.equal(shortcutPage(key("1", false)), undefined);
  assert.equal(shortcutPage({ key: "2", metaKey: false, ctrlKey: true }), "hesaplar");
});
