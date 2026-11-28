#!/usr/bin/env node
/**
 * The electron-updater files of a Tauri release, so a Relay 0.x (Electron) on Windows or Linux
 * finds and installs it: `latest.yml` beside the NSIS installer and `latest-linux.yml` beside the
 * AppImage (`beta.yml` and `beta-linux.yml` for a beta, scripts/release-channel.mjs). They carry
 * what electron-builder wrote for these targets, which electron-updater reads
 * (providers/Provider.js parseUpdateInfo, resolveFiles): the version, the file with its SHA-512
 * (base64) and size, the legacy top-level `path` and `sha512`, and the release date.
 *
 * Without a blockmap (the Tauri bundles have none, embedded or beside them) electron-updater falls
 * back to a full download. The 0.x updater still installs only a file the release's signed
 * SHA256SUMS.txt lists under the name it expects (installerName in Relay 0.x's
 * electron/core/win-linux-update.ts), so the installer must carry exactly that name.
 *
 * Usage:
 *   node scripts/electron-update-yml.mjs <installer> --version <v> [--output <dir>]
 * The platform follows from the installer's name; the file is written beside the installer, or
 * into --output.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseChannel } from "./release-channel.mjs";

/** The installer a release publishes for a platform; Relay 0.x's electron/core/win-linux-update.ts names it so too. */
export function installerName(platform, version) {
  if (platform === "win32") return `Relay-Setup-${version}-x64.exe`;
  if (platform === "linux") return `Relay-${version}-x86_64.AppImage`;
  throw new Error(`Relay has no electron-updater file for ${platform}.`);
}

/** The platform of a release installer's name, or undefined. */
export function installerPlatform(name) {
  if (/^Relay-Setup-.+-x64\.exe$/.test(name)) return "win32";
  if (/^Relay-.+-x86_64\.AppImage$/.test(name)) return "linux";
  return undefined;
}

/** The updater file of `version` for a platform: latest.yml / latest-linux.yml, or the beta ones. */
export function updaterFileName(platform, version) {
  const channel = releaseChannel(version);
  if (!channel)
    throw new Error(`Not a release version: ${JSON.stringify(version)}.`);
  const [windows, linux] = channel.updaterFiles;
  if (platform === "win32") return windows;
  if (platform === "linux") return linux;
  throw new Error(`Relay has no electron-updater file for ${platform}.`);
}

/** A file's SHA-512, base64, as electron-builder writes it. */
export async function sha512Base64(file) {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("base64");
}

/**
 * The YAML text, in electron-builder's key order and quoting: only the date is quoted (it would
 * otherwise read as a timestamp); names, digests and versions are plain scalars.
 */
export function renderUpdateYml({ version, name, sha512, size, releaseDate }) {
  if (!releaseChannel(version))
    throw new Error(`Not a release version: ${JSON.stringify(version)}.`);
  if (!/^[A-Za-z0-9._-]+$/.test(name ?? ""))
    throw new Error(`Not a release file name: ${JSON.stringify(name)}.`);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512 ?? ""))
    throw new Error("The SHA-512 must be 64 bytes in base64.");
  if (!Number.isSafeInteger(size) || size <= 0)
    throw new Error("The size must be a positive whole number of bytes.");
  const date = new Date(releaseDate);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid release date.");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${date.toISOString()}'`,
    "",
  ].join("\n");
}

/**
 * Writes the updater file for `installer`, which must be named as Relay 0.x expects for
 * `version`; answers its path.
 */
export async function writeUpdateYml(
  installer,
  { version, output = path.dirname(installer), releaseDate = new Date() },
) {
  const name = path.basename(installer);
  const platform = installerPlatform(name);
  if (!platform || name !== installerName(platform, version))
    throw new Error(
      `${name} is not a Relay ${version} installer: Relay 0.x installs only ${installerName("win32", version)} or ${installerName("linux", version)}.`,
    );
  const stat = fs.statSync(installer);
  if (!stat.isFile()) throw new Error(`${installer} is not a file.`);
  const text = renderUpdateYml({
    version,
    name,
    sha512: await sha512Base64(installer),
    size: stat.size,
    releaseDate,
  });
  const file = path.join(output, updaterFileName(platform, version));
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

/** The command line: the installer path, `--version` and an optional `--output`. */
export function parseCommandLine(argv) {
  const args = [...argv];
  const value = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return undefined;
    const found = args[index + 1];
    if (!found || found.startsWith("--"))
      throw new Error(`Missing value for ${flag}.`);
    args.splice(index, 2);
    return found;
  };
  const version = value("--version");
  const output = value("--output");
  if (!version || args.length !== 1 || args[0].startsWith("--"))
    throw new Error(
      "Usage: electron-update-yml.mjs <installer> --version <v> [--output <dir>]",
    );
  return { installer: args[0], version, output };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // No top-level await: tests load this file synchronously.
  Promise.resolve()
    .then(() => {
      const { installer, version, output } = parseCommandLine(
        process.argv.slice(2),
      );
      return writeUpdateYml(installer, { version, output });
    })
    .then((file) => console.log(file))
    .catch((error) => {
      console.error(`❌ ${error.message}`);
      process.exit(1);
    });
}
