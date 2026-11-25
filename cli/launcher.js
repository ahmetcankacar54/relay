#!/usr/bin/env node
// Plain syntax on purpose: an old Node must reach these checks instead of a syntax error.
var parts = process.versions.node.split(".");
var major = Number(parts[0]);
var minor = Number(parts[1]);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("relay needs Node.js 22.12 or newer (found " + process.versions.node + ").");
  process.exit(5);
}
// Claude Code runs "relay statusline" after every answer: it gets a small bundle of its own.
if (process.argv[2] === "statusline" && (process.argv[3] === undefined || process.argv[3].charAt(0) === "-")) import("./relay-statusline.js");
else import("./relay-cli.js");
