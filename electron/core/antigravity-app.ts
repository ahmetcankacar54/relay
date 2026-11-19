import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Account, AntigravityAppState } from "../../shared/types";
import { runDetached } from "./detached-exec";

/** Google's Antigravity app: its bundle and the key its settings file keeps the last sign-in under. */
export const ANTIGRAVITY_BUNDLE_ID = "com.google.antigravity";
const LAST_LOGIN_KEY = "agy.onboarding.lastLoginUsername";
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/** Where the Antigravity app keeps its data on this platform. */
export function antigravityDataDir(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Antigravity");
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Antigravity");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Antigravity");
}

/** The e-mail the app last signed in with, from its settings file; undefined when there is none. */
export async function antigravityLastLogin(dataDir: string): Promise<{ installed: boolean; email?: string }> {
  const file = path.join(dataDir, "app_storage.json");
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return { installed: true };
    const data = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
    const email = data?.[LAST_LOGIN_KEY];
    return typeof email === "string" && /^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email)
      ? { installed: true, email }
      : { installed: true };
  } catch {
    // No settings file: installed only if its data folder exists (it was opened once).
    return { installed: await fsp.stat(dataDir).then((s) => s.isDirectory(), () => false) };
  }
}

/**
 * Which Relay Antigravity account the Antigravity app is signed in with, as the snapshot carries it:
 * the account's id, never the e-mail. `otherSignIn` is an app signed in with an account Relay does
 * not have. The app reads its sign-in at start, so this is the account it uses until it restarts.
 */
export function matchAntigravityApp(
  read: { installed: boolean; email?: string },
  accounts: readonly Pick<Account, "id" | "provider" | "auth">[],
  canOpen: boolean,
): AntigravityAppState {
  if (!read.installed) return { installed: false, canOpen: false };
  const email = read.email?.toLowerCase();
  const match = email
    ? accounts.find((a) => a.provider === "antigravity" && a.auth?.email?.toLowerCase() === email)
    : undefined;
  return {
    installed: true,
    canOpen,
    ...(match ? { accountId: match.id } : {}),
    ...(email && !match ? { otherSignIn: true } : {}),
  };
}

/**
 * Brings the Antigravity app forward, or starts it. Only HOME, USER and PATH travel: Relay's own
 * environment (gateway variables, a Claude Code session's) must not reach another app.
 */
export async function openAntigravityApp(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Opening Antigravity from Relay works on macOS only");
  await runDetached("/usr/bin/open", ["-b", ANTIGRAVITY_BUNDLE_ID], {
    timeout: 15_000,
    env: { HOME: os.homedir(), USER: os.userInfo().username, PATH: "/usr/bin:/bin" },
  });
}
