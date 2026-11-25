import { app } from "electron";
import os from "node:os";
import { setLaunchAtLogin, type LoginItemHost } from "../core/login-item";
import { recordMainError } from "./errors";
import { service } from "./state";
/** The Electron side of the login item; the rules live in core/login-item.ts. */
export function loginItemHost(): LoginItemHost {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    execPath: process.execPath,
    getLoginItemSettings: (options) => app.getLoginItemSettings(options),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  };
}
/**
 * Brings the system's login item in line with the saved "Open at login". A development run would
 * register the bare Electron binary, so only the packaged app touches it. Never throws.
 */
export async function applyLaunchAtLogin() {
  if (!app.isPackaged) return;
  try {
    await setLaunchAtLogin(service.store.state.settings.launchAtLogin === true, loginItemHost());
  } catch (error) {
    recordMainError("launch-at-login", error);
  }
}
