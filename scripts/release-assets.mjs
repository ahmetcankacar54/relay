#!/usr/bin/env node
// Gathers a release's files into release/share/<version>/ and writes SHA256SUMS.txt, so the
// GitHub release carries what Relay's own updater reads:
//   macOS   Relay-<v>-arm64.dmg (+ x64) and SHA256SUMS.txt   (Relay's own updater)
//   Windows Relay-Setup-<v>-x64.exe, its .blockmap, latest.yml        (electron-updater)
//   Linux   Relay-<v>-x86_64.AppImage, latest-linux.yml               (electron-updater)
// plus INSTALL.txt from docs/share/install-notes.md. Build first: the DMG with
//   node scripts/stable-signing.mjs --dmg --arch arm64 --output release/share/<v>
// and Windows/Linux with electron-builder into release/share/<v>-win and <v>-linux.
// Usage: node scripts/release-assets.mjs <version>; prints the files to upload.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: node scripts/release-assets.mjs <version>");
  process.exit(2);
}
const share = path.resolve("release/share");
const out = path.join(share, version);
const from = (dir, name) => path.join(share, dir, name);
const wanted = [
  { file: from(version, `Relay-${version}-arm64.dmg`), required: true },
  { file: from(version, `Relay-${version}-x64.dmg`), required: false },
  { file: from(`${version}-win`, `Relay-Setup-${version}-x64.exe`), required: true },
  { file: from(`${version}-win`, `Relay-Setup-${version}-x64.exe.blockmap`), required: false },
  { file: from(`${version}-win`, "latest.yml"), required: true },
  { file: from(`${version}-linux`, `Relay-${version}-x86_64.AppImage`), required: true },
  { file: from(`${version}-linux`, "latest-linux.yml"), required: true },
];
const missing = wanted.filter((w) => w.required && !fs.existsSync(w.file)).map((w) => w.file);
if (missing.length) {
  console.error(`Missing:\n${missing.join("\n")}`);
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const names = [];
for (const { file } of wanted) {
  if (!fs.existsSync(file)) continue;
  const name = path.basename(file);
  if (path.dirname(file) !== out) fs.copyFileSync(file, path.join(out, name));
  names.push(name);
}
fs.copyFileSync(path.resolve("docs/share/install-notes.md"), path.join(out, "INSTALL.txt"));
names.push("INSTALL.txt");

// The update files name what they download: those names must be the ones published.
for (const yml of ["latest.yml", "latest-linux.yml"]) {
  const text = fs.readFileSync(path.join(out, yml), "utf8");
  if (!text.includes(`version: ${version}`)) throw new Error(`${yml} is not for ${version}.`);
  for (const [, url] of text.matchAll(/^\s*(?:-\s+)?url:\s*(.+)$/gm))
    if (!names.includes(url.trim())) throw new Error(`${yml} names ${url.trim()}, which is not published.`);
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sums = names.map((name) => `${sha256(path.join(out, name))}  ${name}`).join("\n") + "\n";
fs.writeFileSync(path.join(out, "SHA256SUMS.txt"), sums);
names.push("SHA256SUMS.txt");
console.log(names.map((name) => path.join(out, name)).join("\n"));
