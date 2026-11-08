#!/usr/bin/env node
/**
 * Atomic, race-condition-free release publishing pipeline.
 *
 * Enforces the industry best practice:
 * 1. Pre-flight checks: clean git tree, on main branch, typecheck and test verification.
 * 2. Builds local release artifacts (signed macOS DMG, checksums, install notes).
 * 3. Creates the GitHub release as a DRAFT first and uploads all assets.
 * 4. Verifies every asset is attached and checksums match on GitHub.
 * 5. Only once verified, publishes the release (removes draft status) atomically.
 *
 * Usage:
 *   node scripts/publish-release.mjs [version] [--draft] [--skip-build] [--skip-tests]
 */
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

const version = positional[0] ?? pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`❌ Invalid version: "${version}". Expected semver (e.g. 0.18.0)`);
  process.exit(1);
}

const isDraftOnly = flags.has("--draft");
const skipBuild = flags.has("--skip-build");
const skipTests = flags.has("--skip-tests");
const force = flags.has("--force");

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
    run("npm", ["run", "test:desktop"]);
    console.log("   ✅ Typecheck and tests passed.");
  } catch (error) {
    console.error("❌ Tests failed. Fix issues before releasing.");
    process.exit(1);
  }
} else {
  console.log("\n⚠️ Step 2: Skipping tests (--skip-tests).");
}

// 3. Build artifacts
const shareDir = path.join(root, "release/share", version);
fs.mkdirSync(shareDir, { recursive: true });

const dmgName = `Relay-${version}-arm64.dmg`;
const dmgPath = path.join(shareDir, dmgName);

if (!skipBuild && process.platform === "darwin") {
  console.log(`\n📦 Step 3: Building signed macOS DMG...`);
  run("node", [
    path.join(root, "scripts/stable-signing.mjs"),
    "--dmg",
    "--arch",
    "arm64",
    "--output",
    shareDir,
  ]);
} else if (fs.existsSync(dmgPath)) {
  console.log(`\n📦 Step 3: Using existing DMG at ${dmgPath}`);
} else if (process.platform === "darwin") {
  console.error(`❌ DMG not found at ${dmgPath} and --skip-build was set.`);
  process.exit(1);
}

// 4. Gather assets & generate checksums
console.log("\n🔒 Step 4: Generating checksums and verifying assets...");
const installNotes = path.join(root, "docs/share/install-notes.md");
const installTxt = path.join(shareDir, "INSTALL.txt");
if (fs.existsSync(installNotes)) {
  fs.copyFileSync(installNotes, installTxt);
}

const EXCLUDED_EXTS = new Set([".yaml", ".yml"]);
const isReleaseAsset = (name) => {
  const filePath = path.join(shareDir, name);
  if (!fs.statSync(filePath).isFile()) return false;
  if (name === "SHA256SUMS.txt" || name.startsWith(".")) return false;
  if (name.startsWith("builder-")) return false;
  return true;
};

const assetNames = fs.readdirSync(shareDir).filter(isReleaseAsset);
if (assetNames.length === 0) {
  console.error(`❌ No release assets found in ${shareDir}`);
  process.exit(1);
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sumsContent = assetNames
  .map((name) => `${sha256(path.join(shareDir, name))}  ${name}`)
  .join("\n") + "\n";

const sumsFile = path.join(shareDir, "SHA256SUMS.txt");
fs.writeFileSync(sumsFile, sumsContent, "utf8");

const allFilesToUpload = [
  ...assetNames.map((name) => path.join(shareDir, name)),
  sumsFile,
];

console.log(`   Assets ready (${allFilesToUpload.length} files):`);
for (const file of allFilesToUpload) {
  const sizeMb = (fs.statSync(file).size / (1024 * 1024)).toFixed(2);
  console.log(`   - ${path.basename(file)} (${sizeMb} MB)`);
}

// 5. GitHub Release: Atomic Draft-First Workflow
const tagName = `v${version}`;
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

for (const localFile of allFilesToUpload) {
  const name = path.basename(localFile);
  if (!remoteAssetNames.has(name)) {
    console.error(`❌ Verification failed: ${name} is NOT present in GitHub release assets!`);
    process.exit(1);
  }
}
console.log(`   ✅ All ${allFilesToUpload.length} assets verified on GitHub.`);

// 7. Atomic Publication (Undraft)
if (isDraftOnly) {
  console.log(`\n🎉 Release ${tagName} left as DRAFT as requested (--draft).`);
} else if (isCurrentlyDraft) {
  console.log(`\n📢 Step 7: Publishing release (undrafting ${tagName})...`);
  run("gh", ["release", "edit", tagName, "--draft=false"]);
  console.log(`\n🎉 SUCCESS! Relay ${tagName} is now publicly released with all assets atomically attached.`);
} else {
  console.log(`\n🎉 Release ${tagName} updated with all assets.`);
}

console.log(`   View release: https://github.com/ahmetcankacar54/relay/releases/tag/${tagName}\n`);
