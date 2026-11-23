import { ipcMain } from "electron";
import { z } from "zod";
import {
  acknowledgeRisks,
  FEATURE_RISK_IDS,
  FEATURE_RISKS,
  requireRiskAck,
  type FeatureRiskId,
} from "../../../shared/feature-risk";
import { say } from "../../i18n";
import { service } from "../state";
import { broadcastChanged } from "../windows";
import { registerAccountIpc } from "./accounts";
import { registerAntigravityIpc } from "./antigravity";
import { registerAppIpc } from "./app";
import { registerContinuationIpc } from "./continuation";
import { registerDesktopIpc } from "./desktop";
import { registerDiagnosticsBackupIpc } from "./diagnostics-backup";
import { registerProxyIpc } from "./proxy";
import { registerSettingsIpc } from "./settings";
import { registerSnapshotIpc } from "./snapshots";
import { trusted } from "./trust";
/** What every group of channels registers with. */
export interface IpcKit {
  /** Registers `relay:<name>` for the main window and the menu bar panel showing Relay's own pages. */
  handle: (name: string, fn: (...args: any[]) => unknown) => void;
  /** An account, run or sign-in attempt id. */
  id: z.ZodUUID;
  /** A Claude Code session key. */
  key: z.ZodString;
  /** Refuses a risky feature until the user has accepted its risk text in the window (or the CLI's --yes). */
  requireRisk: (ids: FeatureRiskId[]) => void;
}
/** Binds every channel the main window and the menu bar panel call; once, at startup. */
export function bindIPC() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(`relay:${name}`, (event, ...args) => {
      trusted(event);
      return fn(...args);
    });
  const id = z.uuid();
  const key = z.string().min(1).max(100);
  /** Refuses a risky feature until the user has accepted its risk text in the window (or the CLI's --yes). */
  const requireRisk = (ids: FeatureRiskId[]) =>
    requireRiskAck(service.store.state.settings, ids, (pending) =>
      say("featureRisk.acceptFirst", { features: pending.map((risk) => say(FEATURE_RISKS[risk].title)).join(", ") }),
    );
  handle("acknowledge-risk", (input) => {
    const ids = z.array(z.enum(FEATURE_RISK_IDS)).min(1).max(FEATURE_RISK_IDS.length).parse(input);
    service.store.update((s) => {
      s.settings.riskAcknowledged = acknowledgeRisks(s.settings.riskAcknowledged, ids);
    });
    broadcastChanged();
    return service.store.state.settings;
  });
  const kit: IpcKit = { handle, id, key, requireRisk };
  registerContinuationIpc(kit);
  registerDiagnosticsBackupIpc(kit);
  registerAppIpc(kit);
  registerAccountIpc(kit);
  registerDesktopIpc(kit);
  registerProxyIpc(kit);
  registerAntigravityIpc(kit);
  registerSettingsIpc(kit);
  registerSnapshotIpc(kit);
}
