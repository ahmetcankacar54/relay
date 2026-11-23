/** Antigravity accounts: the Google sign-in and moving the Antigravity app between them. */
import { app, shell } from "electron";
import { z } from "zod";
import { antigravityAccountRisks } from "../../../shared/feature-risk";
import { listenOAuthCallback } from "../../core/oauth-callback-server";
import { createAccountSchema } from "../../core/store";
import { say } from "../../i18n";
import {
  ANTIGRAVITY_CALLBACK_PORT,
  antigravityBridge,
  antigravityCallbackServers,
  antigravityOAuthOutcomes,
  antigravityOAuthTimers,
  antigravityStarting,
  discardPendingAntigravity,
  pendingAntigravityOAuth,
  pollAntigravityOAuth,
  setAntigravityStarting,
} from "../antigravity";
import { proxySettings } from "../gateway";
import { antigravitySwitcher, service } from "../state";
import { broadcastChanged, showWindow } from "../windows";
import type { IpcKit } from "./index";
export function registerAntigravityIpc({ handle, id, requireRisk }: IpcKit) {
  handle("antigravity-oauth-start", async (raw) => {
    // Checked and claimed before any await: a double click must not start two sign-ins on the
    // helper's one callback port.
    if (pendingAntigravityOAuth.size || antigravityStarting)
      throw new Error(say("electronMain.finishThePendingAntigravitySignIn"));
    const input = createAccountSchema.parse({ ...raw, provider: "antigravity" });
    requireRisk(antigravityAccountRisks(proxySettings().enabled));
    setAntigravityStarting(true);
    const account = (() => {
      try {
        return service.store.create(input);
      } catch (error) {
        setAntigravityStarting(false);
        throw error;
      }
    })();
    try {
      const bridge = antigravityBridge(account.id);
      // Relay answers Google's redirect itself: the browser gets a short page and Relay comes
      // forward. If the port is taken, CLIProxyAPI's own forwarder is the way back.
      const callback = await listenOAuthCallback({
        port: ANTIGRAVITY_CALLBACK_PORT,
        path: "/oauth-callback",
        timeoutMs: 10 * 60_000,
        // Set below, once the helper has named the sign-in; a redirect for another one waits.
        state: () => pendingAntigravityOAuth.get(account.id),
        handle: async (address) => {
          const expected = pendingAntigravityOAuth.get(account.id);
          try {
            if (!expected) throw new Error(say("electronMain.noSignInIsPending"));
            await bridge.submitCallback(expected, address);
            return {
              title: say("electronMain.signedIn"),
              body: say("electronMain.youCanGoBackToRelay"),
            };
          } catch {
            return {
              title: say("electronMain.signInNotFinished"),
              body: say("electronMain.goBackToRelayAndTry"),
            };
          } finally {
            showWindow();
            if (process.platform === "darwin") app.focus({ steal: true });
          }
        },
      });
      if (callback) antigravityCallbackServers.set(account.id, callback);
      const { state, url } = await bridge.beginOAuth({ forwarder: !callback });
      pendingAntigravityOAuth.set(account.id, state);
      await shell.openExternal(url);
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (Date.now() - startedAt > 10 * 60_000) {
          void discardPendingAntigravity(account.id).then(() => {
            antigravityOAuthOutcomes.set(account.id, { status: "error", error: say("electronMain.antigravitySignInTimedOut") });
          });
          return;
        }
        void pollAntigravityOAuth(account.id, state).catch(() => {});
      }, 1500);
      timer.unref();
      antigravityOAuthTimers.set(account.id, timer);
      broadcastChanged();
      return { accountId: account.id, state };
    } catch (error) {
      await discardPendingAntigravity(account.id);
      throw error;
    } finally {
      setAntigravityStarting(false);
    }
  });
  handle("antigravity-oauth-cancel", async (raw) => {
    const input = z.object({ accountId: z.uuid(), state: z.string().min(8).max(128) }).strict().parse(raw);
    // Only the sign-in that is still pending; a finished one is an account like any other.
    if (pendingAntigravityOAuth.get(input.accountId) !== input.state) return;
    await discardPendingAntigravity(input.accountId);
    antigravityOAuthOutcomes.set(input.accountId, {
      status: "error",
      error: say("electronMain.antigravitySignInWasCancelled"),
    });
  });
  handle("antigravity-oauth-callback", async (raw) => {
    const input = z
      .object({ accountId: z.uuid(), state: z.string().min(8).max(128), url: z.string().min(1).max(4_096) })
      .strict()
      .parse(raw);
    if (pendingAntigravityOAuth.get(input.accountId) !== input.state)
      throw new Error(say("electronMain.antigravitySignInIsNoLonger"));
    await antigravityBridge(input.accountId).submitCallback(input.state, input.url);
  });
  handle("antigravity-oauth-poll", async (raw) => {
    const input = z.object({ accountId: z.uuid(), state: z.string().min(8).max(128) }).strict().parse(raw);
    return pollAntigravityOAuth(input.accountId, input.state);
  });
  const antigravityOnly = () => {
    if (!antigravitySwitcher) throw new Error(say("electronMain.antigravityAccountSwitchingWorksOnMacos"));
    return antigravitySwitcher;
  };
  const antigravityAccount = (accountId: unknown) => {
    const account = service.store.account(id.parse(accountId));
    if (account.provider !== "antigravity") throw new Error(say("electronMain.notAnAntigravityAccount"));
    return account.id;
  };
  handle("switch-antigravity", (accountId) => antigravityOnly().switchTo(antigravityAccount(accountId)));
  handle("save-antigravity-sign-in", (accountId) => antigravityOnly().beginSignIn(antigravityAccount(accountId)));
  handle("cancel-antigravity-sign-in", () => antigravityOnly().cancelSignIn());
}
