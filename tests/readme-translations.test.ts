import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/** The English README and its translations, in the order of the language line. */
const READMES = ["README.md", "README.tr.md", "README.zh-CN.md", "README.ja.md", "README.ko.md", "README.es.md"];
const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

/** Markdown headings outside code blocks, as `level text`. */
function headings(markdown: string) {
  const found: { level: number; text: string }[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const match = !fenced && /^(#{1,6}) (.+)$/.exec(line);
    if (match) found.push({ level: match[1].length, text: match[2].trim() });
  }
  return found;
}

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens; repeats get -1, -2… */
function anchors(markdown: string) {
  const seen = new Map<string, number>();
  const slugs = new Set<string>();
  for (const { text } of headings(markdown)) {
    const plain = text.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = plain.toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\- ]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count ? `${base}-${count}` : base);
  }
  return slugs;
}

const imageSources = (markdown: string) => [...markdown.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
/** Web links other than badge images, whose labels a translation may translate. */
const webLinks = (markdown: string) =>
  new Set([...markdown.matchAll(/https?:\/\/[^\s)"'<>]+/g)].map((m) => m[0]).filter((url) => !url.startsWith("https://img.shields.io/")));

const english = read("README.md");

for (const file of READMES) {
  const markdown = read(file);

  test(`${file}: every in-page link points to a heading of the same file`, () => {
    const known = anchors(markdown);
    const broken = [...markdown.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((id) => !known.has(id));
    assert.deepEqual(broken, []);
  });

  test(`${file}: the language line links every other README`, () => {
    const line = markdown.split("\n").find((l) => l.includes("README.tr.md") || l.includes("**Türkçe**"));
    assert.ok(line, "no language line");
    for (const other of READMES.filter((f) => f !== file)) assert.ok(line.includes(`](${other})`), `missing ${other}`);
    assert.ok(!line.includes(`](${file})`), "links to itself");
  });

  if (file === "README.md") continue;

  test(`${file}: the same headings, images and web links as the English README`, () => {
    assert.deepEqual(
      headings(markdown).map((h) => h.level),
      headings(english).map((h) => h.level),
    );
    assert.deepEqual(imageSources(markdown), imageSources(english));
    assert.deepEqual([...webLinks(markdown)].sort(), [...webLinks(english)].sort());
  });
}
