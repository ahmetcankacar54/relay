import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
// Release tooling is plain JavaScript, run before any transpilation.
import {
  createSigningKey,
  embeddedPublicKey,
  formatSums,
  loadSigningKey,
  localSums,
  mergeSums,
  parseSums,
  publicKeyBase64,
  publicKeyFingerprint,
  releaseAssetNames,
  signSums,
  verifySums,
  // @ts-expect-error The standalone release script has no declaration file.
} from "../scripts/update-signing.mjs";
import {
  caskFromSums,
  dmgName,
  renderCask,
  // @ts-expect-error The standalone release script has no declaration file.
} from "../scripts/homebrew-cask.mjs";
// @ts-expect-error The standalone build script has no declaration file.
import { architecturePlan } from "../scripts/stable-signing.mjs";
import { parseChecksums } from "../electron/core/app-update";
import { signedBy } from "../electron/core/win-linux-update";
import { UPDATE_SIGNING_PUBLIC_KEY } from "../electron/core/update-signing-key";

const temp = (t: { after(fn: () => void): void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-signing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const hex = (text: string) => createHash("sha256").update(text).digest("hex");

test("the sums a release script signs are the sums the app accepts, and nothing else", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = publicKeyBase64(privateKey);
  const text = formatSums(
    new Map([
      ["Relay-Setup-1.2.3-x64.exe", hex("exe")],
      ["latest.yml", hex("yml")],
    ]),
  );
  const signature = signSums(text, privateKey);
  assert.equal(verifySums(text, signature, publicKey), true);
  assert.equal(signedBy(text, signature, publicKey), true);
  // One changed character in the sums, another key, or a garbled signature: refused by both.
  const tampered = text.replace(/^./, (c: string) => (c === "0" ? "1" : "0"));
  const other = publicKeyBase64(generateKeyPairSync("ed25519").privateKey);
  for (const [sums, sig, key] of [
    [tampered, signature, publicKey],
    [text, signature, other],
    [text, "AAAA", publicKey],
    [text, signature, "not a key"],
  ]) {
    assert.equal(verifySums(sums, sig, key), false);
    assert.equal(signedBy(sums, sig, key), false);
  }
  // A key of another kind is never the update key.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .publicKey.export({ type: "spki", format: "der" })
    .toString("base64");
  assert.equal(signedBy(text, signature, rsa), false);
});

test("the app embeds a well-formed Ed25519 public key, the one the scripts check against", () => {
  assert.equal(embeddedPublicKey(), UPDATE_SIGNING_PUBLIC_KEY);
  // 12-byte Ed25519 SPKI header and a 32-byte key.
  assert.equal(Buffer.from(UPDATE_SIGNING_PUBLIC_KEY, "base64").length, 44);
  assert.match(
    publicKeyFingerprint(UPDATE_SIGNING_PUBLIC_KEY),
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(signedBy("x", "AAAA", UPDATE_SIGNING_PUBLIC_KEY), false);
});

test("the signing key comes from the environment or a private file, and is never overwritten", (t) => {
  const dir = temp(t);
  const file = path.join(dir, "nested", "update-signing-ed25519.pem");
  assert.equal(
    loadSigningKey({ RELAY_UPDATE_SIGNING_KEY_FILE: file }),
    undefined,
  );
  const created = createSigningKey(file);
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createSigningKey(file);
  assert.equal(publicKeyBase64(again), publicKeyBase64(created));
  assert.equal(
    publicKeyBase64(loadSigningKey({ RELAY_UPDATE_SIGNING_KEY_FILE: file })),
    publicKeyBase64(created),
  );
  // The PEM itself, as a CI secret, wins over any file.
  const pem = generateKeyPairSync("ed25519").privateKey;
  const fromEnv = loadSigningKey({
    RELAY_UPDATE_SIGNING_KEY: pem
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    RELAY_UPDATE_SIGNING_KEY_FILE: file,
  });
  assert.equal(publicKeyBase64(fromEnv), publicKeyBase64(pem));
  // Another kind of key is refused.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.throws(
    () => loadSigningKey({ RELAY_UPDATE_SIGNING_KEY: rsa }),
    /not an Ed25519 key/,
  );
  if (process.platform === "win32") return;
  // A key file others can read is refused.
  fs.chmodSync(file, 0o644);
  assert.throws(
    () => loadSigningKey({ RELAY_UPDATE_SIGNING_KEY_FILE: file }, "darwin"),
    /chmod 600/,
  );
});

test("sums cover the release files only, read back the way the app reads them, and merge", (t) => {
  const dir = temp(t);
  for (const name of [
    "Relay-1.2.3-arm64.dmg",
    "INSTALL.txt",
    "SHA256SUMS.txt",
    "SHA256SUMS.txt.sig",
    ".DS_Store",
    "builder-debug.yml",
  ])
    fs.writeFileSync(path.join(dir, name), name);
  fs.mkdirSync(path.join(dir, "mac-arm64"));
  assert.deepEqual(releaseAssetNames(dir), [
    "INSTALL.txt",
    "Relay-1.2.3-arm64.dmg",
  ]);
  const local = localSums(dir);
  assert.equal(
    local.get("Relay-1.2.3-arm64.dmg"),
    hex("Relay-1.2.3-arm64.dmg"),
  );
  // The Windows build's lines stay; this build's own file replaces an older line for it.
  const remote = new Map([
    ["Relay-Setup-1.2.3-x64.exe", hex("exe")],
    ["INSTALL.txt", hex("old notes")],
  ]);
  const text = formatSums(mergeSums(remote, local));
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  const app = parseChecksums(text);
  assert.deepEqual([...parseSums(text)].sort(), [...app].sort());
  assert.equal(app.get("INSTALL.txt"), hex("INSTALL.txt"));
  assert.equal(app.get("Relay-Setup-1.2.3-x64.exe"), hex("exe"));
});

test("the Homebrew cask points at the DMGs the release uploads, per architecture", () => {
  // The names stable-signing.mjs writes are the names the cask downloads.
  const plan = architecturePlan("/out", ["arm64", "x64"], "1.2.3");
  assert.deepEqual(
    plan.map((step: { image: string }) => path.basename(step.image)),
    [dmgName("1.2.3", "arm64"), dmgName("1.2.3", "x64")],
  );
  const both = caskFromSums(
    "1.2.3",
    `${hex("arm")}  Relay-1.2.3-arm64.dmg\n${hex("intel")}  Relay-1.2.3-x64.dmg\n${hex("exe")}  Relay-Setup-1.2.3-x64.exe\n`,
  );
  assert.match(both, /^cask "relay" do\n {2}arch arm: "arm64", intel: "x64"\n/);
  assert.match(both, /version "1\.2\.3"/);
  assert.ok(
    both.includes(
      `sha256 arm:   "${hex("arm")}",\n         intel: "${hex("intel")}"`,
    ),
  );
  assert.ok(
    both.includes(
      `url "https://github.com/ahmetcankacar54/relay/releases/download/v#{version}/Relay-#{version}-#{arch}.dmg"`,
    ),
  );
  assert.ok(!both.includes("depends_on arch"));
  // The one-time Gatekeeper step is explained; quarantine is never removed behind the user's back.
  assert.match(both, /caveats <<~EOS[\s\S]*Open Anyway[\s\S]*EOS/);
  assert.doesNotMatch(both, /xattr|quarantine|postflight/);
  assert.match(both, /app "Relay\.app"/);
  assert.match(
    both,
    /zap trash: \[[\s\S]*"~\/Library\/Application Support\/Relay"/,
  );
  // A release without an Intel DMG gives an Apple silicon only cask.
  const armOnly = caskFromSums(
    "1.2.3",
    `${hex("arm")}  Relay-1.2.3-arm64.dmg\n`,
  );
  assert.ok(armOnly.includes(`sha256 "${hex("arm")}"`));
  assert.ok(armOnly.includes("/Relay-#{version}-arm64.dmg"));
  assert.match(armOnly, /depends_on arch: :arm64/);
  assert.throws(
    () => caskFromSums("1.2.3", `${hex("intel")}  Relay-1.2.3-x64.dmg\n`),
    /arm64 DMG/,
  );
  assert.throws(
    () => renderCask({ version: "latest", arm64: hex("arm") }),
    /Not a release version/,
  );
});

test("the cask in packaging/homebrew is the renderer's output for a real release", () => {
  const cask = fs.readFileSync(
    path.join(import.meta.dirname, "../packaging/homebrew/Casks/relay.rb"),
    "utf8",
  );
  const version = cask.match(/version "(\d+\.\d+\.\d+)"/)?.[1];
  const arm64 = cask.match(/sha256 (?:arm: +)?"([0-9a-f]{64})"/)?.[1];
  const x64 = cask.match(/intel: "([0-9a-f]{64})"/)?.[1];
  assert.ok(version && arm64);
  assert.equal(cask, renderCask({ version, arm64, x64 }));
});
