import test from "node:test";
import assert from "node:assert/strict";
import { latestChoice, loadOrEnglish } from "../src/data/i18n";
import type { Locale } from "../shared/i18n/locales";

test("a catalog that cannot load boots the window in English", async () => {
  assert.equal(await loadOrEnglish("tr", async () => {}), "tr");
  assert.equal(await loadOrEnglish("tr", async () => { throw new Error("chunk failed"); }), "en");
});

test("only the latest of two quick language changes applies, and a failed load changes nothing", async () => {
  const pending = new Map<Locale, { resolve(): void; reject(e: Error): void }>();
  const pick = latestChoice((locale) => new Promise<void>((resolve, reject) => void pending.set(locale, { resolve, reject })));
  const applied: Locale[] = [];
  const settle = () => new Promise((r) => setImmediate(r));
  pick("tr", (l) => void applied.push(l));
  pick("de", (l) => void applied.push(l));
  // The later choice's catalog arrives first, the earlier one's after it.
  pending.get("de")!.resolve();
  await settle();
  pending.get("tr")!.resolve();
  await settle();
  assert.deepEqual(applied, ["de"]);
  pick("fr", (l) => void applied.push(l));
  pending.get("fr")!.reject(new Error("chunk failed"));
  await settle();
  assert.deepEqual(applied, ["de"]);
});
