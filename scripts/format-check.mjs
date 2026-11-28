#!/usr/bin/env node
/**
 * Prettier check for the files a change adds. Most of the code base predates Prettier and is
 * hand-formatted; formatting all of it at once rewrites ~35,000 lines and breaks tests that read
 * source text. New files are held to Prettier from the start instead.
 *
 * Usage: node scripts/format-check.mjs [base-ref]
 * The base defaults to $FORMAT_BASE, then the merge base with origin/main (or public/main).
 */
import { execFileSync, spawnSync } from "node:child_process";

const ROOTS = ["src", "shared", "tests", "scripts", "e2e"];
const FORMATTED = /\.(?:[cm]?[jt]sx?|css|json)$/;

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function baseRef() {
  // A push that creates a branch has no previous commit: GitHub sends all zeros.
  const given = [process.argv[2], process.env.FORMAT_BASE].find(
    (ref) => ref && !/^0+$/.test(ref),
  );
  if (given) return given;
  for (const remote of ["origin/main", "public/main"]) {
    try {
      return git("merge-base", "HEAD", remote);
    } catch {
      // That remote is not fetched here; try the next.
    }
  }
  console.error(
    "format-check: no base ref; pass one, e.g. node scripts/format-check.mjs origin/main",
  );
  process.exit(2);
}

const base = baseRef();
const added = git(
  "diff",
  "--diff-filter=A",
  "--name-only",
  `${base}...HEAD`,
  "--",
  ...ROOTS,
)
  .split("\n")
  .filter((file) => file && FORMATTED.test(file));

if (!added.length) {
  console.log(`format-check: no new files since ${base.slice(0, 12)}.`);
  process.exit(0);
}
const result = spawnSync("npx", ["prettier", "--check", ...added], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
