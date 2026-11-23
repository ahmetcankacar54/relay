/** Relay's startup once Electron is ready: each step in the order it runs, awaited as before. */
import { app } from "electron";
import { settleInstallLocation } from "../updates";
import { bootAutomation } from "./automation";
import { bootContinuation } from "./continuation";
import { bootDesktop } from "./desktop";
import { bootFleetKeeper } from "./fleet-keeper";
import { bootShell } from "./shell";
import { bootStart } from "./start";
import { bootUsage } from "./usage";
import { bootVault } from "./vault";

export async function boot() {
  // Moving restarts Relay from Applications; this copy quits.
  if (process.platform === "darwin" && app.isPackaged && (await settleInstallLocation()))
    return;
  const vault = await bootVault();
  const host = bootDesktop(vault);
  const usage = await bootUsage(vault);
  bootAutomation(host);
  const evidence = bootContinuation(usage);
  await bootFleetKeeper(evidence, usage);
  bootShell();
  bootStart();
}
