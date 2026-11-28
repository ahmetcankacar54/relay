#!/usr/bin/env node
/**
 * Atomic, race-condition-free release publishing pipeline, run on the Mac that holds the signing
 * certificate. Windows and Linux assets come from the Release workflow, which attaches them to
 * the same draft release on tag push (docs/development.md, "Releasing").
 *
 * Enforces the industry best practice:
 * 1. Pre-flight checks: clean git tree, on main branch, typecheck and test verification.
 * 2. Builds local release artifacts: the signed macOS DMGs for Apple silicon and Intel
 *    (scripts/stable-signing.mjs; the version is crates/relay-app/tauri.conf.json's), the relay
 *    CLI's macOS archives (scripts/build-cli-packages.mjs: cli/npm/dist/relay-<cli version>-
 *    <target>.tar.gz) and the install notes.
 * 3. Writes SHA256SUMS.txt over these and the files already on the release (verified), signs it
 *    with the update signing key (SHA256SUMS.txt.sig) and renders the Homebrew cask.
 * 4. Creates the GitHub release as a DRAFT first and uploads all assets.
 * 5. Verifies every asset is attached, the Windows and Linux ones included.
 * 6. Only once verified, publishes the release (removes draft status) atomically. A beta
 *    (X.Y.Z-beta.N) is published as a GitHub pre-release, with beta.yml and beta-linux.yml as its
 *    Windows and Linux updater files, and gets no Homebrew cask. Those files (latest.yml and
 *    latest-linux.yml, from scripts/electron-update-yml.mjs) are what Relay 0.x installs read.
 *
 * Usage:
 *   node scripts/publish-release.mjs [version] [--draft] [--skip-build] [--skip-tests] [--force]
 * --force skips the branch and clean-tree checks and publishes without Windows and Linux assets.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { caskFromSums, dmgName, TAP_CASK } from "./homebrew-cask.mjs";
import { releaseAssetNames, SIGNATURE_NAME, SUMS_NAME, writeReleaseSums } from "./update-signing.mjs";
import { releaseChannel } from "./release-channel.mjs";
import { CLI_TARGET_DIR, tauriVersion } from "./tauri-build.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** The relay CLI's macOS targets; build-cli-packages.mjs archives each as relay-<v>-<target>.tar.gz. */
const CLI_MAC_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

/** The archive names for the CLI's own version (crates/relay-cli/Cargo.toml), not the app's. */
function cliArchiveNames() {
  const cargo = fs.readFileSync(path.join(root, "crates/relay-cli/Cargo.toml"), "utf8");
  const cliVersion = /^\[package\][^[]*?^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (!cliVersion) throw new Error("No version in crates/relay-cli/Cargo.toml.");
  return CLI_MAC_TARGETS.map((target) => `relay-${cliVersion}-${target}.tar.gz`);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const version = positional[0] ?? tauriVersion();
const channel = releaseChannel(version);
if (!channel) {
  console.error(`❌ Invalid version: "${version}". Expected X.Y.Z or X.Y.Z-beta.N (e.g. 1.0.0, 1.1.0-beta.1)`);
  process.exit(1);
}

const isDraftOnly = flags.has("--draft");
const skipBuild = flags.has("--skip-build");
const skipTests = flags.has("--skip-tests");
const force = flags.has("--force");
const tagName = `v${version}`;
if (tauriVersion() !== version) {
  console.error(`❌ crates/relay-app/tauri.conf.json is at ${tauriVersion()}, not ${version}.`);
  process.exit(1);
}

console.log(`\n🚀 Starting Relay release pipeline for v${version}...`);

function run(cmd, cmdArgs, opts = {}) {
  console.log(`   $ ${cmd} ${cmdArgs.join(" ")}`);
  return execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
}

function runCapture(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { cwd: root, encoding: "utf8", ...opts }).trim();
}

// 1. Git pre-flight checks
console.log("\n📋 Step 1: Pre-flight git checks...");
try {
  const branch = runCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main" && !force) {
    console.error(`❌ Current branch is "${branch}", expected "main". Use --force to override.`);
    process.exit(1);
  }

  const status = runCapture("git", ["status", "--porcelain"]);
  if (status && !force) {
    console.error(`❌ Working directory is dirty:\n${status}\nCommit or stash changes first.`);
    process.exit(1);
  }

  // Verify gh CLI is logged in
  runCapture("gh", ["auth", "status"]);
  console.log("   ✅ Git branch clean and GitHub CLI authenticated.");
} catch (error) {
  console.error("❌ Git/GitHub pre-flight check failed:", error?.message || error);
  process.exit(1);
}

// 2. Automated tests & typecheck
if (!skipTests) {
  console.log("\n🧪 Step 2: Running typecheck and tests...");
  try {
    run("npm", ["run", "typecheck"]);
    run("npm", ["run", "build:ui"]);
    run("node", [
      "--import",
      "tsx",
      "--test",
      "tests/proxy-*.test.ts",
      "tests/settings-*.test.ts",
      "tests/update-signing.test.ts",
      "tests/electron-update-yml.test.ts",
    ]);
    console.log("   ✅ Typecheck and core tests passed.");
  } catch {
    console.error("❌ Tests failed. Fix issues before releasing.");
    process.exit(1);
  }
} else {
  console.log("\n⚠️ Step 2: Skipping tests (--skip-tests).");
}

// 3. Build artifacts
const shareDir = path.join(root, "release/share", version);
fs.mkdirSync(shareDir, { recursive: true });

const dmgPaths = ["arm64", "x64"].map((arch) => path.join(shareDir, dmgName(version, arch)));

if (!skipBuild && process.platform === "darwin") {
  console.log(`\n📦 Step 3: Building signed macOS DMGs (Apple silicon and Intel)...`);
  run("node", [
    path.join(root, "scripts/stable-signing.mjs"),
    "--dmg",
    "--arch",
    "both",
    "--output",
    shareDir,
  ]);
  // In the app's CLI target directory: on a case-insensitive disk target/<triple>/release/relay
  // is the Relay that `tauri build` writes (scripts/tauri-build.mjs CLI_TARGET_DIR).
  run(
    "node",
    [
      path.join(root, "scripts/build-cli-packages.mjs"),
      ...CLI_MAC_TARGETS.flatMap((target) => ["--target", target]),
    ],
    { env: { ...process.env, CARGO_TARGET_DIR: path.join(root, CLI_TARGET_DIR) } },
  );
} else if (dmgPaths.every((file) => fs.existsSync(file))) {
  console.log(`\n📦 Step 3: Using existing DMGs in ${shareDir}`);
} else {
  const missing = dmgPaths.filter((file) => !fs.existsSync(file));
  console.error(`❌ Missing ${missing.join(", ")}; build them on a Mac without --skip-build.`);
  process.exit(1);
}

// The relay CLI's macOS archives beside the DMGs; the Release workflow attaches the Windows and
// Linux ones. Optional: a release without them still publishes.
for (const name of cliArchiveNames()) {
  const archive = path.join(root, "cli/npm/dist", name);
  if (fs.existsSync(archive)) {
    fs.copyFileSync(archive, path.join(shareDir, name));
    console.log(`   CLI archive: ${name}`);
  } else if (!fs.existsSync(path.join(shareDir, name)))
    console.warn(`⚠️ No ${name} (node scripts/build-cli-packages.mjs); the release goes without it.`);
}

// 4. Gather assets, generate and sign checksums, render the cask
console.log("\n🔒 Step 4: Generating and signing checksums...");
const installNotes = path.join(root, "docs/share/install-notes.md");
const installTxt = path.join(shareDir, "INSTALL.txt");
if (fs.existsSync(installNotes)) {
  fs.copyFileSync(installNotes, installTxt);
}

let sums;
try {
  // The draft may already hold the Windows and Linux files from the Release workflow: their
  // lines are kept (verified) and the combined file is signed here.
  sums = writeReleaseSums(shareDir, { tag: tagName, requireKey: true });
} catch (error) {
  console.error(`❌ ${error.message}`);
  process.exit(1);
}

// The tap installs stable releases only: a beta reaches those who turned on pre-releases in Relay.
const caskFile = path.join(root, "release/homebrew/Casks/relay.rb");
if (!channel.prerelease) {
  fs.mkdirSync(path.dirname(caskFile), { recursive: true });
  fs.writeFileSync(caskFile, caskFromSums(version, sums.text), "utf8");
  console.log(`   Homebrew cask: ${caskFile}`);
}

const allFilesToUpload = [
  ...releaseAssetNames(shareDir).map((name) => path.join(shareDir, name)),
  path.join(shareDir, SUMS_NAME),
  path.join(shareDir, SIGNATURE_NAME),
];

console.log(`   Assets ready (${allFilesToUpload.length} files):`);
for (const file of allFilesToUpload) {
  const sizeMb = (fs.statSync(file).size / (1024 * 1024)).toFixed(2);
  console.log(`   - ${path.basename(file)} (${sizeMb} MB)`);
}

// 5. GitHub Release: Atomic Draft-First Workflow
console.log(`\n📤 Step 5: Publishing to GitHub Releases using Draft-First Best Practice...`);

let releaseExists = false;
let isCurrentlyDraft = false;

try {
  const viewJson = runCapture("gh", ["release", "view", tagName, "--json", "isDraft"]);
  releaseExists = true;
  isCurrentlyDraft = JSON.parse(viewJson).isDraft === true;
  console.log(`   Release ${tagName} exists (isDraft: ${isCurrentlyDraft}).`);
} catch {
  console.log(`   Release ${tagName} does not exist yet.`);
}

if (!releaseExists) {
  console.log(`   Creating ${tagName} as DRAFT release with attached assets...`);
  run("gh", [
    "release",
    "create",
    tagName,
    ...allFilesToUpload,
    "--title",
    tagName,
    "--draft",
    ...channel.ghFlags,
    "--generate-notes",
  ]);
  isCurrentlyDraft = true;
} else {
  console.log(`   Uploading assets to existing ${tagName} release...`);
  run("gh", ["release", "upload", tagName, ...allFilesToUpload, "--clobber"]);
}

// 6. Verify remote assets
console.log(`\n🔍 Step 6: Verifying remote GitHub assets...`);
const remoteInfo = JSON.parse(runCapture("gh", ["release", "view", tagName, "--json", "assets"]));
const remoteAssetNames = new Set(remoteInfo.assets.map((a) => a.name));

for (const name of [...allFilesToUpload.map((file) => path.basename(file)), ...sums.sums.keys()]) {
  if (!remoteAssetNames.has(name)) {
    console.error(`❌ Verification failed: ${name} is NOT present in GitHub release assets!`);
    process.exit(1);
  }
}
console.log(`   ✅ All ${remoteAssetNames.size} assets verified on GitHub.`);

// The Windows and Linux updaters read their channel's files: latest.yml and latest-linux.yml, or
// beta.yml and beta-linux.yml for a beta.
const missingPlatforms = channel.updaterFiles.filter((name) => !remoteAssetNames.has(name));
if (missingPlatforms.length > 0 && !isDraftOnly) {
  const note = `${missingPlatforms.join(" and ")} missing: the Release workflow has not attached the Windows and Linux builds yet.`;
  if (!force) {
    console.error(`❌ ${note} Wait for it and run again with --skip-build, or use --force to publish without them.`);
    process.exit(1);
  }
  console.warn(`⚠️ ${note} Publishing anyway (--force).`);
}

// 7. Atomic Publication (Undraft)
if (isDraftOnly) {
  console.log(`\n🎉 Release ${tagName} left as DRAFT as requested (--draft).`);
} else if (isCurrentlyDraft) {
  console.log(`\n📢 Step 7: Publishing release (undrafting ${tagName})...`);
  // A beta stays a pre-release also when the Release workflow made the draft.
  run("gh", ["release", "edit", tagName, "--draft=false", ...channel.ghFlags]);
  console.log(`\n🎉 SUCCESS! Relay ${tagName} is now publicly released with all assets atomically attached.`);
} else {
  console.log(`\n🎉 Release ${tagName} updated with all assets.`);
}

console.log(`   View release: https://github.com/ahmetcankacar54/relay/releases/tag/${tagName}`);
if (!channel.prerelease)
  console.log(
    `   Homebrew: copy ${path.relative(root, caskFile)} to Casks/relay.rb in ahmetcankacar54/homebrew-tap (brew install --cask ${TAP_CASK}).\n`,
  );
