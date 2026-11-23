import fs from "node:fs";
import path from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { UpdateChannel, UpdateState } from "../../shared/types";
import {
  RELEASE_REPO,
  compareVersions,
  parseChecksums,
  readCapped,
  releasePage,
  type UpdateDriver,
} from "./app-update";
import { UPDATE_CHECKSUM_MISMATCH, UPDATE_NO_CHECKSUM, UPDATE_SIGNATURE_MISMATCH } from "./mac-update";
import { UPDATE_SIGNING_PUBLIC_KEY } from "./update-signing-key";

const MAX_SUMS_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 1024;

/** The part of electron-updater's AppUpdater this driver uses. */
export interface ElectronUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  /** Setting it also turns allowDowngrade on, so the driver sets that after it. */
  channel: string | null;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo: { version: string };
    /** Resolves with the downloaded files, the installer first. */
    downloadPromise?: Promise<string[]> | null;
  } | null>;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  off?(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/** The installer a release publishes for this platform: package.json's artifactName for it. */
export function installerName(platform: NodeJS.Platform, version: string) {
  return platform === "win32" ? `Relay-Setup-${version}-x64.exe` : `Relay-${version}-x86_64.AppImage`;
}

/** A file of a release, by name. */
export const releaseFile = (version: string, name: string) =>
  `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${name}`;

/** Whether `signature` (base64 Ed25519) signs `text` under `publicKey` (SPKI DER, base64). */
export function signedBy(text: string, signature: string, publicKey: string) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature.trim(), "base64"));
  } catch {
    return false;
  }
}

async function sha256File(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Windows and Linux updates through electron-updater, from the release's latest.yml or
 * latest-linux.yml: it checks, downloads and verifies (the SHA-512 in the yml) by itself, and
 * installs on `quitAndInstall`. The yml comes from the same host as the installer, so Relay also
 * requires the release's SHA256SUMS.txt to carry a valid signature by the embedded key and to
 * list the downloaded installer, under its own name for that version; otherwise the download is
 * deleted and never installed. An AppImage can only update when it runs as one (APPIMAGE set).
 */
export class ElectronUpdateDriver implements UpdateDriver {
  private ready = false;
  constructor(
    private readonly deps: {
      updater: () => Promise<ElectronUpdater>;
      current: string;
      platform: NodeJS.Platform;
      env: NodeJS.ProcessEnv;
      /** The channel chosen in Settings, read at every check. */
      channel(): UpdateChannel;
      request?: typeof fetch;
      /** Tests sign with their own key. */
      publicKey?: string;
    },
  ) {}
  async check(report: (patch: Partial<UpdateState>) => void) {
    this.ready = false;
    const updater = await this.deps.updater();
    // An AppImage that does not run as one cannot replace itself: nothing to download for it.
    updater.autoDownload = !(this.deps.platform === "linux" && !this.deps.env.APPIMAGE);
    updater.autoInstallOnAppQuit = false;
    updater.logger = null;
    // Beta takes the newest release of either kind (its beta.yml, else latest.yml); stable only
    // the latest stable one. Stable is set explicitly: electron-updater allows pre-releases by
    // itself when the running version is one. Never a downgrade, also not after leaving beta.
    const beta = this.deps.channel() === "beta";
    updater.channel = beta ? "beta" : "latest";
    updater.allowPrerelease = beta;
    updater.allowDowngrade = false;
    // Progress can come before checkForUpdates returns: it counts once the version is known.
    let known = false;
    let last: number | undefined;
    const progress = (info: { percent: number }) => {
      last = Math.max(0, Math.min(1, info.percent / 100));
      if (known) report({ status: "downloading", progress: last });
    };
    updater.on("download-progress", progress);
    try {
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo?.version;
      if (!result || !version || compareVersions(version, this.deps.current) <= 0)
        return report({ status: "up-to-date" });
      const notesUrl = releasePage(version);
      if (this.deps.platform === "linux" && !this.deps.env.APPIMAGE)
        return report({ status: "manual", manualReason: "not-appimage", version, notesUrl });
      report({ status: "available", version, notesUrl });
      known = true;
      let files: string[] | undefined;
      if (result.downloadPromise) {
        report({ status: "downloading", progress: last ?? 0 });
        files = await result.downloadPromise;
      }
      const installer = files?.[0];
      if (!installer) throw new Error(UPDATE_CHECKSUM_MISMATCH);
      try {
        await this.verify(version, installer);
      } catch (error) {
        fs.rmSync(installer, { force: true });
        throw error;
      }
      this.ready = true;
      report({ status: "ready", progress: undefined });
    } finally {
      updater.off?.("download-progress", progress);
    }
  }
  /** The signed sums of `version` list `installer`, with its digest, under the expected name. */
  private async verify(version: string, installer: string) {
    const name = installerName(this.deps.platform, version);
    if (path.basename(installer) !== name) throw new Error(UPDATE_CHECKSUM_MISMATCH);
    const sums = await this.text(releaseFile(version, "SHA256SUMS.txt"), MAX_SUMS_BYTES).catch(() => {
      throw new Error(UPDATE_NO_CHECKSUM);
    });
    const signature = await this.text(releaseFile(version, "SHA256SUMS.txt.sig"), MAX_SIGNATURE_BYTES).catch(
      () => {
        throw new Error(UPDATE_SIGNATURE_MISMATCH);
      },
    );
    if (!signedBy(sums, signature, this.deps.publicKey ?? UPDATE_SIGNING_PUBLIC_KEY))
      throw new Error(UPDATE_SIGNATURE_MISMATCH);
    const expected = parseChecksums(sums).get(name);
    if (!expected) throw new Error(UPDATE_NO_CHECKSUM);
    if ((await sha256File(installer)) !== expected) throw new Error(UPDATE_CHECKSUM_MISMATCH);
  }
  private async text(url: string, maxBytes: number) {
    const response = await (this.deps.request ?? fetch)(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The update download failed (HTTP ${response.status}).`);
    return readCapped(response, maxBytes);
  }
  async install() {
    if (!this.ready) throw new Error("No update is ready to install.");
    const updater = await this.deps.updater();
    // Not silent: the NSIS installer shows its progress; Relay opens again when it ends.
    updater.quitAndInstall(false, true);
  }
}
