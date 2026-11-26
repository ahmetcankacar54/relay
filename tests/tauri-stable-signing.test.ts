import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inspectStableSigning,
  permissionTargets,
  verifySigningContinuity,
  WIDGET_ENTITLEMENTS,
  // @ts-expect-error The standalone build script has no declaration file.
} from "../scripts/stable-signing.mjs";
import {
  HELPER_RELATIVE,
  layoutTargets,
  parseArguments,
  signingCommands,
  TAURI_ENTITLEMENTS,
  TAURI_TARGETS,
  tauriAppBundle,
  // @ts-expect-error The standalone build script has no declaration file.
} from "../scripts/tauri-stable-signing.mjs";
import {
  CLI_TARGET_DIR,
  cliResourceConfig,
  tauriBundleOutput,
  tauriVersion,
  // @ts-expect-error The standalone build script has no declaration file.
} from "../scripts/tauri-build.mjs";

const certificate = Buffer.from("fixture public certificate");
const fingerprint = createHash("sha1")
  .update(certificate)
  .digest("hex")
  .toUpperCase();

/** codesign as the fixture app answers it: identifiers by path, ad hoc or certificate-signed. */
function fixtureRun(adHoc = false) {
  const calls: string[][] = [];
  const run = (_file: string, args: string[]) => {
    calls.push(args);
    if (args.includes("--verify")) return "";
    const target = args.at(-1)!;
    const name = target.endsWith("Relay.app")
      ? ""
      : target.endsWith("RelayWidget.appex")
        ? ".widget"
        : target.endsWith("bin/relay")
          ? ".relay-cli"
          : `.${path.basename(target)}`;
    const identifier = `dev.relay.workspace${name}`;
    if (args.includes("--verbose=4"))
      return `Identifier=${identifier}\n${adHoc ? "Signature=adhoc" : "Authority=Relay Local Development"}\nCDHash=1234\n${name === ".relay-cli" ? "Info.plist=not bound" : "Info.plist entries=20"}\nSealed Resources version=2\n`;
    if (args.some((arg) => arg.startsWith("--extract-certificates"))) return "";
    if (args.includes("--requirements"))
      return `designated => identifier "${identifier}" and certificate leaf = H"${fingerprint}"`;
    throw new Error(`Unexpected fixture signing call: ${args}`);
  };
  return {
    calls,
    options: {
      run,
      readFile: async () => certificate,
      certificateMetadata: () => ({
        subject: "CN=Relay Local Development",
        issuer: "CN=Relay Local Development",
        validTo: "fixture date",
      }),
    },
  };
}

test("the Tauri bundle keeps the Electron build's identifiers, with the helper beside the app and the CLI where 0.29 had it", () => {
  assert.deepEqual(
    TAURI_TARGETS.map((t: { identifier: string }) => t.identifier),
    permissionTargets.map((t: { identifier: string }) => t.identifier),
  );
  assert.equal(HELPER_RELATIVE, "Contents/MacOS/desktop-automation");
  const cli = TAURI_TARGETS.find(
    (t: { identifier: string }) =>
      t.identifier === "dev.relay.workspace.relay-cli",
  );
  // Never Contents/MacOS/relay: on a case-insensitive disk that is the app's own Relay.
  assert.equal(cli.relative, "Contents/Resources/bin/relay");
  assert.equal(
    cli.relative,
    permissionTargets.find(
      (t: { identifier: string }) =>
        t.identifier === "dev.relay.workspace.relay-cli",
    ).relative,
  );
  assert.equal(
    fs
      .readFileSync(TAURI_ENTITLEMENTS, "utf8")
      .match(/<key>[^<]+<\/key>/g)
      ?.join(),
    "<key>com.apple.security.automation.apple-events</key>",
  );
});

test("signing goes inside out: helper, CLI, widget with its own entitlements, then the app", () => {
  const app = "/out/Relay.app";
  const commands = signingCommands(app, { identity: "-", timestamp: "none" });
  assert.deepEqual(
    commands.map((args: string[]) => args.at(-1)),
    [
      `${app}/Contents/MacOS/desktop-automation`,
      `${app}/Contents/Resources/bin/relay`,
      `${app}/Contents/PlugIns/RelayWidget.appex`,
      app,
    ],
  );
  for (const args of commands) {
    assert.deepEqual(args.slice(0, 6), [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      "--timestamp=none",
    ]);
    assert.ok(!args.includes("--deep"));
  }
  const entitlements = commands.map(
    (args: string[]) => args[args.indexOf("--entitlements") + 1],
  );
  assert.deepEqual(entitlements, [
    TAURI_ENTITLEMENTS,
    TAURI_ENTITLEMENTS,
    WIDGET_ENTITLEMENTS,
    TAURI_ENTITLEMENTS,
  ]);
  assert.equal(
    commands[1][commands[1].indexOf("--identifier") + 1],
    "dev.relay.workspace.relay-cli",
  );
  const pinned = signingCommands(app, {
    identity: fingerprint,
    timestamp: "server",
  });
  assert.ok(pinned.every((args: string[]) => args.includes("--timestamp")));
  assert.ok(pinned.every((args: string[]) => args[2] === fingerprint));
});

test("the Tauri layout passes the stable checks; ad hoc passes only its own", async () => {
  const signed = await inspectStableSigning("/fixture/Relay.app", fingerprint, {
    ...fixtureRun().options,
    targets: TAURI_TARGETS,
  });
  assert.equal(signed.signing, "certificate");
  assert.deepEqual(
    signed.targets.map((t: { relative: string }) => t.relative),
    TAURI_TARGETS.map((t: { relative: string }) => t.relative),
  );
  const adHoc = await inspectStableSigning("/fixture/Relay.app", undefined, {
    ...fixtureRun(true).options,
    targets: TAURI_TARGETS,
    adHoc: true,
  });
  assert.equal(adHoc.signing, "ad-hoc");
  // An ad-hoc signature never passes as a release, nor a certificate one as the ad-hoc check.
  await assert.rejects(
    inspectStableSigning("/fixture/Relay.app", fingerprint, {
      ...fixtureRun(true).options,
      targets: TAURI_TARGETS,
    }),
    /Invalid stable signing metadata/,
  );
  await assert.rejects(
    inspectStableSigning("/fixture/Relay.app", undefined, {
      ...fixtureRun().options,
      targets: TAURI_TARGETS,
      adHoc: true,
    }),
    /Invalid stable signing metadata/,
  );
});

test("an Electron Relay and the Tauri one that replaces it are checked for continuity by identity", async () => {
  const fixture = fixtureRun();
  const electron = await inspectStableSigning(
    "/fixture/previous/Relay.app",
    fingerprint,
    fixture.options,
  );
  const tauri = await inspectStableSigning(
    "/fixture/next/Relay.app",
    fingerprint,
    { ...fixture.options, targets: TAURI_TARGETS },
  );
  const before = fixture.calls.length;
  assert.equal(
    verifySigningContinuity(electron, tauri, fixture.options.run).verified,
    true,
  );
  const tested = fixture.calls.slice(before).map((args) => args.at(-1));
  // Each requirement is tested against the counterpart at its own layout's path.
  assert.ok(
    tested.includes(
      "/fixture/next/Relay.app/Contents/MacOS/desktop-automation",
    ),
  );
  assert.ok(
    tested.includes(
      "/fixture/previous/Relay.app/Contents/Resources/app.asar.unpacked/dist-electron/desktop-automation",
    ),
  );
  assert.throws(
    () =>
      verifySigningContinuity(
        electron,
        {
          ...tauri,
          targets: tauri.targets.filter(
            (t: { identifier: string }) =>
              t.identifier !== "dev.relay.workspace.widget",
          ),
        },
        fixture.options.run,
      ),
    /changed a permission-relevant/,
  );
});

test("the layout of a previous bundle follows from its app.asar", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-layout-"));
  try {
    const app = path.join(dir, "Relay.app");
    fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
    assert.equal(layoutTargets(app), TAURI_TARGETS);
    fs.writeFileSync(path.join(app, "Contents/Resources/app.asar"), "");
    assert.equal(layoutTargets(app), permissionTargets);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("arguments: one stable identity or a check-only ad-hoc build", () => {
  const defaults = parseArguments([], "arm64");
  assert.equal(defaults.output, "release/tauri");
  assert.deepEqual(defaults.arches, ["arm64"]);
  assert.equal(defaults.adHoc, false);
  assert.deepEqual(parseArguments(["--arch", "both"], "arm64").arches, [
    "x64",
    "arm64",
  ]);
  assert.equal(parseArguments(["--ad-hoc", "--dmg"], "arm64").adHoc, true);
  assert.throws(
    () => parseArguments(["--ad-hoc", "--identity", fingerprint], "arm64"),
    /not both/,
  );
  assert.throws(
    () => parseArguments(["--ad-hoc", "--install"], "arm64"),
    /checking only/,
  );
  assert.throws(
    () => parseArguments(["--identity", "-"], "arm64"),
    /40-character/,
  );
  assert.throws(() => parseArguments(["--arch", "ia32"], "arm64"), /--arch/);
  assert.equal(
    tauriAppBundle("/w", "x64", true),
    "/w/target/x86_64-apple-darwin/debug/bundle/macos/Relay.app",
  );
});

test("Windows and Linux bundles carry the CLI, built apart from the app, in their resources", () => {
  assert.equal(tauriVersion(), "1.0.0");
  // Not target/<triple>/release: `tauri build` writes Relay(.exe) there, which a
  // case-insensitive disk takes for relay(.exe).
  assert.equal(CLI_TARGET_DIR, "target/cli");
  assert.deepEqual(cliResourceConfig("win32", "x86_64-pc-windows-msvc"), {
    bundle: {
      resources: {
        "../../target/cli/x86_64-pc-windows-msvc/release/relay.exe":
          "bin/relay.exe",
      },
    },
  });
  assert.deepEqual(cliResourceConfig("linux", "x86_64-unknown-linux-gnu"), {
    bundle: {
      resources: {
        "../../target/cli/x86_64-unknown-linux-gnu/release/relay": "bin/relay",
      },
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-bundle-"));
  try {
    const nsis = path.join(dir, "target/t/release/bundle/nsis");
    fs.mkdirSync(nsis, { recursive: true });
    fs.writeFileSync(path.join(nsis, "Relay_0.9.0_x64-setup.exe"), "");
    fs.writeFileSync(path.join(nsis, "Relay_1.0.0_x64-setup.exe"), "");
    assert.equal(
      tauriBundleOutput(dir, "win32", "t", "release", "1.0.0"),
      path.join(nsis, "Relay_1.0.0_x64-setup.exe"),
    );
    assert.throws(
      () => tauriBundleOutput(dir, "linux", "t", "release", "1.0.0"),
      /found 0/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
