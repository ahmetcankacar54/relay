import { app } from "electron";
import path from "node:path";
import { DesktopLock } from "../core/desktop-lock";
import { anyExclusiveProfileLock } from "../core/profile-lock";
import { operationLock, service, tray, usageCredentialRefresher } from "./state";
/**
 * One Desktop operation at a time. The menu bar shows each as it begins rather than at the
 * next poll, and its end, for operations no caller refreshes the tray after.
 */
export const desktopLock = new DesktopLock(() => void tray?.update(), {
  acquire: (kind) => operationLock?.tryAcquire(kind),
  release: () => operationLock?.release(),
});
/** Per-account profile locks, shared with the relay CLI. */
export const profileLocks = () =>
  path.join(app.getPath("userData"), "profiles", ".locks");
export function withDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.run(action);
}
/** A Desktop action the user started: refused during another operation, queued behind a restored draft. */
export function manualDesktopLock<T>(action: () => Promise<T>): Promise<T> {
  return desktopLock.manual(action, () =>
    usageCredentialRefresher?.anyActive ||
    anyExclusiveProfileLock(profileLocks(), process.pid)
      ? new Error("Wait for the account connection refresh to finish.")
      : undefined,
  );
}
export function pendingAuth() {
  return (
    usageCredentialRefresher?.anyActive ||
    service.auth
      .list()
      .some((f) => ["starting", "waiting", "verifying"].includes(f.status))
  );
}
