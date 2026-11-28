import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * Shared code shows the user only catalog messages: a Turkish string literal
 * there is a message an English reader would see untranslated. Comments are not literals and are
 * not scanned; the catalogs are where every language lives. What remains is listed with its reason.
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;
const SKIPPED_DIRS = new Set([
  path.join("shared", "i18n", "catalogs"),
  "node_modules",
]);

/** Whole files whose Turkish literals are data, not messages. */
const ALLOWED_FILES: Record<string, string> = {
  "shared/error-text.ts":
    "lookup keys: the Turkish texts older builds threw or saved, mapped to catalog messages",
  "shared/tr-dative.ts":
    "Turkish grammar (dative suffixes and number words) for the tr catalog",
};
/** Single literals, by file and exact text. */
const ALLOWED_LITERALS: [file: string, text: string, why: string][] = [
  [
    "shared/i18n/locales.ts",
    "Türkçe",
    "each language's name in its own words, for the picker",
  ],
  [
    "shared/i18n/locales.ts",
    "Français",
    "each language's name in its own words, for the picker",
  ],
  [
    "shared/i18n/translate.ts",
    "ö",
    "pseudo-localization accents for the development preview",
  ],
  [
    "shared/i18n/translate.ts",
    "ü",
    "pseudo-localization accents for the development preview",
  ],
  [
    "shared/i18n/translate.ts",
    "Ö",
    "pseudo-localization accents for the development preview",
  ],
  [
    "shared/i18n/translate.ts",
    "Ü",
    "pseudo-localization accents for the development preview",
  ],
  [
    "shared/time-zones.ts",
    "/[İıI]/g",
    "folds both Turkish I forms in the time zone search",
  ],
];

function sources(dir: string, out: string[] = []) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) {
      if (!SKIPPED_DIRS.has(rel) && name !== "node_modules") sources(rel, out);
    } else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** Every string, template and regular expression literal of a file that holds a Turkish letter. */
function turkishLiterals(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    let text: string | undefined;
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      text = node.text;
    else if (ts.isRegularExpressionLiteral(node)) text = node.text;
    if (text !== undefined && TURKISH.test(text))
      found.push({
        text,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = sources("shared").map((f) => f.split(path.sep).join("/"));

test("shared holds no Turkish string literals outside the catalogs and the allow-list", () => {
  const found: string[] = [];
  for (const file of files) {
    if (file in ALLOWED_FILES) continue;
    for (const { text, line } of turkishLiterals(file))
      if (!ALLOWED_LITERALS.some(([f, t]) => f === file && t === text))
        found.push(`${file}:${line}: ${text.slice(0, 100)}`);
  }
  assert.deepEqual(found, []);
});

test("every allow-list entry still matches a literal, so the list never outlives its reason", () => {
  for (const file of Object.keys(ALLOWED_FILES))
    assert.ok(files.includes(file), `${file} is gone`);
  for (const [file, text] of ALLOWED_LITERALS)
    assert.ok(
      turkishLiterals(file).some((l) => l.text === text),
      `${file} no longer holds ${text}`,
    );
});
