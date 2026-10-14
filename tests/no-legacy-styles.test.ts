import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );

test("no legacy stylesheets or hard-coded light colours remain in components", () => {
  for (const name of ["styles.css", "modern.css", "planning.css", "continuation-settings.css"])
    assert.equal(fs.existsSync(path.join("src", name)), false, name);
  const offenders = files("src")
    .filter((f) => /\.tsx$/.test(f) && !f.includes(`${path.sep}components${path.sep}ui${path.sep}`))
    .filter((f) => /#[0-9a-fA-F]{3,8}\b|\bbg-white\b|\btext-black\b/.test(fs.readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("feature components live in src/features", () => {
  const stray = fs.readdirSync("src").filter((f) => /\.tsx$/.test(f) && f !== "App.tsx" && f !== "main.tsx");
  assert.deepEqual(stray, []);
});
