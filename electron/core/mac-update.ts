import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { UpdateManualReason, UpdateState } from "../../shared/types";
import {
  compareVersions,
  fetchJson,
  parseChecksums,
  readCapped,
  releaseFrom,
  type ReleaseAsset,
  type UpdateDriver,
} from "./app-update";
import type { BundlePlace } from "./install-location";

/** A DMG larger than this is not one of Relay's. */
const MAX_DMG_BYTES = 600 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const APP = "Relay.app";

export const UPDATE_CHECKSUM_MISMATCH = "The downloaded update does not match its checksum.";
export const UPDATE_SIGNATURE_MISMATCH =
  "The downloaded update is not signed like this Relay, so it was not installed.";
export const UPDATE_NO_CHECKSUM = "The release lists no checksum for the update.";

export interface MacUpdateDeps {
  /** The release feed: GitHub's latest-release JSON. */
  feed: string;
  /** `<userData>/updates`; each version gets its own folder. */
  folder: string;
  current: string;
  arch: string;
  /** The running Relay.app. */
  bundle: string;
  place(): BundlePlace;
  /** Relay's pid, which the install waits to end. */
  pid: number;
  request?: typeof fetch;
  /** Runs a command; resolves with its stdout and stderr, rejects when it fails. */
  run(file: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  /** Starts a command that outlives Relay. */
  spawnDetached(file: string, args: string[]): void;
  writable(dir: string): boolean;
}

/** The DMG for this Mac's architecture, if the release has one. */
export function dmgFor(assets: ReleaseAsset[], version: string, arch: string) {
  const want = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined;
  return want ? assets.find((a) => a.name === `Relay-${version}-${want}.dmg`) : undefined;
}

/** The running app's designated requirement, from `codesign --display --requirements -`. */
export function designatedRequirement(display: string): string {
  const requirement = display.match(/^#?\s*designated => (.+)$/m)?.[1]?.trim();
  if (!requirement || /\bcdhash\b/.test(requirement) || !/\bcertificate\s/.test(requirement))
    throw new Error(UPDATE_SIGNATURE_MISMATCH);
  return requirement;
}

/**
 * Swaps the app at TARGET for NEW once Relay (PID) has quit, keeping the old one until the new one
 * is in place and putting it back when a step fails; then opens the app. Run by bash, detached.
 * Tests override the tools it calls through RELAY_UPDATE_* variables.
 */
export const INSTALL_SCRIPT = `#!/bin/bash
set -u
PID="$1"; NEW="$2"; TARGET="$3"; LOG="$4"
OPEN="\${RELAY_UPDATE_OPEN:-/usr/bin/open}"
DITTO="\${RELAY_UPDATE_DITTO:-/usr/bin/ditto}"
LSREGISTER="\${RELAY_UPDATE_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
PLUGINKIT="\${RELAY_UPDATE_PLUGINKIT:-/usr/bin/pluginkit}"
exec >>"$LOG" 2>&1
echo "$(date '+%Y-%m-%dT%H:%M:%S') install $NEW -> $TARGET"
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then echo "Relay did not quit; nothing changed"; exit 1; fi
DIR="$(dirname "$TARGET")"; NAME="$(basename "$TARGET")"
STAGED="$DIR/.$NAME.installing"; PREVIOUS="$DIR/.$NAME.previous"
reopen() { /usr/bin/env -i "$OPEN" "$TARGET"; }
rm -rf "$STAGED" "$PREVIOUS"
if ! "$DITTO" "$NEW" "$STAGED"; then echo "copy failed; nothing changed"; rm -rf "$STAGED"; reopen; exit 1; fi
if [ -e "$TARGET" ] && ! mv "$TARGET" "$PREVIOUS"; then echo "could not move the old app; nothing changed"; rm -rf "$STAGED"; reopen; exit 1; fi
if ! mv "$STAGED" "$TARGET"; then echo "could not place the new app; old one put back"; mv "$PREVIOUS" "$TARGET"; rm -rf "$STAGED"; reopen; exit 1; fi
"$LSREGISTER" -f -R "$TARGET" || true
if [ -d "$TARGET/Contents/PlugIns/RelayWidget.appex" ]; then "$PLUGINKIT" -a "$TARGET/Contents/PlugIns/RelayWidget.appex" || true; fi
rm -rf "$PREVIOUS"
echo "installed"
reopen
`;

/**
 * macOS updates by Relay itself: the release's DMG for this Mac is downloaded, checked against
 * the release's SHA256SUMS.txt, unpacked, and accepted only when it is signed with this Relay's
 * own certificate (its designated requirement) and carries the expected version. Installing swaps
 * the app in place after Relay quits, through INSTALL_SCRIPT.
 */
export class MacUpdateDriver implements UpdateDriver {
  private ready?: { version: string; app: string };
  constructor(private readonly deps: MacUpdateDeps) {}
  private dir(version: string) {
    return path.join(this.deps.folder, version);
  }
  async check(report: (patch: Partial<UpdateState>) => void) {
    const release = releaseFrom(await fetchJson(this.deps.feed, this.deps.request));
    if (!release) throw new Error("The update feed has no usable release.");
    if (compareVersions(release.version, this.deps.current) <= 0) return report({ status: "up-to-date" });
    const { version, notesUrl } = release;
    report({ status: "available", version, notesUrl });
    const manual = (manualReason: UpdateManualReason) => report({ status: "manual", manualReason });
    const dmg = dmgFor(release.assets, version, this.deps.arch);
    const sums = release.assets.find((a) => a.name === "SHA256SUMS.txt");
    if (!dmg || !sums) return manual("no-asset");
    const dir = this.dir(version);
    const app = path.join(dir, APP);
    if (await this.verified(dir, app, version)) return this.readied(version, app, report);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const expected = parseChecksums(await this.text(sums.url)).get(dmg.name);
    if (!expected) throw new Error(UPDATE_NO_CHECKSUM);
    const file = path.join(dir, dmg.name);
    report({ status: "downloading", progress: 0 });
    const digest = await this.download(dmg, file, (progress) => report({ status: "downloading", progress }));
    if (digest !== expected) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(UPDATE_CHECKSUM_MISMATCH);
    }
    await this.unpack(file, dir);
    fs.rmSync(file, { force: true });
    await this.verify(app, version);
    fs.writeFileSync(path.join(dir, "verified.json"), JSON.stringify({ version, sha256: digest }), {
      mode: 0o600,
    });
    this.readied(version, app, report);
  }
  /** Ready to install, unless Relay cannot replace itself where it runs. */
  private readied(version: string, app: string, report: (patch: Partial<UpdateState>) => void) {
    this.ready = { version, app };
    const manualReason = this.blocked();
    report(manualReason ? { status: "manual", manualReason, progress: undefined } : { status: "ready", progress: undefined });
  }
  /** An earlier download of this version that passed every check, still intact. */
  private async verified(dir: string, app: string, version: string) {
    try {
      const marker = JSON.parse(fs.readFileSync(path.join(dir, "verified.json"), "utf8"));
      if (marker?.version !== version || !fs.existsSync(app)) return false;
      await this.verify(app, version);
      return true;
    } catch {
      return false;
    }
  }
  private async text(url: string) {
    const response = await (this.deps.request ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The update download failed (HTTP ${response.status}).`);
    return readCapped(response, MAX_SUMS_BYTES);
  }
  /** Streams `asset` to `file`; resolves with its SHA-256. */
  private async download(asset: ReleaseAsset, file: string, progress: (value: number) => void) {
    const response = await (this.deps.request ?? fetch)(asset.url, {
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`The update download failed (HTTP ${response.status}).`);
    const total = Number(response.headers.get("content-length")) || asset.size;
    if (total > MAX_DMG_BYTES) throw new Error("The update is too large.");
    const hash = createHash("sha256");
    const partial = `${file}.part`;
    const out = fs.openSync(partial, "w", 0o600);
    let received = 0;
    let shown = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DMG_BYTES) {
          await reader.cancel();
          throw new Error("The update is too large.");
        }
        hash.update(value);
        fs.writeSync(out, value);
        const now = total ? received / total : 0;
        if (now - shown >= 0.02) progress((shown = Math.min(now, 1)));
      }
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(partial, file);
    return hash.digest("hex");
  }
  /** Copies Relay.app out of the DMG into `dir`. */
  private async unpack(dmg: string, dir: string) {
    const mount = path.join(dir, "mount");
    fs.mkdirSync(mount, { mode: 0o700 });
    await this.deps.run("/usr/bin/hdiutil", [
      "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount, dmg,
    ]);
    try {
      await this.deps.run("/usr/bin/ditto", [path.join(mount, APP), path.join(dir, APP)]);
    } finally {
      await this.deps
        .run("/usr/bin/hdiutil", ["detach", mount])
        .catch(() => this.deps.run("/usr/bin/hdiutil", ["detach", "-force", mount]))
        .catch(() => undefined);
      fs.rmSync(mount, { recursive: true, force: true });
    }
  }
  /** Signed whole, with this Relay's own certificate, and the expected version. */
  private async verify(app: string, version: string) {
    const fail = () => {
      throw new Error(UPDATE_SIGNATURE_MISMATCH);
    };
    const own = await this.deps.run("/usr/bin/codesign", ["--display", "--requirements", "-", this.deps.bundle]);
    const requirement = designatedRequirement(`${own.stdout}\n${own.stderr}`);
    await this.deps.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]).catch(fail);
    await this.deps
      .run("/usr/bin/codesign", ["--verify", "--strict", "--test-requirement", `=${requirement}`, app])
      .catch(fail);
    const shown = await this.deps.run("/usr/bin/plutil", [
      "-extract", "CFBundleShortVersionString", "raw", path.join(app, "Contents", "Info.plist"),
    ]);
    if (shown.stdout.trim() !== version) fail();
  }
  /** Why it cannot install itself where it runs, or undefined when it can. */
  blocked(): UpdateManualReason | undefined {
    const place = this.deps.place();
    if (place === "disk-image" || place === "translocated") return "location";
    if (!this.deps.writable(path.dirname(this.deps.bundle))) return "not-writable";
    return undefined;
  }
  async install() {
    const ready = this.ready;
    if (!ready) throw new Error("No update is ready to install.");
    const reason = this.blocked();
    if (reason) throw new Error(reason === "location" ? MOVE_FIRST : NOT_WRITABLE);
    const dir = this.dir(ready.version);
    const script = path.join(dir, "install.sh");
    fs.writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
    this.deps.spawnDetached("/bin/bash", [
      script, String(this.deps.pid), ready.app, this.deps.bundle, path.join(this.deps.folder, "install.log"),
    ]);
  }
  /** Removes downloads of this version and older ones: once running, a version needs none. */
  prune(running = this.deps.current) {
    for (const name of fs.existsSync(this.deps.folder) ? fs.readdirSync(this.deps.folder) : [])
      if (/^\d+\.\d+\.\d+$/.test(name) && compareVersions(name, running) <= 0)
        fs.rmSync(path.join(this.deps.folder, name), { recursive: true, force: true });
  }
}

export const MOVE_FIRST =
  "Relay runs from the disk image. Move it to Applications, then update.";
export const NOT_WRITABLE =
  "Relay cannot replace itself in its folder. Download the update from the release page.";
