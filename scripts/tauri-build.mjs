#!/usr/bin/env node
/**
 * `npm run tauri:build`: Relay 1.0's packages (crates/relay-app, Tauri), under the release names
 * Relay 0.x's updaters look for (docs/development.md, "Releasing"):
 *   macOS    scripts/tauri-stable-signing.mjs: the signed Relay.app, and with --dmg its
 *            Relay-<v>-<arch>.dmg. Every argument is passed on to it.
 *   Windows  <output>/Relay-Setup-<v>-x64.exe and latest.yml (beta.yml for a beta)
 *   Linux    <output>/Relay-<v>-x86_64.AppImage and latest-linux.yml (beta-linux.yml)
 * The Windows and Linux bundles carry the relay CLI in the app's resources, bin/relay(.exe),
 * where relay_core::relay_cli_path::bundled_relay_cli finds it. The version is tauri.conf.json's.
 *
 *   node scripts/tauri-build.mjs [--debug] [--output <dir>]     (Windows and Linux; default release)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installerName, writeUpdateYml } from "./electron-update-yml.mjs";
import {
  buildRelayBinary,
  relayBinaryName,
  relayTarget,
} from "./relay-binary.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The Tauri app's folder, with tauri.conf.json. */
export const TAURI_DIR = path.join(root, "crates/relay-app");

/**
 * The relay CLI's own target directory for packages: `tauri build` copies the app to
 * target/<triple>/<profile>/Relay (mainBinaryName), and on a case-insensitive disk that is
 * the CLI's target/<triple>/<profile>/relay.
 */
export const CLI_TARGET_DIR = "target/cli";

/** The version tauri.conf.json gives the app (a path there names a package.json holding it). */
export function tauriVersion(base = root) {
  const dir = path.join(base, "crates/relay-app");
  const { version } = JSON.parse(
    fs.readFileSync(path.join(dir, "tauri.conf.json"), "utf8"),
  );
  if (typeof version === "string" && version.endsWith(".json"))
    return JSON.parse(fs.readFileSync(path.resolve(dir, version), "utf8"))
      .version;
  if (typeof version !== "string")
    throw new Error("tauri.conf.json names no version.");
  return version;
}

/** Runs the pinned Tauri CLI (@tauri-apps/cli) from the workspace root. */
export function runTauri(args, base = root) {
  execFileSync(
    process.execPath,
    [path.join(base, "node_modules/@tauri-apps/cli/tauri.js"), ...args],
    { cwd: base, stdio: "inherit" },
  );
}

/** Tauri's bundle type for each platform Relay ships an installer for, and its file. */
export const PLATFORM_BUNDLES = {
  win32: { bundle: "nsis", extension: ".exe" },
  linux: { bundle: "appimage", extension: ".AppImage" },
};

/**
 * `--config` for `tauri build`: the relay CLI cargo built for `target` goes into the bundle's
 * resources at bin/relay(.exe). Given at bundle time only, so plain cargo builds of relay-app
 * do not need the CLI built first (tauri-build checks that resources exist).
 */
export function cliResourceConfig(platform, target) {
  const name = relayBinaryName(platform);
  return {
    bundle: {
      resources: {
        [`../../${CLI_TARGET_DIR}/${target}/release/${name}`]: `bin/${name}`,
      },
    },
  };
}

/** The installer Tauri wrote for `platform` and `version` under target/<target>/<profile>/bundle. */
export function tauriBundleOutput(base, platform, target, profile, version) {
  const { bundle, extension } = PLATFORM_BUNDLES[platform];
  const dir = path.join(base, "target", target, profile, "bundle", bundle);
  const found = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter(
    (name) => name.endsWith(extension) && name.includes(`_${version}_`),
  );
  if (found.length !== 1)
    throw new Error(
      `Expected one ${extension} for ${version} in ${dir}, found ${found.length}.`,
    );
  return path.join(dir, found[0]);
}

export function parseArguments(args) {
  const options = { debug: false, output: "release" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--debug") options.debug = true;
    else if (flag === "--output") {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error("Missing value for --output.");
      options.output = value;
    } else throw new Error(`Unknown argument: ${flag}.`);
  }
  return options;
}

async function main() {
  if (process.platform === "darwin") {
    execFileSync(
      process.execPath,
      [
        path.join(root, "scripts/tauri-stable-signing.mjs"),
        ...process.argv.slice(2),
      ],
      { cwd: root, stdio: "inherit" },
    );
    return;
  }
  const platform = process.platform;
  if (!PLATFORM_BUNDLES[platform])
    throw new Error(`Relay ships no Tauri package for ${platform}.`);
  const options = parseArguments(process.argv.slice(2));
  const version = tauriVersion();
  const target = relayTarget(platform, "x64");
  buildRelayBinary(platform, "x64", root, CLI_TARGET_DIR);
  runTauri([
    "build",
    "--ci",
    // No certificate on Windows or Linux: updates are trusted through the signed SHA256SUMS.txt.
    "--no-sign",
    "--bundles",
    PLATFORM_BUNDLES[platform].bundle,
    "--target",
    target,
    ...(options.debug ? ["--debug"] : []),
    "--config",
    JSON.stringify(cliResourceConfig(platform, target)),
  ]);
  const built = tauriBundleOutput(
    root,
    platform,
    target,
    options.debug ? "debug" : "release",
    version,
  );
  const output = path.resolve(root, options.output);
  fs.mkdirSync(output, { recursive: true });
  const installer = path.join(output, installerName(platform, version));
  fs.copyFileSync(built, installer);
  if (platform === "linux") fs.chmodSync(installer, 0o755);
  const yml = await writeUpdateYml(installer, { version });
  console.log(`${installer}\n${yml}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
