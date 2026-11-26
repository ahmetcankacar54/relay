import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Build tooling is intentionally plain JavaScript for use before transpilation.
import {
  APP_ENTITLEMENTS,
  architecturePlan,
  findPinnedSigningIdentity,
  HELPER_RELATIVE,
  inspectStableSigning,
  layoutTargets,
  LEGACY_TARGETS,
  markSigningFailure,
  normalizeSigningFingerprint,
  parseArguments,
  permissionTargets,
  publicCertificateSigningPolicy,
  WIDGET_ENTITLEMENTS,
  readDesignatedRequirement,
  signingCommands,
  tauriAppBundle,
  verifySigningContinuity,
  // @ts-expect-error The standalone build script has no declaration file.
} from "../scripts/stable-signing.mjs";
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
// The signing script runs on macOS; on Windows CI its node:path joins with backslashes.
const posix = (file: string | undefined) => file?.replaceAll("\\", "/");

test("only the exact pinned, cryptographically self-signed certificate disables server timestamping", async () => {
  const local = await fs.readFile(
    new URL("./fixtures/signing-public/selfsigned.pem", import.meta.url),
    "utf8",
  );
  const issued = await fs.readFile(
    new URL("./fixtures/signing-public/issued-same-dn.pem", import.meta.url),
    "utf8",
  );
  const localCertificate = new X509Certificate(local);
  const issuedCertificate = new X509Certificate(issued);
  const localPin = localCertificate.fingerprint.replaceAll(":", "");
  const issuedPin = issuedCertificate.fingerprint.replaceAll(":", "");
  assert.equal(localCertificate.subject, issuedCertificate.subject);
  assert.equal(issuedCertificate.subject, issuedCertificate.issuer);
  assert.equal(
    publicCertificateSigningPolicy(issued + local, localPin).timestamp,
    "none",
  );
  assert.equal(
    publicCertificateSigningPolicy(issued + local, issuedPin).selfSigned,
    false,
  );
  assert.equal(
    publicCertificateSigningPolicy(issued + local, issuedPin).timestamp,
    undefined,
  );
  assert.throws(
    () => publicCertificateSigningPolicy(local, issuedPin),
    /does not match the pinned/,
  );
});

test("a signing error remains a failed process exit even if a native dependency resets exitCode", () => {
  const runtime = Object.assign(new EventEmitter(), { exitCode: 0 });
  markSigningFailure(runtime);
  assert.equal(runtime.exitCode, 1);
  runtime.exitCode = 0;
  runtime.emit("exit");
  assert.equal(runtime.exitCode, 1);
});

test("stable signing rejects names, shortened hashes and ad-hoc identities", () => {
  for (const value of [
    "-",
    "Relay Local Development",
    fingerprint.slice(0, 8),
    null,
    " " + fingerprint,
  ])
    assert.throws(
      () => normalizeSigningFingerprint(value),
      /full 40-character/,
    );
  assert.equal(
    normalizeSigningFingerprint(fingerprint.toLowerCase()),
    fingerprint,
  );
});

test("certificate selection uses the exact fingerprint even with duplicate display names", () => {
  const other = "F".repeat(40);
  const identities = `1) ${other} "Relay Local Development"\n2) ${fingerprint} "Relay Local Development"\n2 valid identities found`;
  assert.deepEqual(findPinnedSigningIdentity(identities, fingerprint), {
    fingerprint,
    name: "Relay Local Development",
  });
  assert.throws(
    () => findPinnedSigningIdentity(identities, "A".repeat(40)),
    /No ad-hoc fallback/,
  );
  assert.throws(
    () =>
      findPinnedSigningIdentity(
        `1) ${fingerprint} "Relay Local Development" (CSSMERR_TP_NOT_TRUSTED)`,
        fingerprint,
      ),
    /No ad-hoc fallback/,
  );
});

test("stable designated requirements cannot depend on changing code hashes", () => {
  assert.throws(
    () => readDesignatedRequirement('designated => cdhash H"1234"'),
    /certificate-based/,
  );
  assert.throws(() => readDesignatedRequirement(""), /certificate-based/);
  assert.throws(
    () =>
      readDesignatedRequirement(
        'designated => identifier "dev.relay.workspace"',
      ),
    /certificate-based/,
  );
  assert.equal(
    readDesignatedRequirement(
      'Executable=/fixture\n# designated => identifier "dev.relay.workspace" and certificate leaf = H"1234"',
    ),
    'identifier "dev.relay.workspace" and certificate leaf = H"1234"',
  );
});

function fixtureRun(
  overrides: {
    wrongCertificate?: boolean;
    adHoc?: boolean;
    failDeep?: boolean;
    /** Identifiers whose signature binds no Info.plist (a plain Mach-O). */
    unboundPlist?: string[];
  } = {},
) {
  const calls: { file: string; args: string[] }[] = [];
  const run = (file: string, args: string[]) => {
    calls.push({ file, args });
    if (args.includes("--verify")) {
      if (overrides.failDeep && args.includes("--deep"))
        throw new Error("nested signature invalid");
      return "";
    }
    const target = args.at(-1)!;
    const name = target.endsWith("Relay.app")
      ? ""
      : target.endsWith("RelayWidget.appex")
        ? ".widget"
        : /bin[\\/]relay$/.test(target) // path.join's separator: \ on Windows
          ? ".relay-cli"
          : `.${path.basename(target)}`;
    const identifier = `dev.relay.workspace${name}`;
    if (args.includes("--verbose=4"))
      return `Identifier=${identifier}\n${overrides.adHoc ? "Signature=adhoc" : "Authority=Relay Local Development"}\nCDHash=1234\n${overrides.unboundPlist?.includes(identifier) ? "Info.plist=not bound" : "Info.plist entries=20"}\nSealed Resources version=2\n`;
    if (args.some((arg) => arg.startsWith("--extract-certificates"))) return "";
    if (args.includes("--requirements"))
      return `designated => identifier "${identifier}" and certificate leaf = H"${fingerprint}"`;
    throw new Error(`Unexpected fixture signing call: ${args}`);
  };
  return {
    calls,
    options: {
      run,
      readFile: async () =>
        overrides.wrongCertificate
          ? Buffer.from("different cert")
          : certificate,
      certificateMetadata: () => ({
        subject: "CN=Relay Local Development",
        issuer: "CN=Relay Local Development",
        validTo: "fixture date",
      }),
    },
  };
}

test("final artifact verification checks the actual public signing certificate on all permission targets", async () => {
  const fixture = fixtureRun();
  const report = await inspectStableSigning(
    "/fixture/Relay.app",
    fingerprint,
    fixture.options,
  );
  assert.equal(report.verified, true);
  assert.deepEqual(
    report.targets.map((target: { identifier: string }) => target.identifier),
    [
      "dev.relay.workspace",
      "dev.relay.workspace.desktop-automation",
      "dev.relay.workspace.widget",
      "dev.relay.workspace.relay-cli",
    ],
  );
  assert.equal(
    fixture.calls.filter((call) =>
      call.args.some((arg) => arg.startsWith("--extract-certificates")),
    ).length,
    4,
  );
});

test("missing trust, ad-hoc fallback and a wrong certificate fail final acceptance", async () => {
  await assert.rejects(
    inspectStableSigning(
      "/fixture/Relay.app",
      fingerprint,
      fixtureRun({ wrongCertificate: true }).options,
    ),
    /fingerprint mismatch/,
  );
  await assert.rejects(
    inspectStableSigning(
      "/fixture/Relay.app",
      fingerprint,
      fixtureRun({ adHoc: true }).options,
    ),
    /Invalid stable signing metadata/,
  );
  await assert.rejects(
    inspectStableSigning(
      "/fixture/Relay.app",
      fingerprint,
      fixtureRun({ failDeep: true }).options,
    ),
    /nested signature invalid/,
  );
});

test("only the gateway's relay binary may be signed without a bound Info.plist", async () => {
  const cli = await inspectStableSigning(
    "/fixture/Relay.app",
    fingerprint,
    fixtureRun({ unboundPlist: ["dev.relay.workspace.relay-cli"] }).options,
  );
  assert.equal(cli.verified, true);
  await assert.rejects(
    inspectStableSigning(
      "/fixture/Relay.app",
      fingerprint,
      fixtureRun({ unboundPlist: ["dev.relay.workspace.desktop-automation"] }).options,
    ),
    /Invalid stable signing metadata for dev\.relay\.workspace\.desktop-automation/,
  );
});

test("update continuity verifies old and new requirements against separately retained bundles", async () => {
  const fixture = fixtureRun();
  const previous = await inspectStableSigning(
    "/fixture/previous/Relay.app",
    fingerprint,
    fixture.options,
  );
  const next = await inspectStableSigning(
    "/fixture/next/Relay.app",
    fingerprint,
    fixture.options,
  );
  const countBefore = fixture.calls.length;
  assert.equal(
    verifySigningContinuity(previous, next, fixture.options.run).verified,
    true,
  );
  const checks = fixture.calls.slice(countBefore);
  // Two directions for each of the four targets.
  assert.equal(checks.length, 8);
  assert.ok(checks.every((call) => call.args.includes("--test-requirement")));
  assert.ok(
    checks.every((call) =>
      call.args[call.args.indexOf("--test-requirement") + 1].startsWith(
        "=identifier ",
      ),
    ),
  );
  assert.throws(
    () => verifySigningContinuity(previous, previous),
    /separately retained/,
  );
  assert.throws(
    () =>
      verifySigningContinuity(previous, {
        ...next,
        targets: [
          { ...next.targets[0], certificateFingerprint: "F".repeat(40) },
        ],
      }),
    /changed a permission-relevant/,
  );
  assert.throws(
    () =>
      verifySigningContinuity(previous, next, () => {
        throw new Error("old requirement rejected update");
      }),
    /old requirement rejected/,
  );
});

test("--arch takes arm64, x64 or both", () => {
  assert.deepEqual(parseArguments([], "arm64").arches, ["arm64"]);
  assert.deepEqual(parseArguments([], "x64").arches, ["x64"]);
  assert.deepEqual(parseArguments(["--arch", "x64"], "arm64").arches, ["x64"]);
  assert.deepEqual(parseArguments(["--arch", "arm64"], "x64").arches, [
    "arm64",
  ]);
  for (const host of ["arm64", "x64"])
    assert.deepEqual(parseArguments(["--arch", "both"], host).arches, [
      "arm64",
      "x64",
    ]);
  for (const arch of ["universal", "ia32", "arm64,x64"])
    assert.throws(
      () => parseArguments(["--arch", arch], "arm64"),
      /Use --arch arm64, x64 or both\./,
    );
  assert.throws(() => parseArguments(["--arch"], "arm64"), /Missing value/);
});

test("the share command's other options are parsed as before", () => {
  const options = parseArguments(
    ["--dmg", "--arch", "both", "--output", "release/share", "--skip-build"],
    "arm64",
  );
  assert.equal(options.dmg, true);
  assert.equal(options.skipBuild, true);
  assert.equal(options.install, false);
  assert.equal(options.output, "release/share");
  assert.equal(parseArguments([], "arm64").output, "release/stable");
  assert.equal(
    parseArguments(["--identity", fingerprint.toLowerCase()], "arm64").identity,
    fingerprint,
  );
  assert.throws(() => parseArguments(["--fast"], "arm64"), /Unknown argument/);
  // One app goes to /Applications: installing needs a single architecture.
  assert.equal(parseArguments(["--install"], "arm64").install, true);
  assert.throws(
    () => parseArguments(["--install", "--arch", "both"], "arm64"),
    /--install needs one architecture/,
  );
});

test("the share script builds both disk images in one run", async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts["dist:mac:share"],
    "node scripts/stable-signing.mjs --dmg --arch both --output release/share",
  );
});

test("each architecture has its own bundle folder and disk image", () => {
  const output = path.resolve("release/share");
  assert.deepEqual(architecturePlan(output, ["arm64", "x64"], "1.0.0"), [
    {
      arch: "arm64",
      bundle: path.join(output, "mac-arm64", "Relay.app"),
      image: path.join(output, "Relay-1.0.0-arm64.dmg"),
    },
    {
      arch: "x64",
      bundle: path.join(output, "mac", "Relay.app"),
      image: path.join(output, "Relay-1.0.0-x64.dmg"),
    },
  ]);
});

test("the widget's entitlements are only its sandbox and read access to Relay's widget folder", async () => {
  const xml = await fs.readFile(WIDGET_ENTITLEMENTS, "utf8");
  assert.deepEqual(
    [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]),
    [
      "com.apple.security.app-sandbox",
      "com.apple.security.temporary-exception.files.home-relative-path.read-only",
    ],
  );
  assert.match(xml, /<string>\/Library\/Application Support\/Relay\/widget\/<\/string>/);
});

test("the app's only entitlement is the Apple events that quit Claude Desktop and browsers", async () => {
  const xml = await fs.readFile(APP_ENTITLEMENTS, "utf8");
  assert.deepEqual(
    [...xml.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]),
    ["com.apple.security.automation.apple-events"],
  );
  assert.equal(xml.match(/<true\/>/g)?.length, 1);
});

test("an update from a build without the widget passes continuity: only the previous targets are compared", async () => {
  const fixture = fixtureRun();
  const next = await inspectStableSigning("/fixture/next/Relay.app", fingerprint, fixture.options);
  const previous = await inspectStableSigning("/fixture/previous/Relay.app", fingerprint, fixture.options);
  previous.targets = previous.targets.filter(
    (target: { identifier: string }) => target.identifier !== "dev.relay.workspace.widget",
  );
  assert.equal(verifySigningContinuity(previous, next, fixture.options.run).verified, true);
});

test("the bundle keeps 0.x's identifiers, with the helper beside the app and the CLI where 0.29 had it", () => {
  assert.deepEqual(
    permissionTargets.map((t: { identifier: string }) => t.identifier),
    LEGACY_TARGETS.map((t: { identifier: string }) => t.identifier),
  );
  assert.equal(HELPER_RELATIVE, "Contents/MacOS/desktop-automation");
  const cli = permissionTargets.find(
    (t: { identifier: string }) =>
      t.identifier === "dev.relay.workspace.relay-cli",
  );
  // Never Contents/MacOS/relay: on a case-insensitive disk that is the app's own Relay.
  assert.equal(cli.relative, "Contents/Resources/bin/relay");
  assert.equal(
    cli.relative,
    LEGACY_TARGETS.find(
      (t: { identifier: string }) =>
        t.identifier === "dev.relay.workspace.relay-cli",
    ).relative,
  );
});

test("signing goes inside out: helper, CLI, widget with its own entitlements, then the app", () => {
  const app = "/out/Relay.app";
  const commands = signingCommands(app, { identity: "-", timestamp: "none" });
  assert.deepEqual(
    commands.map((args: string[]) => posix(args.at(-1))),
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
    APP_ENTITLEMENTS,
    APP_ENTITLEMENTS,
    WIDGET_ENTITLEMENTS,
    APP_ENTITLEMENTS,
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

test("an ad-hoc check build passes only the ad-hoc checks", async () => {
  const adHoc = await inspectStableSigning("/fixture/Relay.app", undefined, {
    ...fixtureRun({ adHoc: true }).options,
    adHoc: true,
  });
  assert.equal(adHoc.signing, "ad-hoc");
  assert.deepEqual(
    adHoc.targets.map((t: { relative: string }) => t.relative),
    permissionTargets.map((t: { relative: string }) => t.relative),
  );
  // A certificate signature never passes as the ad-hoc check.
  await assert.rejects(
    inspectStableSigning("/fixture/Relay.app", undefined, {
      ...fixtureRun().options,
      adHoc: true,
    }),
    /Invalid stable signing metadata/,
  );
});

test("an installed Relay 0.x and the 1.x that replaces it are checked for continuity by identity", async () => {
  const fixture = fixtureRun();
  const legacy = await inspectStableSigning(
    "/fixture/previous/Relay.app",
    fingerprint,
    { ...fixture.options, targets: LEGACY_TARGETS },
  );
  const next = await inspectStableSigning(
    "/fixture/next/Relay.app",
    fingerprint,
    fixture.options,
  );
  const before = fixture.calls.length;
  assert.equal(
    verifySigningContinuity(legacy, next, fixture.options.run).verified,
    true,
  );
  const tested = fixture.calls
    .slice(before)
    .map((call) => posix(call.args.at(-1)));
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
        legacy,
        {
          ...next,
          targets: next.targets.filter(
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
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "relay-layout-"));
  try {
    const app = path.join(dir, "Relay.app");
    fsSync.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
    assert.equal(layoutTargets(app), permissionTargets);
    fsSync.writeFileSync(path.join(app, "Contents/Resources/app.asar"), "");
    assert.equal(layoutTargets(app), LEGACY_TARGETS);
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

test("arguments: one stable identity or a check-only ad-hoc build", () => {
  assert.equal(parseArguments([], "arm64").adHoc, false);
  assert.equal(parseArguments(["--ad-hoc", "--dmg"], "arm64").adHoc, true);
  assert.equal(parseArguments(["--debug"], "arm64").debug, true);
  assert.throws(
    () => parseArguments(["--ad-hoc", "--identity", fingerprint], "arm64"),
    /not both/,
  );
  assert.throws(
    () => parseArguments(["--ad-hoc", "--install"], "arm64"),
    /checking only/,
  );
  assert.throws(
    () =>
      parseArguments(["--ad-hoc", "--previous", "/Applications/Relay.app"], "arm64"),
    /checking only/,
  );
  assert.throws(
    () => parseArguments(["--identity", "-"], "arm64"),
    /40-character/,
  );
  assert.equal(
    posix(tauriAppBundle("/w", "x64", true)),
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
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "relay-bundle-"));
  try {
    const nsis = path.join(dir, "target/t/release/bundle/nsis");
    fsSync.mkdirSync(nsis, { recursive: true });
    fsSync.writeFileSync(path.join(nsis, "Relay_0.9.0_x64-setup.exe"), "");
    fsSync.writeFileSync(path.join(nsis, "Relay_1.0.0_x64-setup.exe"), "");
    assert.equal(
      tauriBundleOutput(dir, "win32", "t", "release", "1.0.0"),
      path.join(nsis, "Relay_1.0.0_x64-setup.exe"),
    );
    assert.throws(
      () => tauriBundleOutput(dir, "linux", "t", "release", "1.0.0"),
      /found 0/,
    );
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});
