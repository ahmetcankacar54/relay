#!/usr/bin/env node
/**
 * Relay 1.0's macOS app (crates/relay-app, Tauri), signed like the Electron builds of
 * scripts/stable-signing.mjs, which Phase 6 replaces with this:
 *   1. `tauri build --no-sign --bundles app` per architecture (aarch64-apple-darwin,
 *      x86_64-apple-darwin);
 *   2. the native helper desktop-automation (scripts/build-native.mjs) goes to
 *      Contents/MacOS/desktop-automation, the relay CLI (crates/relay-cli) to
 *      Contents/Resources/bin/relay, where Relay 0.29 had it, and RelayWidget.appex to
 *      Contents/PlugIns/. Not Contents/MacOS/relay: macOS file systems ignore case, so that is
 *      Contents/MacOS/Relay, the app itself;
 *   3. everything is signed inside out with the pinned certificate (or ad hoc, for a local check
 *      with --ad-hoc): helper, CLI, widget (with its own entitlements), then the app with
 *      build/entitlements.tauri.plist, under the hardened runtime;
 *   4. stable-signing.mjs's inspectStableSigning checks the Tauri layout;
 *   5. with --dmg, the same createDiskImage makes Relay-<version>-<arch>.dmg.
 * The bundle id, the app name, the certificate and the DMG's name and layout are the Electron
 * build's, so Relay 0.x's own updater (electron/core/mac-update.ts) installs it in place.
 *
 *   node scripts/tauri-stable-signing.mjs [--arch arm64|x64|both] [--output release/tauri]
 *     [--identity <sha1> | --ad-hoc] [--dmg] [--debug] [--skip-build] [--install]
 *     [--previous <Relay.app>] [--verify <Relay.app>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNativeHelpers, WIDGET_APPEX } from "./build-native.mjs";
import { buildRelayBinary, relayBinary, relayTarget } from "./relay-binary.mjs";
import {
  APP_IDENTIFIER,
  architecturePlan,
  createDiskImage,
  inspectStableSigning,
  installBundle,
  markSigningFailure,
  normalizeSigningFingerprint,
  permissionTargets,
  pinnedIdentity,
  RELAY_CLI_IDENTIFIER,
  RELAY_CLI_RELATIVE,
  releaseOutput,
  signingTimestampPolicy,
  verifySigningContinuity,
  WIDGET_ENTITLEMENTS,
  WIDGET_RELATIVE,
} from "./stable-signing.mjs";
import { CLI_TARGET_DIR, runTauri, tauriVersion } from "./tauri-build.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The Tauri app's entitlements: only the Apple events that quit Claude Desktop and browsers. */
export const TAURI_ENTITLEMENTS = fileURLToPath(
  new URL("../build/entitlements.tauri.plist", import.meta.url),
);
export const HELPER_RELATIVE = "Contents/MacOS/desktop-automation";
export const HELPER_IDENTIFIER = `${APP_IDENTIFIER}.desktop-automation`;

/** The Tauri bundle's permission-relevant code, with the Electron build's identifiers. */
export const TAURI_TARGETS = [
  { relative: "", identifier: APP_IDENTIFIER },
  { relative: HELPER_RELATIVE, identifier: HELPER_IDENTIFIER },
  { relative: WIDGET_RELATIVE, identifier: `${APP_IDENTIFIER}.widget` },
  {
    relative: RELAY_CLI_RELATIVE,
    identifier: RELAY_CLI_IDENTIFIER,
    infoPlist: false,
  },
];

/** The targets of a bundle's layout: an Electron Relay has its app.asar. */
export function layoutTargets(bundle) {
  return fs.existsSync(path.join(bundle, "Contents/Resources/app.asar"))
    ? permissionTargets
    : TAURI_TARGETS;
}

function buildArchitectures(arch, hostArch) {
  if (arch === "both")
    return hostArch === "x64" ? ["arm64", "x64"] : ["x64", "arm64"];
  if (arch === "arm64" || arch === "x64") return [arch];
  throw new Error("Use --arch arm64, x64 or both.");
}

export function parseArguments(args, hostArch = process.arch) {
  const options = {
    arch: hostArch,
    output: "release/tauri",
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
  options.arches = buildArchitectures(options.arch, hostArch);
  if (options.install && options.arches.length > 1)
    throw new Error(
      "--install needs one architecture: use --arch arm64 or x64.",
    );
  return options;
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
      TAURI_ENTITLEMENTS,
      path.join(app, HELPER_RELATIVE),
    ],
    // A plain Mach-O from cargo: without --identifier codesign would name it after the file.
    [
      ...common,
      "--identifier",
      RELAY_CLI_IDENTIFIER,
      "--entitlements",
      TAURI_ENTITLEMENTS,
      path.join(app, RELAY_CLI_RELATIVE),
    ],
    // The App Sandbox and read access to Relay's widget folder; its identifier is its Info.plist's.
    [
      ...common,
      "--entitlements",
      WIDGET_ENTITLEMENTS,
      path.join(app, WIDGET_RELATIVE),
    ],
    [...common, "--entitlements", TAURI_ENTITLEMENTS, app],
  ];
}

/**
 * Copies Tauri's app to `bundle` and adds the helper, the CLI and the widget. Fails when the CLI
 * is the app's own executable: on a case-insensitive disk target/<triple>/release/relay and
 * .../Relay are one file, which relay-app's binary name (relay-app) is there to prevent.
 */
export function assembleBundle(source, bundle, { helper, cli, widget }) {
  if (
    fs
      .readFileSync(cli)
      .equals(fs.readFileSync(path.join(source, "Contents/MacOS/Relay")))
  )
    throw new Error(`${cli} is Relay's app executable, not the relay CLI.`);
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  execFileSync("/usr/bin/ditto", [source, bundle]);
  for (const [from, relative] of [
    [helper, HELPER_RELATIVE],
    [cli, RELAY_CLI_RELATIVE],
  ]) {
    const to = path.join(bundle, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o755);
  }
  const plugins = path.join(bundle, WIDGET_RELATIVE);
  fs.mkdirSync(path.dirname(plugins), { recursive: true });
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

async function main() {
  if (process.platform !== "darwin")
    throw new Error("Relay's macOS build requires macOS.");
  const options = parseArguments(process.argv.slice(2));
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
    const report = await inspect(options.verify, TAURI_TARGETS);
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
  const native = path.join(root, "dist-electron");
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
        helper: path.join(native, "desktop-automation"),
        cli: relayBinary("darwin", step.arch, root, CLI_TARGET_DIR),
        widget: path.join(native, WIDGET_APPEX),
      },
    );
    for (const args of signingCommands(step.bundle, {
      identity: identity.fingerprint,
      timestamp,
    }))
      execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
    checkInfoPlist(step.bundle, version);
    const report = await inspect(step.bundle, TAURI_TARGETS);
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
    for (let reason = error; reason; reason = reason.cause)
      if (reason.message) console.error(reason.message);
    markSigningFailure();
  });
