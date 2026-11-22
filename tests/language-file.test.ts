import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANGUAGE_FILE, loadLanguagePref, readLanguagePref, writeLanguagePref } from "../electron/core/language-file";

const folder = (t: { after(fn: () => void): void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-language-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("the choice is written to language.json, readable only by the user, and read back", (t) => {
  const dir = folder(t);
  writeLanguagePref(dir, "de");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, LANGUAGE_FILE), "utf8")), { pref: "de" });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, LANGUAGE_FILE)).mode & 0o777, 0o600);
  assert.equal(readLanguagePref(dir), "de");
  writeLanguagePref(dir, "system");
  assert.equal(readLanguagePref(dir), "system");
  assert.deepEqual(fs.readdirSync(dir), [LANGUAGE_FILE]);
});

test("a first start keeps Turkish for an install with accounts, the system's language for a new one", (t) => {
  const existing = folder(t);
  assert.equal(loadLanguagePref(existing, true), "tr");
  assert.equal(readLanguagePref(existing), "tr");
  const fresh = folder(t);
  assert.equal(loadLanguagePref(fresh, false), "system");
  assert.equal(readLanguagePref(fresh), "system");
  // A saved choice wins over the migration.
  assert.equal(loadLanguagePref(existing, false), "tr");
});

test("a missing or invalid file is no choice, and the migration replaces it", (t) => {
  const dir = folder(t);
  assert.equal(readLanguagePref(dir), undefined);
  fs.writeFileSync(path.join(dir, LANGUAGE_FILE), '{"pref":"xx"}');
  assert.equal(readLanguagePref(dir), undefined);
  fs.writeFileSync(path.join(dir, LANGUAGE_FILE), "not json");
  assert.equal(loadLanguagePref(dir, true), "tr");
  assert.equal(readLanguagePref(dir), "tr");
});
