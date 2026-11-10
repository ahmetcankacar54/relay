import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Account,
  DesktopState,
  RelayAPI,
  Snapshot,
} from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { suggestedAccount } from "../../shared/usage";
import { staleManualSwitch } from "../../shared/automation-status";
import type { DesktopActionRequest } from "../features/DesktopActionReview";
import packageInfo from "../../package.json";
import { targetWorkspace } from "../lib/workspaces";
import { errorMessage } from "./error-message";
import { useI18n } from "./i18n";
import { pendingFlow, tempoRateNow, windowAccounts } from "./selectors";
import {
  errorAfterRefresh,
  hiddenRefresh,
  relayAction,
  reportedVisibility,
  shouldPoll,
} from "./relay-action";
import { RelayContext, useRelay, type Relay } from "./relay-context";

export { relayAction, RelayContext, useRelay, type Relay };

/**
 * An API whose calls wait for `load`. A listener (`on…`) still returns its unsubscribe at once.
 * A failed load rejects every call and subscribes nothing.
 */
function deferredApi(load: () => Promise<RelayAPI>): RelayAPI {
  let loaded: RelayAPI | undefined;
  const ready = load().then((api) => (loaded = api));
  ready.catch(() => {});
  type Method = (...args: unknown[]) => unknown;
  const method = (api: RelayAPI, key: string) =>
    (api as unknown as Record<string, Method>)[key];
  return new Proxy({} as RelayAPI, {
    get: (_, key) => {
      // Not a thenable: `then` stays undefined.
      if (typeof key !== "string" || key === "then") return undefined;
      return (...args: unknown[]) => {
        if (loaded) return method(loaded, key)(...args);
        if (!/^on[A-Z]/.test(key))
          return ready.then((api) => method(api, key)(...args));
        let off: (() => void) | undefined;
        let cancelled = false;
        void ready.then(
          (api) => {
            if (!cancelled) off = method(api, key)(...args) as () => void;
          },
          () => {},
        );
        return () => {
          cancelled = true;
          off?.();
        };
      };
    },
  });
}

const injected = typeof window === "undefined" ? undefined : window.relay;
// The browser preview's sample data (`npm run dev:ui`) is development only. A built app always
// has the preload's API, and its bundle carries no sample data.
export const api: RelayAPI =
  injected ??
  deferredApi(
    import.meta.env.DEV
      ? () => import("../preview").then((module) => module.previewApi)
      : () => Promise.reject(new Error("Relay’s window bridge is missing.")),
  );
export const preview = !injected;
export const APP_VERSION: string = packageInfo.version;

function useRelayState(
  options: { pollWhenHidden?: boolean; reportsVisibility?: boolean } = {},
): Relay {
  const pollWhenHidden = options.pollWhenHidden !== false;
  const reportsVisibility = options.reportsVisibility === true;
  const { t } = useI18n();
  const [data, setData] = useState<Snapshot>();
  const [desktop, setDesktop] = useState<DesktopState>();
  const [setupId, setSetupId] = useState<string>();
  const [desktopRequest, setDesktopRequest] = useState<DesktopActionRequest>();
  const [usageBusy, setUsageBusy] = useState<Set<string>>(new Set());
  const [org, setOrg] = useState("");
  const [authId, setAuthId] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const lock = useRef(false);
  const sequence = useRef(0);
  const showError = useCallback((e: unknown) => setError(errorMessage(e)), []);
  // A background refresh that failed once (a busy moment) must not leave its error behind
  // after refreshes work again.
  const refreshError = useRef<string | undefined>(undefined);
  const showRefreshError = useCallback((e: unknown) => {
    const message = errorMessage(e);
    refreshError.current = message;
    setError(message);
  }, []);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const [snapshot, status] = await Promise.all([
      api.panelSnapshot(),
      api.desktopSnapshot(),
    ]);
    if (request === sequence.current) {
      setData(snapshot);
      setDesktop(status);
      const stale = refreshError.current;
      if (stale !== undefined) {
        refreshError.current = undefined;
        setError((current) => errorAfterRefresh(current, stale));
      }
    }
    return { snapshot, status };
  }, []);
  useEffect(() => {
    void refresh().catch(showRefreshError);
    // The menu bar panel follows main's shown/hidden reports: its document reads "visible"
    // while it is still hidden after launch.
    const reported = reportsVisibility ? reportedVisibility() : undefined;
    const visibility = reported
      ? reported.visibility
      : () => document.visibilityState;
    // While hidden, a broadcast or a skipped poll only marks one refresh for the next show.
    const gate = hiddenRefresh(
      visibility,
      () => void refresh().catch(showRefreshError),
    );
    const offVisibility = reported
      ? api.onPanelVisibility((shown) => {
          reported.report(shown);
          gate.shown();
        })
      : () => {};
    const off = api.onAuth(() => gate.changed());
    const offChanged = api.onChanged(() => gate.changed());
    const timer = setInterval(() => {
      if (shouldPoll({ pollWhenHidden }, visibility()))
        void refresh().catch(showRefreshError);
      else gate.changed();
    }, 4000);
    const focus = () => {
      void refresh().catch(showRefreshError);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", gate.shown);
    return () => {
      offVisibility();
      off();
      offChanged();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", gate.shown);
    };
  }, [refresh, showRefreshError, pollWhenHidden, reportsVisibility]);
  const action = relayAction(lock, {
    setBusy,
    setError,
    setNotice,
    refresh,
    showError,
  });
  const accounts = data?.accounts ?? [];
  const active = accounts.find((a) => a.id === desktop?.activeProfileId);
  const settings = data?.settings ?? DEFAULT_SETTINGS;
  const now = Date.now();
  // An account in its own Claude window cannot be switched to, so it is never suggested.
  const inWindows = windowAccounts(data);
  const suggestion = suggestedAccount(
    active,
    accounts.filter((a) => !inWindows.has(a.id)),
    data?.usage ?? {},
    settings,
    now,
    tempoRateNow(data, settings, now),
  );
  const flow =
    data?.authFlows.find((f) => f.accountId === authId) ??
    data?.authFlows.find((f) => pendingFlow(f) && f.id !== dismissed);
  const flowAccount = accounts.find((a) => a.id === flow?.accountId);
  const pendingDesktop = accounts.find(
    (a) => a.id === desktop?.pendingProfileId,
  );
  const hasUnclaimedDesktop =
    !!desktop?.currentAccountUuid && !desktop.activeProfileId;
  const targetOrg = targetWorkspace(desktop?.organizations, org, desktop?.orgHint?.orgId);
  const desktopBusy =
    !!busy || !!desktop?.busy || data?.continuation?.status === "executing";
  const dismissError = async () => {
    setError("");
    if (desktop?.error) {
      const revision = desktop.errorRevision;
      ++sequence.current;
      setDesktop((previous) =>
        previous ? { ...previous, error: undefined } : previous,
      );
      try {
        await api.dismissDesktopError(revision);
        await refresh();
      } catch (e) {
        showError(e);
      }
    }
  };
  const requestDesktop = (
    account: Account | undefined,
    kind: DesktopActionRequest["kind"],
  ) => {
    setDesktopRequest({ accountId: account?.id ?? "recovery", kind });
  };
  const confirmDesktopAction = () => {
    if (!desktopRequest) return;
    const request = desktopRequest;
    const account = accounts.find((a) => a.id === request.accountId);
    void action(`desktop-action:${request.accountId}`, async () => {
      // A capture with no workspace to save yet waits for Code instead (see AutoCapture).
      const later = request.kind === "capture" && !targetOrg;
      if (request.kind === "recover") await api.recoverDesktop();
      else if (request.kind === "cancel") await api.cancelDesktopLogin();
      else {
        if (!account)
          throw new Error(t("Hesap bulunamadı.", "Account not found."));
        if (request.kind === "switch") {
          // Automation may have switched while the review was open.
          const [status, snapshot] = await Promise.all([
            api.desktopSnapshot(),
            api.panelSnapshot(),
          ]);
          const stale = staleManualSwitch(account.id, status, snapshot.fleet);
          if (stale) {
            setDesktopRequest(undefined);
            setNotice(
              stale === "already-active"
                ? t(
                    `${account.name} zaten Claude uygulamasında açık.`,
                    `${account.name} is already open in the Claude app.`,
                  )
                : t(
                    "Otomatik bir geçiş sürüyor; elle geçiş başlamadı.",
                    "An automatic switch is in progress; your switch did not start.",
                  ),
            );
            return;
          }
          await api.switchDesktop(account.id);
        } else if (request.kind === "history")
          await api.syncDesktopHistory(account.id);
        else if (request.kind === "capture") {
          // Code not opened yet, or several workspaces: saved once Code has the one to keep.
          if (targetOrg) await api.captureDesktop(account.id, targetOrg);
          else await api.armAutoCapture(account.id);
        }
        else {
          await api.beginDesktopLogin(account.id);
          // One confirmation covers both restarts: the sign-in is saved once it is complete.
          await api.armAutoCapture(account.id);
        }
      }
      setSetupId(undefined);
      setDesktopRequest(undefined);
      setHistoryRevision((value) => value + 1);
      setNotice(
        request.kind === "history"
          ? t(
              "Ortak Code geçmişi açık hesapla birleştirildi.",
              "Relay merged the shared Code history into the open account.",
            )
          : request.kind === "switch"
            ? t(
                `Claude uygulaması ${account?.name} hesabına geçti.`,
                `The Claude app switched to ${account?.name}.`,
              )
            : later
              ? t(
                  "Girişi kaydetmek için Claude uygulamasında Code’u bir kez aç.",
                  "Open Code once in the Claude app to save the sign-in.",
                )
              : request.kind === "capture"
              ? t(
                  `${account?.name} · Claude uygulaması girişi kaydedildi.`,
                  `${account?.name} · Claude app sign-in saved.`,
                )
              : request.kind === "cancel" || request.kind === "recover"
                ? t(
                    "Önceki Claude uygulaması girişi geri yüklendi.",
                    "Relay restored the previous Claude app sign-in.",
                  )
                : t(
                    "Claude uygulamasında bu hesapla giriş yap, sonra Code’u aç.",
                    "Sign in with this account in the Claude app, then open Code.",
                  ),
      );
    });
  };
  const refreshUsage = async (account: Account, allowPrompt = false) => {
    setUsageBusy((previous) => new Set(previous).add(account.id));
    try {
      await api.refreshUsage(account.id, allowPrompt);
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      setUsageBusy((previous) => {
        const next = new Set(previous);
        next.delete(account.id);
        return next;
      });
    }
  };
  const startCli = (a: Account) =>
    action(`cli:${a.id}`, async () => {
      // Never a Claude sign-in for a Codex or Antigravity account (main refuses it too).
      if ((a.provider ?? "claude") !== "claude") return;
      setDismissed(undefined);
      setAuthId(a.id);
      await api.login(a.id);
    });
  const dismissFlow = () => {
    if (!flow) return;
    setDismissed(flow.id);
    setAuthId(undefined);
  };
  const submitCode = (value: string) => {
    if (!flow) return;
    void action("code", () =>
      api.submitLoginCode(flow.accountId, flow.id, value),
    );
  };
  return {
    api,
    preview,
    version: APP_VERSION,
    data,
    desktop,
    accounts,
    active,
    settings,
    busy,
    error,
    notice,
    usageBusy,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    setOrg,
    refresh,
    action,
    setNotice,
    dismissError,
    refreshUsage,
    desktopRequest,
    requestDesktop,
    cancelDesktopRequest: () => setDesktopRequest(undefined),
    confirmDesktopAction,
    setupId,
    setSetupId,
    flow,
    flowAccount,
    startCli,
    dismissFlow,
    submitCode,
    historyRevision,
    suggestion,
    setData,
  };
}

/** Owns the app state once and shares it with every page through context. */
export function RelayProvider({
  children,
  pollWhenHidden = true,
  reportsVisibility = false,
}: {
  children: ReactNode;
  /** Both windows pass false: no 4 s poll while hidden. */
  pollWhenHidden?: boolean;
  /** The menu bar panel passes true: it is hidden until main reports it shown. */
  reportsVisibility?: boolean;
}) {
  const relay = useRelayState({ pollWhenHidden, reportsVisibility });
  return createElement(RelayContext.Provider, { value: relay }, children);
}
