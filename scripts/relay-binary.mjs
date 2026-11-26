/**
 * The `relay` binary (crates/relay-cli) inside the packaged app, where the Proxy Gateway runs as
 * `relay __gateway`. Cargo builds it for the package's platform and architecture;
 * scripts/stable-signing.mjs (macOS) and scripts/tauri-build.mjs (Windows, Linux) put it in the
 * app's resources/bin. A missing build fails the package: an app without it would have no gateway.
 *
 *   node scripts/relay-binary.mjs [--arch arm64|x64]   builds it for this platform
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The Rust target of each platform and architecture Relay ships for. */
export const RELAY_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

export function relayTarget(platform, arch) {
  const target = RELAY_TARGETS[`${platform}-${arch}`];
  if (!target)
    throw new Error(`Relay ships no relay binary for ${platform}-${arch}.`);
  return target;
}

export const relayBinaryName = (platform) =>
  platform === "win32" ? "relay.exe" : "relay";

/**
 * Where cargo leaves the release build for a platform and architecture. The Tauri packages build
 * it in a target directory of its own (scripts/tauri-build.mjs CLI_TARGET_DIR): `tauri build`
 * writes the app as target/<triple>/release/Relay, which a case-insensitive disk takes for relay.
 */
export function relayBinary(platform, arch, base = root, targetDir = "target") {
  return path.join(
    base,
    targetDir,
    relayTarget(platform, arch),
    "release",
    relayBinaryName(platform),
  );
}

/** Builds the release binary for a platform and architecture; answers its path. */
export function buildRelayBinary(
  platform = process.platform,
  arch = process.arch,
  base = root,
  targetDir = "target",
) {
  execFileSync(
    "cargo",
    [
      "build",
      "-p",
      "relay-cli",
      "--release",
      "--target",
      relayTarget(platform, arch),
      "--target-dir",
      path.join(base, targetDir),
    ],
    {
      cwd: base,
      stdio: "inherit",
    },
  );
  return relayBinary(platform, arch, base, targetDir);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  let arch = process.arch;
  if (args[0] === "--arch" && args[1] && args.length === 2) arch = args[1];
  else if (args.length)
    throw new Error("Usage: node scripts/relay-binary.mjs [--arch arm64|x64]");
  console.log(buildRelayBinary(process.platform, arch));
}
