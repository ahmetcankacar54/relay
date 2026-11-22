// Migration helper: adds (or replaces) messages in every catalog, sorted by id. Until a locale is
// translated it gets the English text. Input: a JSON file of { "<id>": { "en": "…", "tr": "…" } }.
// Run: node --import tsx scripts/i18n/add.ts messages.json   (--remove id1,id2 deletes ids)
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LOCALES } from "../../shared/i18n/locales";

const ROOT = path.resolve(import.meta.dirname, "../..");
const file = (locale: string) => path.join(ROOT, "shared/i18n/catalogs", `${locale}.ts`);
const args = process.argv.slice(2);
const removeAt = args.indexOf("--remove");
const remove = new Set(removeAt >= 0 ? args[removeAt + 1].split(",") : []);
const input: Record<string, { en: string; tr: string }> =
  removeAt === 0 ? {} : JSON.parse(readFileSync(args[0], "utf8"));
const translated = new Set(LOCALES.filter((l) => l === "tr" || (l !== "en" && !readFileSync(file(l), "utf8").includes("Not translated yet"))));

for (const locale of LOCALES) {
  const text = readFileSync(file(locale), "utf8");
  const lines = text.split("\n");
  const first = lines.findIndex((l) => /^  "/.test(l));
  let last = first;
  while (/^  "/.test(lines[last + 1] ?? "")) last++;
  const entries = new Map<string, string>();
  for (const line of first < 0 ? [] : lines.slice(first, last + 1)) {
    const id = JSON.parse(line.slice(2, line.indexOf('":') + 1));
    entries.set(id, line);
  }
  for (const id of remove) entries.delete(id);
  for (const [id, m] of Object.entries(input)) {
    const value = locale === "tr" ? m.tr : locale === "en" || !translated.has(locale) ? m.en : undefined;
    if (value === undefined && !entries.has(id)) throw new Error(`${locale} is translated: add ${id} there by hand`);
    if (value !== undefined) entries.set(id, `  ${JSON.stringify(id)}: ${JSON.stringify(value)},`);
  }
  const sorted = [...entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, l]) => l);
  const out = [...lines.slice(0, first), ...sorted, ...lines.slice(last + 1)].join("\n");
  writeFileSync(file(locale), out);
}
console.log(`${Object.keys(input).length} added, ${remove.size} removed`);
