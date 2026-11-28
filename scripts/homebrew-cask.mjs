#!/usr/bin/env node
/**
 * The Homebrew cask for Relay's own tap (ahmetcankacar54/homebrew-tap), rendered for a version
 * from its release's SHA256SUMS.txt. Relay is not notarized, so the official homebrew/cask repo
 * does not take it; the cask tells the one-time Gatekeeper step in its caveats instead of
 * stripping the quarantine attribute behind the user's back.
 *
 * Usage:
 *   node scripts/homebrew-cask.mjs <version> <SHA256SUMS.txt> [--output <file>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSums } from "./update-signing.mjs";

export const TAP_CASK = "ahmetcankacar54/tap/relay";

/** The DMG name stable-signing.mjs writes for an architecture (arm64 or x64). */
export const dmgName = (version, arch) => `Relay-${version}-${arch}.dmg`;

/** Relay 1.0 and later is the Tauri app: macOS 14+, with the relay CLI inside. */
export const isTauriVersion = (version) => Number(version.split(".")[0]) >= 1;

/** The relay CLI inside the Tauri app (scripts/stable-signing.mjs puts it there). */
export const CASK_CLI = "#{appdir}/Relay.app/Contents/Resources/bin/relay";

/**
 * The cask text. Both architectures when the release has an Intel DMG; Apple silicon only
 * otherwise (releases before the first x64 build). From 1.0 the cask also links the relay CLI
 * the app carries into Homebrew's bin, and needs macOS 14 like the app.
 */
export function renderCask({ version, arm64, x64 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`Not a release version: ${version}`);
  const hex = (value, arch) => {
    if (!/^[0-9a-f]{64}$/.test(value ?? ""))
      throw new Error(`No SHA-256 for the ${arch} DMG.`);
    return value;
  };
  const tauri = isTauriVersion(version);
  const release =
    "https://github.com/ahmetcankacar54/relay/releases/download/v#{version}";
  const head = x64
    ? [
        `  arch arm: "arm64", intel: "x64"`,
        ``,
        `  version "${version}"`,
        `  sha256 arm:   "${hex(arm64, "arm64")}",`,
        `         intel: "${hex(x64, "x64")}"`,
        ``,
        `  url "${release}/Relay-#{version}-#{arch}.dmg"`,
      ]
    : [
        `  version "${version}"`,
        `  sha256 "${hex(arm64, "arm64")}"`,
        ``,
        `  url "${release}/Relay-#{version}-arm64.dmg"`,
      ];
  return `cask "relay" do
${head.join("\n")}
  name "Relay"
  desc "Switch Claude, Codex and Antigravity accounts and plan usage windows"
  homepage "https://github.com/ahmetcankacar54/relay"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Relay updates itself from its GitHub releases.
  auto_updates true
${x64 ? "" : "  depends_on arch: :arm64\n"}  depends_on macos: ${tauri ? ":sonoma" : ":ventura"}

  app "Relay.app"
${tauri ? `  binary "${CASK_CLI}"\n` : ""}
  zap trash: [
    "~/Library/Application Support/Relay",
    "~/Library/Caches/dev.relay.workspace",
    "~/Library/Caches/dev.relay.workspace.ShipIt",
    "~/Library/Containers/dev.relay.workspace.widget",
    "~/Library/HTTPStorages/dev.relay.workspace",
    "~/Library/Logs/Relay",
    "~/Library/Preferences/dev.relay.workspace.plist",
    "~/Library/Saved Application State/dev.relay.workspace.savedState",${tauri ? `\n    "~/Library/WebKit/dev.relay.workspace",` : ""}
  ]

  caveats <<~EOS
    Relay is signed with its own certificate and is not notarized by Apple,
    so macOS blocks its first launch once:
      1. Open Relay from Applications. When macOS says it cannot verify
         the app, choose Done.
      2. Open System Settings > Privacy & Security, find
         "Relay was blocked…" and choose Open Anyway, then confirm.
    A newer version may ask again. Permissions you grant Relay are kept,
    because every version is signed with the same certificate.
  EOS
end
`;
}

/** The cask for `version` from its release's SHA256SUMS.txt text. */
export function caskFromSums(version, sumsText) {
  const sums = parseSums(sumsText);
  return renderCask({
    version,
    arm64: sums.get(dmgName(version, "arm64")),
    x64: sums.get(dmgName(version, "x64")),
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const [version, sumsFile] = args.filter(
    (a, i) => !a.startsWith("--") && (outputIndex < 0 || i !== outputIndex + 1),
  );
  try {
    if (!version || !sumsFile || (outputIndex >= 0 && !output))
      throw new Error(
        "Usage: homebrew-cask.mjs <version> <SHA256SUMS.txt> [--output <file>]",
      );
    const cask = caskFromSums(version, fs.readFileSync(sumsFile, "utf8"));
    if (output) {
      fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
      fs.writeFileSync(output, cask, "utf8");
      console.log(`Wrote ${output}`);
    } else process.stdout.write(cask);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
