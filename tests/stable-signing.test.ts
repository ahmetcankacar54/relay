import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
// Build tooling is intentionally plain JavaScript for use before transpilation.
import {
  findPinnedSigningIdentity,
  inspectStableSigning,
  markSigningFailure,
  normalizeSigningFingerprint,
  pinnedSigner,
  publicCertificateSigningPolicy,
  readDesignatedRequirement,
  verifySigningContinuity,
  // @ts-expect-error The standalone build script has no declaration file.
} from "../scripts/stable-signing.mjs";

const certificate = Buffer.from("fixture public certificate");
const fingerprint = createHash("sha1")
  .update(certificate)
  .digest("hex")
  .toUpperCase();

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

test("the custom signer pins the key while retaining library signing policy and default DR", async () => {
  let received: Record<string, unknown> | undefined;
  const optionsForFile = () => ({
    hardenedRuntime: true,
    entitlements: "default.plist",
  });
  await pinnedSigner(fingerprint, async (options: Record<string, unknown>) => {
    received = options;
  })({
    app: "/fixture/Relay.app",
    platform: "darwin",
    identity: "ambiguous display name",
    optionsForFile,
    strictVerify: true,
  });
  assert.equal(received?.identity, fingerprint);
  assert.equal(received?.identityValidation, false);
  assert.equal(received?.optionsForFile, optionsForFile);
  assert.equal(received?.strictVerify, true);
  assert.equal(received?.requirements, undefined);
  await assert.rejects(
    pinnedSigner(fingerprint, async () => assert.fail("must not sign"))({
      platform: "mas",
    }),
    /only supports macOS/,
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
      : `.${path.basename(target)}`;
    const identifier = `dev.relay.workspace${name}`;
    if (args.includes("--verbose=4"))
      return `Identifier=${identifier}\n${overrides.adHoc ? "Signature=adhoc" : "Authority=Relay Local Development"}\nCDHash=1234\nSealed Resources version=2\n`;
    if (args.includes("--extract-certificates")) return "";
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
      "dev.relay.workspace.usage-keychain",
    ],
  );
  assert.equal(
    fixture.calls.filter((call) => call.args.includes("--extract-certificates"))
      .length,
    3,
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
  assert.equal(checks.length, 6);
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
