import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { IntlMessageFormat } from "intl-messageformat";
import { CATALOGS } from "../shared/i18n/catalogs/all";
import { en } from "../shared/i18n/catalogs/en";
import { LOCALES, matchLocale, resolveLocale } from "../shared/i18n/locales";

type Element = { type: number; value?: string; options?: Record<string, { value: Element[] }> };
/** The argument names a message uses, plural and select branches included. */
function argumentsOf(message: string, locale: string) {
  const names = new Set<string>();
  const walk = (elements: Element[]) => {
    for (const element of elements) {
      if (element.value && element.type !== 0 && element.type !== 7) names.add(element.value);
      for (const option of Object.values(element.options ?? {})) walk(option.value);
    }
  };
  walk(new IntlMessageFormat(message, locale, undefined, { ignoreTag: true }).getAst() as Element[]);
  return names;
}
const variants = (name: string) => [name, `${name}Dative`, `${name}Locative`];

test("every catalog has exactly the English ids and no empty message", () => {
  const ids = Object.keys(en).sort();
  for (const locale of LOCALES) {
    const catalog = CATALOGS[locale];
    assert.deepEqual(Object.keys(catalog).sort(), ids, locale);
    for (const [id, message] of Object.entries(catalog)) assert.ok(message.trim(), `${locale} ${id} is empty`);
  }
});

test("every message parses and keeps the English placeholders", () => {
  for (const locale of LOCALES) {
    for (const [id, message] of Object.entries(CATALOGS[locale]) as [keyof typeof en, string][]) {
      const source = argumentsOf(en[id], "en");
      let own: Set<string>;
      try {
        own = argumentsOf(message, locale);
      } catch (error) {
        assert.fail(`${locale} ${id} does not parse: ${String(error)}`);
      }
      for (const name of source)
        assert.ok(variants(name).some((v) => own.has(v)), `${locale} ${id} drops {${name}}`);
      for (const name of own)
        assert.ok(
          [...source].some((s) => variants(s).includes(name)),
          `${locale} ${id} adds {${name}}, which the code never passes`,
        );
      if (/,\s*plural\s*,/.test(message)) assert.match(message, /other\s*\{/, `${locale} ${id} plural lacks other`);
    }
  }
});

const ROOT = path.resolve(import.meta.dirname, "..");
function sources(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const code = ["src", "shared", "electron", "cli/src"].flatMap((d) => sources(path.join(ROOT, d)));

test("no inline Turkish/English pairs or language forks are left", () => {
  const pair = /\bt\(\s*["`][^"`]*["`]\s*,\s*["`]/;
  const fork = /===\s*"tr"|"tr"\s*\?|\btr\s*\?\s*["`]/;
  const allowed = (file: string) => file.includes(`${path.sep}shared${path.sep}i18n${path.sep}`) || file.endsWith("tr-dative.ts");
  const found: string[] = [];
  for (const file of code) {
    if (allowed(file)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pair.test(line) || fork.test(line)) found.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(found, []);
});

test("backend errors are thrown in English", () => {
  const turkish = /throw new Error\(\s*["`][^"`]*[çğıöşüÇĞİÖŞÜ]/;
  const found = code
    .filter((f) => f.includes(`${path.sep}electron${path.sep}`))
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (turkish.test(line) ? [`${path.relative(ROOT, file)}:${i + 1}`] : [])),
    );
  assert.deepEqual(found, []);
});

test("system languages resolve to the supported ones", () => {
  assert.equal(resolveLocale("system", ["de-AT"]), "de");
  assert.equal(resolveLocale("system", ["zh-TW"]), "zh-Hant");
  assert.equal(resolveLocale("system", ["zh-CN"]), "zh-Hans");
  assert.equal(resolveLocale("system", ["zh-Hant-HK"]), "zh-Hant");
  assert.equal(resolveLocale("system", ["pt-PT"]), "pt-BR");
  assert.equal(resolveLocale("system", ["xx", "fr-CA"]), "fr");
  assert.equal(resolveLocale("system", ["xx"]), "en");
  assert.equal(resolveLocale("ja", ["tr"]), "ja");
  assert.equal(resolveLocale(undefined, []), "en");
  assert.equal(matchLocale("tr_TR.UTF-8"), "tr");
  assert.equal(matchLocale("C"), undefined);
});
