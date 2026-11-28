#!/usr/bin/env node
/**
 * Relay's macOS app (crates/relay-app, Tauri), signed with the pinned certificate so macOS keeps
 * its permissions across updates (docs/macos-local-signing.md):
 *   1. `tauri build --no-sign --bundles app` per architecture (aarch64-apple-darwin,
 *      x86_64-apple-darwin);
 *   2. the native helper desktop-automation (scripts/build-native.mjs, in dist-native/) goes to
 *      Contents/MacOS/desktop-automation, the relay CLI (crates/relay-cli) to
 *      Contents/Resources/bin/relay, where Relay 0.29 had it, and RelayWidget.appex to
 *      Contents/PlugIns/. Not Contents/MacOS/relay: macOS file systems ignore case, so that is
 *      Contents/MacOS/Relay, the app itself;
 *   3. everything is signed inside out with the pinned certificate (or ad hoc, for a local check
 *      with --ad-hoc): helper, CLI, widget (with its own entitlements), then the app with
 *      build/entitlements.mac.plist, under the hardened runtime;
 *   4. inspectStableSigning checks every permission-relevant signature;
 *   5. with --dmg, createDiskImage makes Relay-<version>-<arch>.dmg; with --install the bundle
 *      replaces /Applications/Relay.app.
 * The bundle id, the app name, the certificate and the DMG's name and layout are Relay 0.x's, so
 * its own updater installs this app in place; --previous checks that continuity against an
 * installed 0.x (Electron) or 1.x bundle.
 *
 *   node scripts/stable-signing.mjs [--arch arm64|x64|both] [--output release/stable]
 *     [--identity <sha1> | --ad-hoc] [--dmg] [--debug] [--skip-build] [--install]
 *     [--previous <Relay.app>] [--verify <Relay.app>]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildNativeHelpers,
  NATIVE_DIR,
  WIDGET_APPEX,
} from "./build-native.mjs";
import { buildRelayBinary, relayBinary, relayTarget } from "./relay-binary.mjs";
import { CLI_TARGET_DIR, runTauri, tauriVersion } from "./tauri-build.mjs";

export const APP_IDENTIFIER = "dev.relay.workspace";
/** The widget extension, inside the app; it alone is sandboxed. */
export const WIDGET_RELATIVE = "Contents/PlugIns/RelayWidget.appex";
export const WIDGET_ENTITLEMENTS = fileURLToPath(
  new URL("../native/widget/widget.entitlements", import.meta.url),
);
/** The `relay` binary the gateway runs as. */
export const RELAY_CLI_RELATIVE = "Contents/Resources/bin/relay";
export const RELAY_CLI_IDENTIFIER = `${APP_IDENTIFIER}.relay-cli`;
export const HELPER_RELATIVE = "Contents/MacOS/desktop-automation";
export const HELPER_IDENTIFIER = `${APP_IDENTIFIER}.desktop-automation`;
/** The app's entitlements: only the Apple events that quit Claude Desktop and browsers. */
export const APP_ENTITLEMENTS = fileURLToPath(
  new URL("../build/entitlements.mac.plist", import.meta.url),
);

/** The permission-relevant code of Relay's bundle. */
export const permissionTargets = [
  { relative: "", identifier: APP_IDENTIFIER },
  { relative: HELPER_RELATIVE, identifier: HELPER_IDENTIFIER },
  // chronod runs the widget by this identity; keep it the same across updates.
  { relative: WIDGET_RELATIVE, identifier: `${APP_IDENTIFIER}.widget` },
  // A plain Mach-O from cargo: no Info.plist to bind; its identifier comes at signing.
  {
    relative: RELAY_CLI_RELATIVE,
    identifier: RELAY_CLI_IDENTIFIER,
    infoPlist: false,
  },
];

/**
 * The same identities in a Relay 0.x (Electron) bundle, which kept the helper in its
 * app.asar.unpacked: what --previous compares against when the installed app is 0.x.
 */
export const LEGACY_TARGETS = permissionTargets.map((target) =>
  target.relative === HELPER_RELATIVE
    ? {
        ...target,
        relative:
          "Contents/Resources/app.asar.unpacked/dist-electron/desktop-automation",
      }
    : target,
);

/** The targets of a bundle's layout: a Relay 0.x has its app.asar. */
export function layoutTargets(bundle) {
  return fsSync.existsSync(path.join(bundle, "Contents/Resources/app.asar"))
    ? LEGACY_TARGETS
    : permissionTargets;
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
    // CA-issued Apple signing identities keep codesign's timestamp server.
    ...(selfSigned ? { timestamp: "none" } : {}),
  };
}

export function markSigningFailure(runtime = process) {
  runtime.exitCode = 1;
  // Keep the failure even if something resets exitCode during shutdown.
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

/**
 * Verifies permission-relevant binaries against the pinned public certificate. `options.targets`
 * names another bundle layout's targets (layoutTargets); `options.adHoc` checks a local ad-hoc
 * build instead (no certificate, so no fingerprint and no designated requirement to read).
 */
export async function inspectStableSigning(bundle, fingerprint, options = {}) {
  const adHoc = options.adHoc === true;
  const pin = adHoc ? undefined : normalizeSigningFingerprint(fingerprint);
  const run = options.run || execute;
  const read = options.readFile || fs.readFile;
  const root = path.resolve(bundle);
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-signing-check-"),
  );
  await fs.chmod(directory, 0o700);
  try {
    // --deep is verification only. Signing goes inside out (signingCommands).
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", root]);
    const targets = [];
    for (const [index, target] of (
      options.targets ?? permissionTargets
    ).entries()) {
      const file = path.join(root, target.relative);
      run("/usr/bin/codesign", ["--verify", "--strict", file]);
      const details = run("/usr/bin/codesign", [
        "--display",
        "--verbose=4",
        file,
      ]);
      if (
        details.match(/^Identifier=(.+)$/m)?.[1] !== target.identifier ||
        details.includes("Signature=adhoc") !== adHoc ||
        details.includes("linker-signed") ||
        (target.infoPlist !== false &&
          details.includes("Info.plist=not bound")) ||
        (target.relative === "" && details.includes("Sealed Resources=none"))
      )
        throw new Error(
          `Invalid stable signing metadata for ${target.identifier}.`,
        );
      if (adHoc) {
        targets.push({
          relative: target.relative,
          identifier: target.identifier,
          cdHash: details.match(/^CDHash=(.+)$/m)?.[1],
        });
        continue;
      }
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
    return {
      bundle: root,
      verified: true,
      signing: adHoc ? "ad-hoc" : "certificate",
      targets,
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Checks both directions so the current and next build share the same identity. */
export function verifySigningContinuity(previous, next, run = execute) {
  if (previous.bundle === next.bundle)
    throw new Error("Continuity requires two separately retained app bundles.");
  for (const prior of previous.targets) {
    // By identity, not path: a layout change (0.x to 1.x) keeps each identifier.
    const current = next.targets.find(
      (target) => target.identifier === prior.identifier,
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

function buildArchitectures(arch) {
  if (arch === "both") return ["arm64", "x64"];
  if (arch === "arm64" || arch === "x64") return [arch];
  throw new Error("Use --arch arm64, x64 or both.");
}

export function parseArguments(args, hostArch = process.arch) {
  const options = {
    arch: hostArch,
    output: "release/stable",
    adHoc: false,
    debug: false,
    dmg: false,
    install: false,
    skipBuild: false,
  };
  const switches = {
    "--ad-hoc": "adHoc",
    "--debug": "debug",
    "--dmg": "dmg",
    "--install": "install",
    "--skip-build": "skipBuild",
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (switches[flag]) options[switches[flag]] = true;
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
  if (options.adHoc && options.identity)
    throw new Error("Use --identity or --ad-hoc, not both.");
  // An ad-hoc app has no stable identity: installed, it would lose macOS permissions and the
  // Keychain's trust at the next real build; and it shares no requirement with a signed one.
  if (options.adHoc && (options.install || options.previous))
    throw new Error(
      "--ad-hoc builds are for checking only: no --install or --previous.",
    );
  options.arches = buildArchitectures(options.arch);
  if (options.install && options.arches.length > 1)
    throw new Error(
      "--install needs one architecture: use --arch arm64 or x64.",
    );
  return options;
}

/**
 * Each architecture's bundle in its own folder, arm64 in mac-arm64/ and x64 in mac/ as for every
 * Relay before, and its disk image Relay-<version>-<arch>.dmg (homebrew-cask.mjs dmgName).
 */
export function architecturePlan(output, arches, version) {
  return arches.map((arch) => ({
    arch,
    bundle: path.join(
      output,
      arch === "arm64" ? "mac-arm64" : "mac",
      "Relay.app",
    ),
    image: path.join(output, `Relay-${version}-${arch}.dmg`),
  }));
}

/** Where `tauri build` leaves the app for an architecture. */
export function tauriAppBundle(base, arch, debug = false) {
  return path.join(
    base,
    "target",
    relayTarget("darwin", arch),
    debug ? "debug" : "release",
    "bundle/macos/Relay.app",
  );
}

/**
 * The codesign calls, inside out: each nested piece before what seals it. `identity` is the
 * certificate fingerprint, or "-" for ad hoc; `timestamp` "none" skips the timestamp server.
 */
export function signingCommands(app, { identity, timestamp }) {
  const common = [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    timestamp === "none" ? "--timestamp=none" : "--timestamp",
  ];
  return [
    [
      ...common,
      "--identifier",
      HELPER_IDENTIFIER,
      "--entitlements",
      APP_ENTITLEMENTS,
      path.join(app, HELPER_RELATIVE),
    ],
    // A plain Mach-O from cargo: without --identifier codesign would name it after the file.
    [
      ...common,
      "--identifier",
      RELAY_CLI_IDENTIFIER,
      "--entitlements",
      APP_ENTITLEMENTS,
      path.join(app, RELAY_CLI_RELATIVE),
    ],
    // The App Sandbox and read access to Relay's widget folder; its identifier is its Info.plist's.
    [
      ...common,
      "--entitlements",
      WIDGET_ENTITLEMENTS,
      path.join(app, WIDGET_RELATIVE),
    ],
    [...common, "--entitlements", APP_ENTITLEMENTS, app],
  ];
}

/**
 * Copies Tauri's app to `bundle` and adds the helper, the CLI and the widget. Fails when the CLI
 * is the app's own executable: on a case-insensitive disk target/<triple>/release/relay and
 * .../Relay are one file, which relay-app's binary name (relay-app) is there to prevent.
 */
export function assembleBundle(source, bundle, { helper, cli, widget }) {
  if (
    fsSync
      .readFileSync(cli)
      .equals(fsSync.readFileSync(path.join(source, "Contents/MacOS/Relay")))
  )
    throw new Error(`${cli} is Relay's app executable, not the relay CLI.`);
  fsSync.rmSync(bundle, { recursive: true, force: true });
  fsSync.mkdirSync(path.dirname(bundle), { recursive: true });
  execFileSync("/usr/bin/ditto", [source, bundle]);
  for (const [from, relative] of [
    [helper, HELPER_RELATIVE],
    [cli, RELAY_CLI_RELATIVE],
  ]) {
    const to = path.join(bundle, relative);
    fsSync.mkdirSync(path.dirname(to), { recursive: true });
    fsSync.copyFileSync(from, to);
    fsSync.chmodSync(to, 0o755);
  }
  const plugins = path.join(bundle, WIDGET_RELATIVE);
  fsSync.mkdirSync(path.dirname(plugins), { recursive: true });
  execFileSync("/usr/bin/ditto", [widget, plugins]);
}

/** What Relay 0.x's updater and macOS read from the app's Info.plist. */
export function checkInfoPlist(bundle, version) {
  const plist = path.join(bundle, "Contents/Info.plist");
  const read = (key) =>
    execFileSync("/usr/bin/plutil", ["-extract", key, "raw", plist], {
      encoding: "utf8",
    }).trim();
  const expected = {
    CFBundleIdentifier: APP_IDENTIFIER,
    CFBundleExecutable: "Relay",
    CFBundleShortVersionString: version,
    LSMinimumSystemVersion: "14.0",
  };
  for (const [key, value] of Object.entries(expected))
    if (read(key) !== value)
      throw new Error(`${key} is ${read(key)}, not ${value}.`);
}

/**
 * The pinned identity to sign with: `fingerprint`, or config/local-signing.json's. Only an
 * existing, valid Code Signing identity in the Keychain search list; never ad hoc.
 */
export async function pinnedIdentity(root, fingerprint) {
  let pin = fingerprint;
  if (!pin) {
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
    pin = normalizeSigningFingerprint(config.certificateFingerprint);
  }
  // This command uses an existing identity. Importing a certificate or opening a
  // different signing keychain is a separate user action, never a build side effect.
  const listing = execute("/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
  ]);
  return findPinnedSigningIdentity(listing, pin);
}

/** Whether codesign asks a timestamp server: not for a self-signed certificate. */
export function signingTimestampPolicy(identity) {
  return publicCertificateSigningPolicy(
    execute("/usr/bin/security", [
      "find-certificate",
      "-a",
      "-p",
      "-c",
      identity.name,
    ]),
    identity.fingerprint,
  );
}

/** `output` resolved, required to be inside the workspace's release directory, symlinks too. */
export async function releaseOutput(root, output) {
  const resolved = path.resolve(root, output);
  const release = path.join(root, "release");
  if (!resolved.startsWith(`${release}${path.sep}`))
    throw new Error(
      "Build output must be a directory inside this workspace's release directory.",
    );
  // Packaging stays inside the workspace even if an existing path is a symlink.
  const realRoot = await fs.realpath(root);
  let existing = resolved;
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
  return resolved;
}

/**
 * Wrap the verified bundle in a DMG for another Mac, with macOS's own hdiutil:
 * no download, and the copy keeps the app's signature intact. The image itself
 * is not signed.
 */
export async function createDiskImage(bundle, image) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "relay-dmg-"));
  try {
    execFileSync("/usr/bin/ditto", [bundle, path.join(staging, "Relay.app")]);
    await fs.symlink("/Applications", path.join(staging, "Applications"));
    await fs.rm(image, { force: true });
    execFileSync(
      "/usr/bin/hdiutil",
      [
        "create",
        "-volname",
        "Relay",
        "-srcfolder",
        staging,
        "-fs",
        "HFS+",
        // LZMA: about 30% smaller than the default zlib; any Mac that runs
        // Relay (macOS 14+) opens it.
        "-format",
        "ULMO",
        image,
      ],
      { stdio: "inherit" },
    );
    execFileSync("/usr/bin/hdiutil", ["verify", image], { stdio: "inherit" });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return image;
}

/**
 * Replace /Applications/Relay.app with the verified bundle. Keeping one install
 * location and one certificate keeps macOS permissions across updates.
 */
export function installBundle(bundle) {
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
  // Register now, so the widget is in the gallery before Relay's first launch.
  try {
    execFileSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-f", "-R", target],
    );
    execFileSync("/usr/bin/pluginkit", [
      "-a",
      path.join(target, WIDGET_RELATIVE),
    ]);
  } catch {
    // Launching Relay registers it as well.
  }
  // chronod, WidgetKit's daemon, caches each extension's widget kinds; restarting it makes the
  // gallery list the new ones. launchd starts it again at once.
  try {
    execFileSync("/usr/bin/killall", ["chronod"]);
  } catch {
    // Not running.
  }
  process.stdout.write(`Installed ${target}\n`);
}

async function main() {
  if (process.platform !== "darwin")
    throw new Error("Relay's macOS build requires macOS.");
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  // build-native.mjs works from the workspace root.
  process.chdir(root);
  const identity = options.adHoc
    ? { fingerprint: "-", name: "ad hoc" }
    : await pinnedIdentity(root, options.identity);
  const inspect = (bundle, targets) =>
    inspectStableSigning(bundle, identity.fingerprint, {
      targets,
      adHoc: options.adHoc,
    });
  const prior = options.previous
    ? await inspect(options.previous, layoutTargets(options.previous))
    : undefined;
  if (options.verify) {
    const report = await inspect(options.verify, permissionTargets);
    if (prior) report.continuity = verifySigningContinuity(prior, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const timestamp = options.adHoc
    ? "none"
    : (signingTimestampPolicy(identity).timestamp ?? "server");
  const output = await releaseOutput(root, options.output);
  const version = tauriVersion(root);
  const plan = architecturePlan(output, options.arches, version);
  if (plan.some((step) => prior?.bundle === step.bundle))
    throw new Error(
      "Choose a new output directory to retain the previous signed bundle.",
    );
  if (!options.skipBuild) {
    // One universal helper and widget serve both architectures.
    await buildNativeHelpers();
    execFileSync("npm", ["run", "build:ui"], { cwd: root, stdio: "inherit" });
    for (const step of plan) {
      buildRelayBinary("darwin", step.arch, root, CLI_TARGET_DIR);
      runTauri(
        [
          "build",
          "--ci",
          "--no-sign",
          "--bundles",
          "app",
          "--target",
          relayTarget("darwin", step.arch),
          ...(options.debug ? ["--debug"] : []),
          // The UI was built once above.
          "--config",
          JSON.stringify({ build: { beforeBuildCommand: null } }),
        ],
        root,
      );
    }
  }
  for (const step of plan) {
    assembleBundle(
      tauriAppBundle(root, step.arch, options.debug),
      step.bundle,
      {
        helper: path.join(NATIVE_DIR, "desktop-automation"),
        cli: relayBinary("darwin", step.arch, root, CLI_TARGET_DIR),
        widget: path.join(NATIVE_DIR, WIDGET_APPEX),
      },
    );
    for (const args of signingCommands(step.bundle, {
      identity: identity.fingerprint,
      timestamp,
    }))
      execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
    checkInfoPlist(step.bundle, version);
    const report = await inspect(step.bundle, permissionTargets);
    report.arch = step.arch;
    if (prior) report.continuity = verifySigningContinuity(prior, report);
    if (options.dmg)
      report.diskImage = await createDiskImage(step.bundle, step.image);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.install) installBundle(plan[0].bundle);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    // A failed step wraps the tool's own error, which may wrap its output.
    for (let reason = error; reason; reason = reason.cause)
      if (reason.message) console.error(reason.message);
    markSigningFailure();
  });
