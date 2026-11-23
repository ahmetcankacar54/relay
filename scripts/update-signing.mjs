#!/usr/bin/env node
/**
 * Ed25519 signatures over a release's SHA256SUMS.txt. Windows and Linux updates come through
 * electron-updater, whose latest.yml only carries a SHA-512 served from the same place as the
 * installer; the signature is the anchor that host cannot forge. Relay embeds the public key
 * (electron/core/update-signing-key.ts) and installs an update only when the signed sums list it.
 *
 * The private key never enters the repository. It is read from, in order:
 *   RELAY_UPDATE_SIGNING_KEY       the PEM itself (CI secrets)
 *   RELAY_UPDATE_SIGNING_KEY_FILE  a PEM file
 *   ~/.config/relay-release/update-signing-ed25519.pem
 *
 * Usage:
 *   node scripts/update-signing.mjs init                   create the key file if absent; print the public key
 *   node scripts/update-signing.mjs public-key             print the public key of the configured key
 *   node scripts/update-signing.mjs sums <dir> [--tag vX.Y.Z] [--require-key]
 *     writes <dir>/SHA256SUMS.txt over the release assets in <dir> (merged with the sums already
 *     on the GitHub release <tag>, verified) and <dir>/SHA256SUMS.txt.sig when a key is available.
 */
import { execFileSync } from "node:child_process";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SUMS_NAME = "SHA256SUMS.txt";
export const SIGNATURE_NAME = `${SUMS_NAME}.sig`;
export const DEFAULT_KEY_FILE = path.join(
  os.homedir(),
  ".config",
  "relay-release",
  "update-signing-ed25519.pem",
);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const EMBEDDED_KEY_FILE = path.join(root, "electron/core/update-signing-key.ts");

/** The configured private key file. */
export function signingKeyFile(env = process.env) {
  return env.RELAY_UPDATE_SIGNING_KEY_FILE || DEFAULT_KEY_FILE;
}

function ed25519(key) {
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("The update signing key is not an Ed25519 key.");
  return key;
}

/**
 * The private signing key, or undefined when none is configured. A key file others can read is
 * refused: whoever reads it can sign updates every Windows and Linux Relay installs.
 */
export function loadSigningKey(env = process.env, platform = process.platform) {
  if (env.RELAY_UPDATE_SIGNING_KEY)
    return ed25519(createPrivateKey(env.RELAY_UPDATE_SIGNING_KEY));
  const file = signingKeyFile(env);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  if (platform !== "win32" && (stat.mode & 0o077) !== 0)
    throw new Error(`${file} is readable by others; run: chmod 600 "${file}"`);
  return ed25519(createPrivateKey(fs.readFileSync(file, "utf8")));
}

/** Creates the key file (mode 600) unless it exists; returns the key either way. */
export function createSigningKey(file = signingKeyFile()) {
  if (fs.existsSync(file)) return ed25519(createPrivateKey(fs.readFileSync(file, "utf8")));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  // "wx": never overwrites a key that appeared in between.
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
    flag: "wx",
  });
  return privateKey;
}

/** The public half as SPKI DER, base64: the form electron/core/update-signing-key.ts embeds. */
export function publicKeyBase64(key) {
  return createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
}

/** SHA-256 of the SPKI DER, for telling keys apart without showing them. */
export function publicKeyFingerprint(publicBase64) {
  return `sha256:${createHash("sha256").update(Buffer.from(publicBase64, "base64")).digest("hex")}`;
}

/** The detached signature of the sums text, base64 with a trailing newline. */
export function signSums(text, key) {
  return `${sign(null, Buffer.from(text, "utf8"), key).toString("base64")}\n`;
}

/** Whether `signature` (base64) signs `text` under the public key (SPKI DER base64). */
export function verifySums(text, signature, publicBase64) {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(text, "utf8"), ed25519(key), Buffer.from(signature.trim(), "base64"));
  } catch {
    return false;
  }
}

/** The public key the app embeds, read from its source. */
export function embeddedPublicKey(file = EMBEDDED_KEY_FILE) {
  const match = fs
    .readFileSync(file, "utf8")
    .match(/UPDATE_SIGNING_PUBLIC_KEY\s*=\s*"([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error(`No UPDATE_SIGNING_PUBLIC_KEY in ${file}.`);
  return match[1];
}

/** The files in `dir` a release publishes: no sums, signatures, dotfiles or builder logs. */
export function releaseAssetNames(dir) {
  return fs
    .readdirSync(dir)
    .filter(
      (name) =>
        name !== SUMS_NAME &&
        name !== SIGNATURE_NAME &&
        !name.startsWith(".") &&
        !name.startsWith("builder-") &&
        fs.statSync(path.join(dir, name)).isFile(),
    )
    .sort();
}

/** SHA-256 of a file, streamed. */
export function sha256File(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; )
      hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** `<hex>  <name>` lines as name → lower-case hex; the same reading as the app's parseChecksums. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-fA-F]{64}) [ *](.+)$/);
    if (match) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/** The sums file text, one line per name in name order. */
export function formatSums(sums) {
  return [...sums.keys()]
    .sort()
    .map((name) => `${sums.get(name)}  ${name}\n`)
    .join("");
}

/** The sums of the assets in `dir`. */
export function localSums(dir, names = releaseAssetNames(dir)) {
  return new Map(names.map((name) => [name, sha256File(path.join(dir, name))]));
}

/** Remote entries, with this build's own files replacing theirs. */
export function mergeSums(remote, local) {
  return new Map([...remote, ...local]);
}

/** Runs gh; its stderr ("release not found") stays in the thrown error instead of the log. */
function gh(args) {
  return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The entries of the sums already on the release `tag` for files this build does not have, so
 * the Windows/Linux CI build and the Mac's local publish each add their own without dropping
 * the other's. They are accepted when the release's signature verifies under `publicBase64`;
 * otherwise each such file is downloaded and hashed here.
 */
export function remoteSums(tag, local, publicBase64, log = console.log) {
  let assets;
  try {
    assets = JSON.parse(gh(["release", "view", tag, "--json", "assets"])).assets.map((a) => a.name);
  } catch {
    return new Map();
  }
  if (!assets.includes(SUMS_NAME)) return new Map();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sums-"));
  try {
    const patterns = assets.includes(SIGNATURE_NAME) ? [SUMS_NAME, SIGNATURE_NAME] : [SUMS_NAME];
    gh(["release", "download", tag, "--dir", temp, ...patterns.flatMap((p) => ["--pattern", p])]);
    const text = fs.readFileSync(path.join(temp, SUMS_NAME), "utf8");
    const listed = parseSums(text);
    const theirs = new Map(
      [...listed].filter(([name]) => !local.has(name) && assets.includes(name)),
    );
    const signature = path.join(temp, SIGNATURE_NAME);
    if (publicBase64 && fs.existsSync(signature) && verifySums(text, fs.readFileSync(signature, "utf8"), publicBase64)) {
      log(`   Release ${tag}: kept ${theirs.size} signed entries.`);
      return theirs;
    }
    log(`   Release ${tag}: sums are not signed by this key; hashing ${theirs.size} files from the release.`);
    for (const [name, expected] of theirs) {
      gh(["release", "download", tag, "--dir", temp, "--pattern", name, "--clobber"]);
      const actual = sha256File(path.join(temp, name));
      fs.rmSync(path.join(temp, name), { force: true });
      if (actual !== expected)
        throw new Error(`${name} on release ${tag} does not match its line in ${SUMS_NAME}.`);
    }
    return theirs;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Writes `<dir>/SHA256SUMS.txt` and, with a key, its signature. A key whose public half is not
 * the one the app embeds is refused: no Relay would accept what it signs.
 */
export function writeReleaseSums(dir, { tag, requireKey = false, env = process.env, log = console.log } = {}) {
  const key = loadSigningKey(env);
  if (!key && requireKey)
    throw new Error(
      `No update signing key: set RELAY_UPDATE_SIGNING_KEY or create ${signingKeyFile(env)} with "node scripts/update-signing.mjs init".`,
    );
  const embedded = embeddedPublicKey();
  if (key && publicKeyBase64(key) !== embedded)
    throw new Error(
      `The update signing key (${publicKeyFingerprint(publicKeyBase64(key))}) is not the key Relay embeds (${publicKeyFingerprint(embedded)}).`,
    );
  const local = localSums(dir);
  if (local.size === 0) throw new Error(`No release assets in ${dir}.`);
  const sums = tag ? mergeSums(remoteSums(tag, local, embedded, log), local) : local;
  const text = formatSums(sums);
  fs.writeFileSync(path.join(dir, SUMS_NAME), text, "utf8");
  const signatureFile = path.join(dir, SIGNATURE_NAME);
  if (key) fs.writeFileSync(signatureFile, signSums(text, key), "utf8");
  else fs.rmSync(signatureFile, { force: true });
  log(`   ${SUMS_NAME}: ${sums.size} files${key ? `, signed (${publicKeyFingerprint(embedded)})` : ", NOT signed"}.`);
  return { text, sums, signed: Boolean(key) };
}

function main(args) {
  const [command, ...rest] = args;
  if (command === "init") {
    const file = signingKeyFile();
    const existed = fs.existsSync(file);
    const publicBase64 = publicKeyBase64(createSigningKey(file));
    console.log(`${existed ? "Using the existing" : "Created the"} private key ${file} (keep it secret, back it up).`);
    console.log(`Public key (embed in electron/core/update-signing-key.ts): ${publicBase64}`);
    console.log(`Fingerprint: ${publicKeyFingerprint(publicBase64)}`);
    return;
  }
  if (command === "public-key") {
    const key = loadSigningKey();
    if (!key) throw new Error(`No update signing key at ${signingKeyFile()}.`);
    const publicBase64 = publicKeyBase64(key);
    console.log(publicBase64);
    console.log(publicKeyFingerprint(publicBase64));
    return;
  }
  if (command === "sums") {
    const dir = rest.find((a) => !a.startsWith("--"));
    const tagIndex = rest.indexOf("--tag");
    const tag = tagIndex >= 0 ? rest[tagIndex + 1] : undefined;
    if (!dir || (tagIndex >= 0 && !/^v\d+\.\d+\.\d+$/.test(tag ?? "")))
      throw new Error("Usage: update-signing.mjs sums <dir> [--tag vX.Y.Z] [--require-key]");
    writeReleaseSums(path.resolve(dir), { tag, requireKey: rest.includes("--require-key") });
    return;
  }
  throw new Error("Usage: update-signing.mjs init | public-key | sums <dir> [--tag vX.Y.Z] [--require-key]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
