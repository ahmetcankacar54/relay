import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The 5-hour usage limit is a "dönem" in Turkish. "pencere" is left for app windows only, so a
// line that says it must be one of these phrases.
const APP_WINDOW_PHRASES = [
  "Relay penceresini",
  "panda penceresini",
  "Pencere kapanınca Relay",
];

const ROOTS = ["src", "shared", "electron"];
const SKIPPED = [path.join("src", "dev")];

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (SKIPPED.includes(full)) return [];
    if (entry.isDirectory()) return sources(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });

/** A line that only holds a comment says nothing a user reads. */
const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

test("pencere appears only for app windows", () => {
  const files = ROOTS.flatMap(sources);
  for (const root of ROOTS)
    assert.ok(
      files.some((file) => file.startsWith(`${root}${path.sep}`)),
      `no sources found under ${root}`,
    );
  const offenders = files.flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        !isComment(line) &&
        /[Pp]encere/.test(line) &&
        !APP_WINDOW_PHRASES.some((phrase) => line.includes(phrase))
          ? [`${file}:${index + 1}: ${line.trim()}`]
          : [],
      ),
  );
  assert.deepEqual(offenders, []);
});
