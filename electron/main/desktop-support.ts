/** Keeping Relay's view of the Claude app current: the registry, workspaces and separate windows. */
import fs from "node:fs";
import { desktopCliWorkspaceMismatch } from "../../shared/account-state";
import { desktopAccountFor } from "../../shared/desktop-account";
import type { Account, SeparateWindows } from "../../shared/types";
import { desktop, desktopWindows, service, tray, usage, usageHistory } from "./state";
import { broadcastChanged } from "./windows";
export function displayUsage() {
  const current = usage.snapshot();
  for (const account of service.store.state.accounts) {
    if (current[account.id])
      current[account.id] = {
        ...current[account.id],
        lastKnownResets: usageHistory.lastKnownResets(account),
      };
  }
  return current;
}
/**
 * Reloads the account list when another process (the relay CLI) writes it, and tells the
 * windows and the menu bar. Relay's own writes are noticed and skipped by `reload`. A watch that
 * fails (the folder replaced, the system out of watches) is started again 5 s later.
 */
export function watchRegistry() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = fs.watch(service.store.root, (_event, name) => {
      if (name !== "state.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          if (!service.store.reload()) return;
        } catch {
          // A file still being replaced is read at its next change.
          return;
        }
        broadcastChanged();
        void tray?.update();
      }, 250);
    });
    watcher.on("error", () => {
      clearTimeout(timer);
      watcher.close();
      setTimeout(watchRegistry, 5_000).unref();
    });
  } catch {
    // Without a watch, another process's changes show after Relay restarts.
  }
}
/** The accounts open in a separate Claude window, for the windows; undefined off macOS and Linux. */
export async function separateWindows(): Promise<SeparateWindows | undefined> {
  if (!desktopWindows) return undefined;
  const { windows, others } = await desktopWindows
    .running(2_000)
    .catch(() => ({ windows: [], others: 0 }));
  const accounts = service.store.state.accounts;
  return {
    supported: true,
    enabled: desktopWindows.enabled,
    open: windows.flatMap((window) => {
      const account = desktopAccountFor({ accountUuid: window.accountUuid }, accounts);
      return account
        ? [{ accountId: account.id, ...(window.openedAt ? { openedAt: window.openedAt } : {}) }]
        : [];
    }),
    others,
  };
}
/**
 * Whether a profile's usage sign-in is its Claude app sign-in's account and workspace. One
 * Claude account can have several workspaces (organizations); a profile saved in another one
 * than its usage sign-in names can never be read or switched to, however often the user signs
 * in again. Where the Claude app has that workspace, the profile moves to it ("moved").
 */
export async function alignDesktopWorkspace(
  account: Account,
): Promise<"fits" | "moved" | "other-account" | "no-workspace"> {
  const bound = account.desktop;
  const auth = account.auth;
  if ((account.provider ?? "claude") !== "claude" || !bound || !auth?.loggedIn) return "fits";
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (auth.accountUuid && !same(auth.accountUuid, bound.accountUuid)) return "other-account";
  if (!auth.accountUuid || !auth.orgId || same(auth.orgId, bound.orgId)) return "fits";
  if (!(await desktop.rebindOrg(account.id, auth.orgId))) return "no-workspace";
  usage?.invalidate(account.id);
  usage?.tick();
  void tray?.update();
  broadcastChanged();
  return "moved";
}
/**
 * A profile left in another workspace than its usage sign-in (the Claude app had not opened
 * that workspace yet) moves once the app has: looked at with the tray's reading, at most twice
 * a minute, and only for profiles that are out of step.
 */
let workspacesAlignedAt = 0;
export function alignWorkspacesLater() {
  const now = Date.now();
  if (now - workspacesAlignedAt < 30_000 || !desktop || desktop.isBusy) return;
  workspacesAlignedAt = now;
  void desktop.noteSignOuts();
  void desktop.noteEndedSignIns();
  for (const account of service.store.state.accounts)
    if (desktopCliWorkspaceMismatch(account) && !service.auth.active(account.id))
      void alignDesktopWorkspace(account).catch(() => {});
}
