#!/usr/bin/env node
/**
 * The recorded cases of the rust/<unit>-rs parity crates are large JSONL files (about 80 MB in
 * all) that compress about 30 to 1, so git keeps `cases.jsonl.gz` and rust-anything reads
 * `cases.jsonl`.
 *
 * Usage: node scripts/parity/cases.mjs unpack|pack [crate dir...]
 *   unpack: writes cases.jsonl from cases.jsonl.gz (before `rust-anything diff` or `gate`)
 *   pack:   writes cases.jsonl.gz from cases.jsonl (after `rust-anything record`)
 * With no crate dirs, every rust/*-rs crate.
 */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync, constants } from "node:zlib";

const root = path.resolve(import.meta.dirname, "..", "..");
const [mode, ...dirs] = process.argv.slice(2);
if (mode !== "unpack" && mode !== "pack") {
  console.error(
    "usage: node scripts/parity/cases.mjs unpack|pack [crate dir...]",
  );
  process.exit(2);
}

const crates = dirs.length
  ? dirs.map((dir) => path.resolve(dir))
  : fs
      .readdirSync(path.join(root, "rust"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("-rs"))
      .map((entry) => path.join(root, "rust", entry.name));

let changed = 0;
for (const crate of crates) {
  const plain = path.join(crate, "cases.jsonl");
  const packed = `${plain}.gz`;
  if (mode === "unpack") {
    if (!fs.existsSync(packed)) continue;
    const bytes = gunzipSync(fs.readFileSync(packed));
    if (fs.existsSync(plain) && fs.readFileSync(plain).equals(bytes)) continue;
    fs.writeFileSync(plain, bytes);
  } else {
    if (!fs.existsSync(plain)) continue;
    const bytes = fs.readFileSync(plain);
    if (
      fs.existsSync(packed) &&
      gunzipSync(fs.readFileSync(packed)).equals(bytes)
    )
      continue;
    // mtime 0 in the header keeps the archive byte-stable for the same cases.
    fs.writeFileSync(
      packed,
      gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }),
    );
  }
  changed++;
}
console.log(`${mode}: ${changed} of ${crates.length} crates written`);
