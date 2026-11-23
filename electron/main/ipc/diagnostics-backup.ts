/** Settings → Advanced: diagnostics, account backups and removing Relay's data. */
import { app, shell } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MIN_BACKUP_PASSPHRASE } from "../../../shared/backup";
import { antigravityAccountRisks } from "../../../shared/feature-risk";
import {
  applyBackup,
  chooseBackup,
  exportBackup,
  forgetPendingBackup,
  pendingBackup,
  readBackup,
} from "../backup";
import { resetData } from "../data-reset";
import { proxySettings } from "../gateway";
import { service } from "../state";
import { exportDiagnostics } from "../windows";
import type { IpcKit } from "./index";
export function registerDiagnosticsBackupIpc({ handle, requireRisk }: IpcKit) {
  // Takes no argument: the renderer cannot name a path to reveal.
  handle("show-diagnostics", async () => {
    // Only these fixed files in the user data folder; no path comes from the renderer.
    const folder = app.getPath("userData");
    const isFile = (file: string) =>
      fsp
        .stat(file)
        .then((stat) => stat.isFile())
        .catch(() => false);
    for (const name of ["draft-events.json", "usage-issues.json"]) {
      const file = path.join(folder, name);
      if (await isFile(file)) return shell.showItemInFolder(file);
    }
    // Neither exists yet: open the folder itself rather than highlight it in its parent.
    const failure = await shell.openPath(folder);
    if (failure) throw new Error(failure);
  });
  // Takes no argument: main picks the files and the save dialog picks the place.
  handle("export-diagnostics", () => exportDiagnostics());
  // Account backups: the page passes the passphrase and choices, never a path; dialogs pick files.
  handle("backup-export", (input) => {
    const { passphrase, includeSignIns } = z
      .object({ passphrase: z.string().min(MIN_BACKUP_PASSPHRASE).max(1024), includeSignIns: z.boolean() })
      .strict()
      .parse(input);
    return exportBackup(passphrase, includeSignIns);
  });
  handle("backup-choose", () => chooseBackup());
  handle("backup-open", (passphrase) => readBackup(z.string().min(1).max(1024).parse(passphrase)));
  handle("backup-import", (input) => {
    const mode = z.enum(["merge", "replace"]).parse(input);
    // Antigravity accounts the import adds are on the risk ladder: accepted first, as when added by hand.
    const here = new Set(service.store.state.accounts.map((account) => account.id));
    if (
      pendingBackup?.opened?.payload.accounts.some(
        (account) => account.provider === "antigravity" && (mode === "replace" || !here.has(account.id)),
      )
    )
      requireRisk(antigravityAccountRisks(proxySettings().enabled));
    return applyBackup(mode);
  });
  handle("backup-cancel", () => {
    forgetPendingBackup();
  });
  handle("reset-data", () => resetData());
}
