import { execFileSync, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appIdentifier = "dev.relay.workspace";
const permissionTargets = [
  { relative: "", identifier: appIdentifier },
  ...["desktop-automation"].map((name) => ({
    relative: `Contents/Resources/app.asar.unpacked/dist-electron/${name}`,
    identifier: `${appIdentifier}.${name}`,
  })),
];

// These are data in Electron's resource directories, not nested code. The
// enclosing framework/app signature still seals them in CodeResources. Avoid
// @electron/osx-sign's generic binary heuristic signing each locale separately.
function knownResourcePath(relative) {
  if (
    /^Contents\/Resources\/(?:app\.asar|default_app\.asar|icon\.icns|electron\.icns)$/.test(
      relative,
    )
  )
    return true;
  const resource = relative.match(
    /^Contents\/Frameworks\/Electron Framework\.framework\/Versions\/[^/]+\/Resources\/(.+)$/,
  )?.[1];
  return (
    typeof resource === "string" &&
    /^(?:[^/]+\.lproj\/locale\.pak|chrome_(?:100|200)_percent\.pak|resources\.pak|icudtl\.dat|v8_context_snapshot\.(?:arm64|x86_64)\.bin|snapshot_blob\.bin|MainMenu\.nib)$/.test(
      resource,
    )
  );
}

const machOMagic = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

/** Fail closed: a resource name must never hide native or script executable code. */
export function knownResourceSigningIgnore(app) {
  const root = path.resolve(app);
  return (file) => {
    const absolute = path.resolve(file);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!knownResourcePath(relative)) return false;
    let descriptor;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0)
        return false;
      const realRoot = realpathSync(root);
      const realFile = realpathSync(absolute);
      if (
        !realFile.startsWith(`${realRoot}${path.sep}`) ||
        !knownResourcePath(
          path.relative(realRoot, realFile).split(path.sep).join("/"),
        )
      )
        return false;
      descriptor = openSync(absolute, "r");
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        (opened.mode & 0o111) !== 0
      )
        return false;
      const header = Buffer.alloc(4);
      const bytes = readSync(descriptor, header, 0, header.length, 0);
      if (bytes < 4) return false;
      if (machOMagic.has(header.readUInt32BE(0))) return false;
      // Retain other recognizable executables too; their extensions are not proof.
      if (
        header.subarray(0, 2).equals(Buffer.from("#!")) ||
        header.subarray(0, 2).equals(Buffer.from("MZ")) ||
        header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      )
        return false;
      return true;
    } catch {
      // Missing, unreadable or ambiguous files stay in normal signing.
      return false;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

/** Public certificate fingerprint only. Never accepts a name or ad-hoc identity. */
export function normalizeSigningFingerprint(value) {
  if (typeof value !== "string" || !/^[a-f\d]{40}$/i.test(value))
    throw new Error(
      "A full 40-character certificate SHA-1 fingerprint is required.",
    );
  return value.toUpperCase();
}

/** security find-identity does not read a private key or request access to it. */
export function findPinnedSigningIdentity(listing, fingerprint) {
  const pin = normalizeSigningFingerprint(fingerprint);
  const matches = listing
    .split("\n")
    .map((line) => /^\s*\d+\)\s+([a-f\d]{40})\s+"([^"\r\n]+)"\s*$/i.exec(line))
    .filter((match) => match?.[1].toUpperCase() === pin);
  if (matches.length === 0)
    throw new Error(
      "The pinned certificate and private key are not an available, valid Code Signing identity. No ad-hoc fallback was used.",
    );
  const names = new Set(matches.map((match) => match[2]));
  if (names.size !== 1)
    throw new Error("The pinned identity listing is inconsistent.");
  return { fingerprint: pin, name: matches[0][2] };
}

/** Only a cryptographically self-signed leaf is eligible for local timestamping. */
export function publicCertificateSigningPolicy(pemListing, fingerprint) {
  const pin = normalizeSigningFingerprint(fingerprint);
  const certificates =
    pemListing.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) || [];
  const certificate = certificates
    .map((pem) => new X509Certificate(pem))
    .find(
      (candidate) =>
        candidate.fingerprint.replaceAll(":", "").toUpperCase() === pin,
    );
  if (!certificate)
    throw new Error(
      "The public certificate does not match the pinned signing identity.",
    );
  const selfSigned =
    certificate.subject === certificate.issuer &&
    certificate.verify(certificate.publicKey);
  return {
    certificateFingerprint: pin,
    selfSigned,
    subject: certificate.subject,
    issuer: certificate.issuer,
    validTo: certificate.validTo,
    // Local self-signed builds do not depend on Apple's timestamp service.
    // CA-issued Apple signing identities retain the library's normal timestamp.
    ...(selfSigned ? { timestamp: "none" } : {}),
  };
}

export function markSigningFailure(runtime = process) {
  runtime.exitCode = 1;
  // electron-builder's own CLI uses this safeguard: native build dependencies
  // can otherwise reset exitCode during shutdown after a signing failure.
  runtime.on("exit", () => {
    runtime.exitCode = 1;
  });
}

export function readDesignatedRequirement(display) {
  const requirement = display.match(/^#?\s*designated => (.+)$/m)?.[1];
  if (
    !requirement ||
    /\bcdhash\b/.test(requirement) ||
    !/\bidentifier\s/.test(requirement) ||
    !/\b(?:certificate|anchor)\s/.test(requirement)
  )
    throw new Error(
      "The signature lacks a certificate-based designated requirement.",
    );
  return requirement;
}

function execute(file, args) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`${path.basename(file)} failed for a signing check.`, {
      cause: result.error || new Error((result.stderr || result.stdout).trim()),
    });
  return `${result.stdout}\n${result.stderr}`;
}

/** Verifies permission-relevant binaries against the pinned public certificate. */
export async function inspectStableSigning(bundle, fingerprint, options = {}) {
  const pin = normalizeSigningFingerprint(fingerprint);
  const run = options.run || execute;
  const read = options.readFile || fs.readFile;
  const root = path.resolve(bundle);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-signing-check-"),
  );
  await fs.chmod(directory, 0o700);
  try {
    // --deep is verification only. The signing library signs nested code inside out.
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", root]);
    const targets = [];
    for (const [index, target] of permissionTargets.entries()) {
      const file = path.join(root, target.relative);
      run("/usr/bin/codesign", ["--verify", "--strict", file]);
      const details = run("/usr/bin/codesign", [
        "--display",
        "--verbose=4",
        file,
      ]);
      if (
        details.match(/^Identifier=(.+)$/m)?.[1] !== target.identifier ||
        details.includes("Signature=adhoc") ||
        details.includes("linker-signed") ||
        details.includes("Info.plist=not bound") ||
        (target.relative === "" && details.includes("Sealed Resources=none"))
      )
        throw new Error(
          `Invalid stable signing metadata for ${target.identifier}.`,
        );
      const prefix = path.join(directory, `certificate-${index}-`);
      run("/usr/bin/codesign", [
        "--display",
        `--extract-certificates=${prefix}`,
        file,
      ]);
      const certificate = await read(`${prefix}0`);
      const actualPin = createHash("sha1")
        .update(certificate)
        .digest("hex")
        .toUpperCase();
      if (actualPin !== pin)
        throw new Error(
          `Certificate fingerprint mismatch for ${target.identifier}.`,
        );
      // All exported files are public certificates; private keys never leave Keychain.
      const parsed = options.certificateMetadata
        ? options.certificateMetadata(certificate)
        : new X509Certificate(certificate);
      const requirement = readDesignatedRequirement(
        run("/usr/bin/codesign", ["--display", "--requirements", "-", file]),
      );
      targets.push({
        relative: target.relative,
        identifier: target.identifier,
        certificateFingerprint: actualPin,
        subject: parsed.subject,
        issuer: parsed.issuer,
        validTo: parsed.validTo,
        designatedRequirement: requirement,
        cdHash: details.match(/^CDHash=(.+)$/m)?.[1],
      });
    }
    return { bundle: root, verified: true, signing: "certificate", targets };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Checks both directions so the current and next build share the same identity. */
export function verifySigningContinuity(previous, next, run = execute) {
  if (previous.bundle === next.bundle)
    throw new Error("Continuity requires two separately retained app bundles.");
  for (const prior of previous.targets) {
    const current = next.targets.find(
      (target) => target.relative === prior.relative,
    );
    if (
      !current ||
      current.identifier !== prior.identifier ||
      current.certificateFingerprint !== prior.certificateFingerprint
    )
      throw new Error(
        "The update changed a permission-relevant signing identity.",
      );
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--test-requirement",
      `=${prior.designatedRequirement}`,
      path.join(next.bundle, current.relative),
    ]);
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--test-requirement",
      `=${current.designatedRequirement}`,
      path.join(previous.bundle, prior.relative),
    ]);
  }
  return { verified: true, previous: previous.bundle, next: next.bundle };
}

/** Preserve electron-builder's normal nested-code signing, entitlements and DR. */
export function pinnedSigner(fingerprint, signAsync) {
  const pin = normalizeSigningFingerprint(fingerprint);
  return async (options) => {
    if (options.platform !== "darwin")
      throw new Error(
        "Relay's stable local signer only supports macOS app bundles.",
      );
    await signAsync({
      ...options,
      identity: pin,
      // We validate the full fingerprint ourselves. Name discovery would permit
      // a different same-name certificate; codesign still validates/signs normally.
      identityValidation: false,
      ignore: [
        ...(Array.isArray(options.ignore)
          ? options.ignore
          : options.ignore
            ? [options.ignore]
            : []),
        knownResourceSigningIgnore(options.app),
      ],
    });
  };
}

function parseArguments(args) {
  const options = {
    arch: process.arch,
    output: "release/stable",
    skipBuild: false,
    install: false,
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--skip-build") options.skipBuild = true;
    else if (flag === "--install") options.install = true;
    else if (
      ["--identity", "--arch", "--output", "--previous", "--verify"].includes(
        flag,
      )
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${flag}.`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown argument: ${flag}.`);
  }
  if (options.identity)
    options.identity = normalizeSigningFingerprint(options.identity);
  if (!["arm64", "x64"].includes(options.arch))
    throw new Error("Use --arch arm64 or x64.");
  return options;
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("Stable macOS signing requires macOS.");
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  if (!options.identity) {
    const file = path.join(root, "config/local-signing.json");
    let config;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
        throw new Error("Invalid local signing configuration file.");
      config = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      throw new Error(
        "Set --identity to a certificate fingerprint, or prepare config/local-signing.json. No ad-hoc fallback was used.",
        { cause: error },
      );
    }
    if (config.version !== 1)
      throw new Error("Unsupported local signing configuration version.");
    options.identity = normalizeSigningFingerprint(
      config.certificateFingerprint,
    );
  }
  // This command uses an existing identity. Importing a certificate or opening a
  // different signing keychain is a separate user action, never a build side effect.
  if (
    ["CSC_LINK", "CSC_KEYCHAIN", "CSC_KEY_PASSWORD"].some(
      (name) => process.env[name],
    )
  )
    throw new Error(
      "Unset CSC_LINK, CSC_KEYCHAIN and CSC_KEY_PASSWORD for existing-identity signing.",
    );
  const listing = execute("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  const identity = findPinnedSigningIdentity(listing, options.identity);
  const prior = options.previous
    ? await inspectStableSigning(options.previous, identity.fingerprint)
    : undefined;
  if (options.verify) {
    const report = await inspectStableSigning(
      options.verify,
      identity.fingerprint,
    );
    if (prior) report.continuity = verifySigningContinuity(prior, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const timestampPolicy = publicCertificateSigningPolicy(
    execute("/usr/bin/security", [
      "find-certificate",
      "-a",
      "-p",
      "-c",
      identity.name,
    ]),
    identity.fingerprint,
  );
  const output = path.resolve(root, options.output);
  const release = path.join(root, "release");
  if (!output.startsWith(`${release}${path.sep}`))
    throw new Error(
      "Build output must be a directory inside this workspace's release directory.",
    );
  // Packaging stays inside the workspace even if an existing path is a symlink.
  const realRoot = await fs.realpath(root);
  let existing = output;
  while (true) {
    try {
      const realExisting = await fs.realpath(existing);
      if (
        realExisting !== realRoot &&
        !realExisting.startsWith(`${realRoot}${path.sep}`)
      )
        throw new Error("Build output resolves outside this workspace.");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  const bundle = path.join(
    output,
    options.arch === "arm64" ? "mac-arm64" : "mac",
    "Relay.app",
  );
  if (prior?.bundle === bundle)
    throw new Error(
      "Choose a new output directory to retain the previous signed bundle.",
    );
  if (!options.skipBuild)
    execFileSync("npm", ["run", "build"], {
      cwd: root,
      stdio: "inherit",
    });
  const { build, Platform, Arch } = await import("electron-builder");
  const { signAsync } = await import("@electron/osx-sign");
  await build({
    projectDir: root,
    targets: Platform.MAC.createTarget("dir", Arch[options.arch]),
    config: {
      forceCodeSigning: true,
      electronDist: path.join(root, "node_modules/electron/dist"),
      directories: { output },
      mac: {
        identity: identity.fingerprint,
        sign: pinnedSigner(identity.fingerprint, signAsync),
        // A local, non-notarized build: the hardened runtime adds library
        // validation rules that a self-signed certificate cannot satisfy.
        hardenedRuntime: false,
        strictVerify: true,
        ...(timestampPolicy.timestamp
          ? { timestamp: timestampPolicy.timestamp }
          : {}),
        // Do not infer Apple ID notarization credentials for a local build.
        notarize: false,
      },
    },
  });
  const report = await inspectStableSigning(bundle, identity.fingerprint);
  report.timestampPolicy = timestampPolicy.selfSigned
    ? "local-no-server"
    : "library-default";
  if (prior) report.continuity = verifySigningContinuity(prior, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (options.install) installBundle(bundle);
}

/**
 * Replace /Applications/Relay.app with the verified bundle. Keeping one install
 * location and one certificate keeps macOS permissions across updates.
 */
function installBundle(bundle) {
  const target = "/Applications/Relay.app";
  const staged = "/Applications/.Relay.app.installing";
  const previous = "/Applications/.Relay.app.previous";
  // Copy first, then swap in place: /Applications/Relay.app is never missing,
  // so macOS cannot launch another registered Relay build in the meantime.
  execFileSync("/bin/rm", ["-rf", staged, previous]);
  execFileSync("/usr/bin/ditto", [bundle, staged]);
  try {
    execFileSync("/usr/bin/osascript", [
      "-e",
      'if application id "dev.relay.workspace" is running then tell application id "dev.relay.workspace" to quit',
    ]);
  } catch {
    // Not running, or it refused to quit.
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      execFileSync("/usr/bin/pgrep", ["-f", `${target}/Contents/MacOS/Relay`]);
    } catch {
      break; // pgrep exits non-zero when nothing matches.
    }
    execFileSync("/bin/sleep", ["0.25"]);
  }
  if (fsSync.existsSync(target)) fsSync.renameSync(target, previous);
  fsSync.renameSync(staged, target);
  execFileSync("/bin/rm", ["-rf", previous]);
  process.stdout.write(`Installed ${target}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    if (error.cause?.message) console.error(error.cause.message);
    markSigningFailure();
  });
