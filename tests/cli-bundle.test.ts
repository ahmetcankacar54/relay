import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { CLI_VERSION } from "../cli/src/version";

const root = path.join(__dirname, "..");
const cli = path.join(root, "cli");
before(() => {
  execFileSync(process.execPath, [path.join(root, "scripts", "build-cli.mjs")], { cwd: root, stdio: "pipe" });
});

test("the bundle has no Electron, node-pty, renderer or app-entry input", () => {
  const inputs = Object.keys(JSON.parse(fs.readFileSync(path.join(cli, "dist", "meta.json"), "utf8")).inputs);
  assert.ok(inputs.length > 10);
  const bad = inputs.filter((p) => /node_modules\/(electron|node-pty)\/|^electron\/main\.ts$|^electron\/core\/desktop-host\.ts$|^src\//.test(p));
  assert.deepEqual(bad, []);
});

test("the launcher has the shebang and only plain syntax", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, () => {
  const text = fs.readFileSync(path.join(cli, "dist", "relay.js"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env node");
  const body = lines.filter((line) => !line.includes('import("./relay-cli.js")')).join("\n");
  assert.ok(!/=>|\bconst\b|\blet\b|\?\.|`/.test(body), body);
  if (process.platform !== "win32") assert.ok(fs.statSync(path.join(cli, "dist", "relay.js")).mode & 0o100);
});

test("relay --version runs from the built launcher", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bundle-"));
  const r = spawnSync(process.execPath, [path.join(cli, "dist", "relay.js"), "--version"], {
    env: { ...process.env, RELAY_HOME: home },
    encoding: "utf8",
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), CLI_VERSION);
});

test("npm pack --dry-run lists exactly the published files", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cli, encoding: "utf8", env: { ...process.env, npm_config_loglevel: "silent" } });
  const files = JSON.parse(out)[0].files.map((f: { path: string }) => f.path).sort();
  assert.deepEqual(files, ["LICENSE", "README.md", "README.tr.md", "dist/relay-cli.js", "dist/relay.js", "package.json"]);
});

test("cli/package.json has no dependencies or scripts and pins name, bin, os, engines, license and version", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8"));
  assert.equal(pkg.name, "@ahmetcankacar/relay");
  assert.equal(pkg.version, CLI_VERSION);
  assert.deepEqual(pkg.bin, { relay: "dist/relay.js" });
  assert.deepEqual(pkg.os, ["darwin"]);
  assert.deepEqual(pkg.engines, { node: ">=22.12" });
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts, undefined);
  assert.match(fs.readFileSync(path.join(cli, "LICENSE"), "utf8"), /Copyright \(c\) 2026 Ahmet Can Kacar/);
});

test("the build script turns its URLs into paths with fileURLToPath, so folders with spaces work", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "build-cli.mjs"), "utf8");
  assert.doesNotMatch(script, /\.pathname/);
  assert.match(script, /fileURLToPath/);
});
