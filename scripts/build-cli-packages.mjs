#!/usr/bin/env node
/**
 * Builds the Rust `relay` CLI and lays out its npm packages and release archives in cli/npm/dist:
 * - relay-<platform>-<arch>/: one platform package per target (cli/npm/platforms template + binary);
 * - relay/: the @ahmetcankacar/relay shim (cli/package.json, cli/launcher.js), which installs the
 *   right one;
 * - relay-<version>-<target>.tar.gz (.zip for Windows): the binary alone, for the GitHub release.
 *
 * Usage: node scripts/build-cli-packages.mjs [--target <triple>]... [--cross] [--skip-build]
 * Without --target, every target is built. --cross (or RELAY_CLI_CROSS=1) builds with `cross`;
 * --skip-build stages binaries already in target/<triple>/release.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "cli");
const DIST = path.join(CLI, "npm", "dist");
const TARGETS = {
  "aarch64-apple-darwin": "darwin-arm64",
  "x86_64-apple-darwin": "darwin-x64",
  "x86_64-unknown-linux-gnu": "linux-x64",
  "aarch64-unknown-linux-gnu": "linux-arm64",
  "x86_64-pc-windows-msvc": "win32-x64",
};

function fail(message) {
  console.error(`build-cli-packages: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0)
    fail(
      `${command} failed (${result.error?.message ?? `exit ${result.status}`})`,
    );
}

const argv = process.argv.slice(2);
const targets = [];
let cross = process.env.RELAY_CLI_CROSS === "1";
let skipBuild = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--target") targets.push(argv[++i]);
  else if (argv[i] === "--cross") cross = true;
  else if (argv[i] === "--skip-build") skipBuild = true;
  else fail(`unknown argument ${argv[i]}`);
}
if (!targets.length) targets.push(...Object.keys(TARGETS));
for (const target of targets)
  if (!TARGETS[target])
    fail(`unknown target ${target}; one of ${Object.keys(TARGETS).join(", ")}`);

// One version everywhere: the crate's, which the shim and its optional dependencies must repeat.
const cargo = readFileSync(
  path.join(ROOT, "crates/relay-cli/Cargo.toml"),
  "utf8",
);
const version = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
if (!version) fail("no version in crates/relay-cli/Cargo.toml");
const shim = JSON.parse(readFileSync(path.join(CLI, "package.json"), "utf8"));
if (shim.version !== version)
  fail(`cli/package.json is ${shim.version}, crates/relay-cli is ${version}`);
for (const pkg of Object.values(TARGETS)) {
  const name = `@ahmetcankacar/relay-${pkg}`;
  if (shim.optionalDependencies?.[name] !== version)
    fail(`cli/package.json must depend on ${name}@${version}`);
}

const targetDir = process.env.CARGO_TARGET_DIR
  ? path.resolve(process.env.CARGO_TARGET_DIR)
  : path.join(ROOT, "target");
mkdirSync(DIST, { recursive: true });

for (const target of targets) {
  const pkg = TARGETS[target];
  const exe = target.includes("windows") ? "relay.exe" : "relay";
  if (!skipBuild)
    run(cross ? "cross" : "cargo", [
      "build",
      "-p",
      "relay-cli",
      "--release",
      "--locked",
      "--target",
      target,
    ]);
  const binary = path.join(targetDir, target, "release", exe);
  if (!existsSync(binary)) fail(`no binary at ${path.relative(ROOT, binary)}`);

  const template = path.join(CLI, "npm", "platforms", pkg);
  const out = path.join(DIST, `relay-${pkg}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(path.join(out, "bin"), { recursive: true });
  const manifest = JSON.parse(
    readFileSync(path.join(template, "package.json"), "utf8"),
  );
  writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify({ name: manifest.name, version, ...manifest }, null, 2)}\n`,
  );
  copyFileSync(path.join(template, "README.md"), path.join(out, "README.md"));
  copyFileSync(path.join(ROOT, "cli/LICENSE"), path.join(out, "LICENSE"));
  copyFileSync(binary, path.join(out, "bin", exe));
  chmodSync(path.join(out, "bin", exe), 0o755);

  // The archive holds the binary with the CLI's license and readme at the top level.
  const archive = path.join(
    DIST,
    `relay-${version}-${target}.${exe.endsWith(".exe") ? "zip" : "tar.gz"}`,
  );
  const staging = path.join(DIST, `.archive-${target}`);
  rmSync(archive, { force: true });
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  copyFileSync(binary, path.join(staging, exe));
  chmodSync(path.join(staging, exe), 0o755);
  for (const file of ["README.md", "LICENSE"])
    copyFileSync(path.join(ROOT, "cli", file), path.join(staging, file));
  // macOS tar would add `._` AppleDouble files for extended attributes.
  process.env.COPYFILE_DISABLE = "1";
  const files = [exe, "README.md", "LICENSE"];
  if (!archive.endsWith(".zip"))
    run("tar", ["-czf", archive, "-C", staging, ...files]);
  // GNU tar writes no zip; bsdtar (macOS, and Windows' own tar.exe ahead of Git's) does with -a.
  else if (process.platform === "linux")
    run("zip", ["-j", archive, ...files], { cwd: staging });
  else {
    const tar =
      process.platform === "win32"
        ? path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "tar.exe",
          )
        : "tar";
    run(tar, ["-a", "-cf", archive, "-C", staging, ...files]);
  }
  rmSync(staging, { recursive: true });
  console.log(
    `staged ${path.relative(ROOT, out)} and ${path.relative(ROOT, archive)}`,
  );
}

const shimOut = path.join(DIST, "relay");
rmSync(shimOut, { recursive: true, force: true });
mkdirSync(shimOut, { recursive: true });
for (const file of [
  "package.json",
  "launcher.js",
  "README.md",
  "README.tr.md",
  "LICENSE",
])
  copyFileSync(path.join(CLI, file), path.join(shimOut, file));
chmodSync(path.join(shimOut, "launcher.js"), 0o755);
console.log(`staged ${path.relative(ROOT, shimOut)} (${shim.name}@${version})`);
