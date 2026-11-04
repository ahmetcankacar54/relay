import type { UpdateState } from "../../shared/types";
import { compareVersions, releasePage, type UpdateDriver } from "./app-update";

/** The part of electron-updater's AppUpdater this driver uses. */
export interface ElectronUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  logger: unknown;
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean;
    updateInfo: { version: string };
    downloadPromise?: Promise<unknown> | null;
  } | null>;
  on(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  off?(event: "download-progress", listener: (info: { percent: number }) => void): unknown;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

/**
 * Windows and Linux updates through electron-updater, from the release's latest.yml or
 * latest-linux.yml: it checks, downloads and verifies (the SHA-512 in the yml) by itself, and
 * installs on `quitAndInstall`. An AppImage can only update when it runs as one (APPIMAGE set).
 */
export class ElectronUpdateDriver implements UpdateDriver {
  private ready = false;
  constructor(
    private readonly deps: {
      updater: () => Promise<ElectronUpdater>;
      current: string;
      platform: NodeJS.Platform;
      env: NodeJS.ProcessEnv;
    },
  ) {}
  async check(report: (patch: Partial<UpdateState>) => void) {
    const updater = await this.deps.updater();
    // An AppImage that does not run as one cannot replace itself: nothing to download for it.
    updater.autoDownload = !(this.deps.platform === "linux" && !this.deps.env.APPIMAGE);
    updater.autoInstallOnAppQuit = false;
    updater.logger = null;
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
      if (result.downloadPromise) {
        report({ status: "downloading", progress: last ?? 0 });
        await result.downloadPromise;
      }
      this.ready = true;
      report({ status: "ready", progress: undefined });
    } finally {
      updater.off?.("download-progress", progress);
    }
  }
  async install() {
    if (!this.ready) throw new Error("No update is ready to install.");
    const updater = await this.deps.updater();
    // Not silent: the NSIS installer shows its progress; Relay opens again when it ends.
    updater.quitAndInstall(false, true);
  }
}
