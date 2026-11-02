import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { BrowserWindow, session, shell } from "electron";
import type { AuthBrowser } from "./core/auth";
import {
  localCallback,
  signInNavigationAllowed,
  signInPartition,
} from "./core/auth-page-policy";

/** Writes the page the CLI hands to BROWSER into the file Relay named for that attempt. */
const HANDOFF_SCRIPT = `#!/bin/sh
[ -n "$RELAY_AUTH_PAGE_FILE" ] && printf '%s' "$1" > "$RELAY_AUTH_PAGE_FILE"
`;

/**
 * The usage sign-in in Relay's own window, one per account, each with its own claude.ai session:
 * whichever account the system browser is signed in to cannot approve the wrong one, and a
 * renewal finds the account still signed in. macOS and Linux (the handoff is a shell script).
 */
export function authWindows(
  dataDir: string,
  t: (tr: string, en: string) => string,
  icon?: string,
): AuthBrowser {
  const dir = path.join(dataDir, "auth-pages");
  const script = path.join(dataDir, "auth-browser.sh");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(script, HANDOFF_SCRIPT, { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  const windows = new Map<string, BrowserWindow>();
  const file = (attemptId: string) => path.join(dir, `${attemptId.replace(/[^\w-]/g, "")}.url`);
  return {
    env: (attemptId) => ({ BROWSER: script, RELAY_AUTH_PAGE_FILE: file(attemptId) }),
    take: async (attemptId) => {
      try {
        const url = (await fsp.readFile(file(attemptId), "utf8")).trim();
        await fsp.rm(file(attemptId), { force: true });
        return url || undefined;
      } catch {
        return undefined;
      }
    },
    show: (accountId, url) => {
      const open = windows.get(accountId);
      if (open && !open.isDestroyed()) {
        open.show();
        open.focus();
        return;
      }
      const callback = localCallback(url);
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        title: t("Claude ile giriş", "Sign in with Claude"),
        ...(icon ? { icon } : {}),
        autoHideMenuBar: true,
        webPreferences: {
          partition: signInPartition(accountId),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      windows.set(accountId, win);
      win.on("closed", () => {
        if (windows.get(accountId) === win) windows.delete(accountId);
      });
      const contents = win.webContents;
      contents.session.setPermissionRequestHandler((_c, _p, decide) => decide(false));
      const guard = (event: { preventDefault(): void }, target: string) => {
        if (signInNavigationAllowed(target, callback)) return;
        event.preventDefault();
        if (target.startsWith("https://")) void shell.openExternal(target);
      };
      contents.on("will-navigate", (event, target) => guard(event, target));
      contents.on("will-redirect", (event, target) => guard(event, target));
      // Pop-up sign-ins (a provider's) stay inside this account's session.
      contents.setWindowOpenHandler(({ url: target }) => {
        if (signInNavigationAllowed(target, callback))
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              autoHideMenuBar: true,
              webPreferences: {
                partition: signInPartition(accountId),
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            },
          };
        if (target.startsWith("https://")) void shell.openExternal(target);
        return { action: "deny" };
      });
      // The approval reached the CLI: the page it shows says so; the flow then closes the window.
      contents.on("did-navigate", (_event, target) => {
        if (callback && signInNavigationAllowed(target, callback) && target.startsWith("http:"))
          setTimeout(() => !win.isDestroyed() && win.close(), 1_500);
      });
      void win.loadURL(url);
    },
    close: (accountId) => {
      const win = windows.get(accountId);
      if (win && !win.isDestroyed()) win.close();
    },
  };
}

/** Forgets an account's sign-in window session: its claude.ai login and cookies. */
export async function forgetSignInSession(accountId: string) {
  await session.fromPartition(signInPartition(accountId)).clearStorageData();
}
