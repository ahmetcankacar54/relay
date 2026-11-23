/** Antigravity accounts: their CLIProxyAPI helpers, the Google sign-in in progress, the app on this Mac. */
import { app } from "electron";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AntigravityOAuthPoll } from "../../shared/types";
import { antigravityDataDir, antigravityLastLogin, matchAntigravityApp } from "../core/antigravity-app";
import { AntigravityBridge } from "../core/antigravity-bridge";
import type { CallbackServer } from "../core/oauth-callback-server";
import { say } from "../i18n";
import { antigravitySwitcher, service } from "./state";
import { broadcastChanged } from "./windows";
/** When each Antigravity account's Google plan was last read. */
export const antigravityTierReads = new Map<string, number>();
/**
 * The Antigravity app and the Relay account it is signed in with. Read from its settings file only
 * when some account is an Antigravity one; cheap (a few KB) and read on each snapshot.
 */
export async function antigravityApp() {
  const accounts = service.store.state.accounts;
  if (!accounts.some((a) => a.provider === "antigravity")) return undefined;
  const app = matchAntigravityApp(await antigravityLastLogin(antigravityDataDir()), accounts, process.platform === "darwin");
  if (!antigravitySwitcher || !app.installed) return app;
  // On macOS the Keychain item itself says which account the app and agy use; the settings file
  // only says who signed in last.
  const [state, current] = await Promise.all([antigravitySwitcher.state(), antigravitySwitcher.current()]);
  const { accountId: _last, otherSignIn: _other, ...rest } = app;
  const who = current.accountId
    ? { accountId: current.accountId }
    : current.other
      ? { otherSignIn: true }
      : current.signedOut
        ? {}
        : { ...(app.accountId ? { accountId: app.accountId } : {}), ...(app.otherSignIn ? { otherSignIn: true } : {}) };
  return { ...rest, ...who, canSwitch: true, ...state };
}
export const antigravityBridges = new Map<string, AntigravityBridge>();
export const pendingAntigravityOAuth = new Map<string, string>();
export const antigravityOAuthOutcomes = new Map<string, AntigravityOAuthPoll>();
const antigravityOAuthPolls = new Map<string, Promise<AntigravityOAuthPoll>>();
export const antigravityOAuthTimers = new Map<string, ReturnType<typeof setInterval>>();
/** Relay's own listener on Google's redirect port while a sign-in waits. */
export const antigravityCallbackServers = new Map<string, CallbackServer>();
/** The port Antigravity's Google OAuth client sends the browser back to. */
export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export let antigravityStarting = false;

export function antigravityBridge(accountId: string): AntigravityBridge {
  const account = service.store.account(accountId);
  if (account.provider !== "antigravity") throw new Error(say("electronMain.notAnAntigravityAccount"));
  let bridge = antigravityBridges.get(accountId);
  if (!bridge) {
    bridge = new AntigravityBridge(
      service.store.profile(accountId),
      path.join(app.getPath("userData"), "tools"),
    );
    antigravityBridges.set(accountId, bridge);
  }
  return bridge;
}

export async function discardPendingAntigravity(accountId: string): Promise<void> {
  pendingAntigravityOAuth.delete(accountId);
  antigravityCallbackServers.get(accountId)?.close();
  antigravityCallbackServers.delete(accountId);
  const timer = antigravityOAuthTimers.get(accountId);
  if (timer) clearInterval(timer);
  antigravityOAuthTimers.delete(accountId);
  antigravityBridges.get(accountId)?.stop();
  antigravityBridges.delete(accountId);
  service.store.update((state) => {
    state.accounts = state.accounts.filter((account) => account.id !== accountId);
  });
  await fsp.rm(path.join(service.store.root, "profiles", accountId), { recursive: true, force: true });
  broadcastChanged();
}

export async function pollAntigravityOAuth(accountId: string, state: string): Promise<AntigravityOAuthPoll> {
  const completed = antigravityOAuthOutcomes.get(accountId);
  if (completed) return completed;
  if (pendingAntigravityOAuth.get(accountId) !== state)
    throw new Error(say("electronMain.antigravitySignInIsNoLonger"));
  const inFlight = antigravityOAuthPolls.get(accountId);
  if (inFlight) return inFlight;
  const work = (async (): Promise<AntigravityOAuthPoll> => {
    const status = await antigravityBridge(accountId).pollOAuth(state);
    if (status.status === "wait") return status;
    if (status.status === "error") {
      await discardPendingAntigravity(accountId);
      const result: AntigravityOAuthPoll = status;
      antigravityOAuthOutcomes.set(accountId, result);
      return result;
    }
    const duplicate = service.store.state.accounts.find((a) =>
      a.id !== accountId && a.provider === "antigravity" &&
      a.auth?.email?.toLowerCase() === status.email.toLowerCase());
    if (duplicate) {
      await discardPendingAntigravity(accountId);
      const result: AntigravityOAuthPoll = { status: "error", error: say("electronMain.thisAntigravityAccountIsAlreadyConnected") };
      antigravityOAuthOutcomes.set(accountId, result);
      return result;
    }
    service.store.update((savedState) => {
      const account = savedState.accounts.find((a) => a.id === accountId);
      if (!account) throw new Error(say("electronMain.accountDisappearedDuringOauthSignIn"));
      // The plan (Google AI Pro, Ultra, free) is read with the account's first limits.
      account.auth = { loggedIn: true, checkedAt: new Date().toISOString(), email: status.email };
    });
    pendingAntigravityOAuth.delete(accountId);
    antigravityCallbackServers.get(accountId)?.close();
    antigravityCallbackServers.delete(accountId);
    const timer = antigravityOAuthTimers.get(accountId);
    if (timer) clearInterval(timer);
    antigravityOAuthTimers.delete(accountId);
    broadcastChanged();
    const result: AntigravityOAuthPoll = {
      status: "ok",
      result: {
        account: service.store.account(accountId),
        layers: { desktop: "skipped", usage: "skipped", terminal: "skipped", extensionAndProxy: "done" },
      },
    };
    antigravityOAuthOutcomes.set(accountId, result);
    return result;
  })();
  antigravityOAuthPolls.set(accountId, work);
  try { return await work; } finally { antigravityOAuthPolls.delete(accountId); }
}
/** Claims the one Antigravity sign-in start, or lets it go. */
export function setAntigravityStarting(starting: boolean) {
  antigravityStarting = starting;
}
