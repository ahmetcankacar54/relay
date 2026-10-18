#!/usr/bin/env node
// Plain syntax on purpose: an old Node must reach these checks instead of a syntax error.
var parts = process.versions.node.split(".");
var major = Number(parts[0]);
var minor = Number(parts[1]);
if (process.platform !== "darwin") {
  console.error("relay works on macOS only.");
  process.exit(5);
}
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("relay needs Node.js 22.12 or newer (found " + process.versions.node + ").");
  process.exit(5);
}
import("./relay-cli.js");
