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

test("the launcher has the shebang and only plain syntax", () => {
  const text = fs.readFileSync(path.join(cli, "dist", "relay.js"), "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "#!/usr/bin/env node");
  const body = lines.filter((line) => !/import\("\.\/relay-(cli|statusline)\.js"\)/.test(line)).join("\n");
  assert.ok(!/=>|\bconst\b|\blet\b|\?\.|`/.test(body), body);
  if (process.platform !== "win32") assert.ok(fs.statSync(path.join(cli, "dist", "relay.js")).mode & 0o100);
});

test("relay --version runs from the built launcher", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bundle-"));
  const r = spawnSync(process.execPath, [path.join(cli, "dist", "relay.js"), "--version"], {
    env: { ...process.env, RELAY_HOME: home },
    encoding: "utf8",
  });
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), CLI_VERSION);
});

test("relay statusline runs from its own small bundle, and falls back to the full CLI without a snapshot", () => {
  const bundle = fs.readFileSync(path.join(cli, "dist", "relay-statusline.js"), "utf8");
  // No catalogs, zod or core: Claude Code waits for this after every answer.
  assert.ok(bundle.length < 64 * 1024, `${bundle.length} bytes`);
  assert.doesNotMatch(bundle, /IntlMessageFormat|ZodError|registerCatalog/);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bundle-"));
  const run = () =>
    spawnSync(process.execPath, [path.join(cli, "dist", "relay.js"), "statusline"], {
      env: { ...process.env, RELAY_HOME: home, HOME: home, USERPROFILE: home, LANG: "en_US.UTF-8", LC_ALL: "", RELAY_LANG: "", CLAUDE_CONFIG_DIR: "" },
      input: JSON.stringify({ session_id: "s1" }),
      encoding: "utf8",
    });
  try {
    let r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Open Relay\.app once/);
    fs.writeFileSync(
      path.join(home, "statusline.json"),
      JSON.stringify({
        version: 1,
        generatedAt: Date.now(),
        formatLocale: "en-GB",
        profiles: path.join(home, "profiles"),
        desktopAccountId: "a",
        terminalFollows: true,
        accounts: [{ id: "a", name: "Vertex", identities: [], fiveHour: { used: 42 }, week: { used: 18 } }],
        text: { fiveHour: "5 h {percent}", week: "week {percent}", viaGateway: "via gateway", updatedAgo: "updated {age}" },
      }),
    );
    r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "Vertex · 5 h 42% · week 18%\n");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("npm pack --dry-run lists exactly the published files", { skip: process.platform === "win32" && "npm is a .cmd script on Windows" }, () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cli, encoding: "utf8", env: { ...process.env, npm_config_loglevel: "silent" } });
  const files = JSON.parse(out)[0].files.map((f: { path: string }) => f.path).sort();
  assert.deepEqual(files, ["LICENSE", "README.md", "README.tr.md", "dist/relay-cli.js", "dist/relay-statusline.js", "dist/relay.js", "package.json"]);
});

test("cli/package.json has no dependencies or scripts and pins name, bin, engines, license and version, on every system", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8"));
  assert.equal(pkg.name, "@ahmetcankacar/relay");
  assert.equal(pkg.version, CLI_VERSION);
  assert.deepEqual(pkg.bin, { relay: "dist/relay.js" });
  assert.equal(pkg.os, undefined);
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
