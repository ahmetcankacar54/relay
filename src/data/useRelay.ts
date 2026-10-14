import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  Account,
  AuthFlow,
  DesktopState,
  RelayAPI,
  RelaySettings,
  Snapshot,
} from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";
import { suggestedAccount } from "../../shared/usage";
import { desktopCliMismatch } from "../../shared/account-state";
import type { DesktopActionRequest } from "../DesktopActionReview";
import { previewApi } from "../preview";
import packageInfo from "../../package.json";
import { useI18n } from "./i18n";
import { pendingFlow } from "./selectors";
import { relayAction } from "./relay-action";

export { relayAction };

const injected = typeof window === "undefined" ? undefined : window.relay;
export const api: RelayAPI = injected ?? previewApi;
export const preview = !injected;
export const APP_VERSION: string = packageInfo.version;

export interface Relay {
  api: RelayAPI;
  preview: boolean;
  version: string;
  data?: Snapshot;
  desktop?: DesktopState;
  accounts: Account[];
  active?: Account;
  settings: RelaySettings;
  busy: string;
  error: string;
  notice: string;
  usageBusy: Set<string>;
  desktopBusy: boolean;
  pendingDesktop?: Account;
  hasUnclaimedDesktop: boolean;
  targetOrg: string;
  setOrg(id: string): void;
  refresh(): Promise<unknown>;
  action(key: string, fn: () => Promise<unknown>): Promise<void>;
  setNotice(text: string): void;
  dismissError(): Promise<void>;
  refreshUsage(account: Account, allowPrompt?: boolean): Promise<void>;
  desktopRequest?: DesktopActionRequest;
  requestDesktop(
    account: Account | undefined,
    kind: DesktopActionRequest["kind"],
  ): void;
  cancelDesktopRequest(): void;
  confirmDesktopAction(): void;
  setupId?: string;
  setSetupId(id: string | undefined): void;
  flow?: AuthFlow;
  flowAccount?: Account;
  startCli(account: Account): Promise<void>;
  dismissFlow(): void;
  submitCode(code: string): void;
  historyRevision: number;
  suggestion?: Account;
  /** Legacy-only escape hatch: replaces the snapshot with a locally derived one. */
  setData: Dispatch<SetStateAction<Snapshot | undefined>>;
}

export function useRelay(): Relay {
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
  const queuedTrayTarget = useRef<string | null>(null);
  const showError = useCallback(
    (e: unknown) =>
      setError(
        String(e instanceof Error ? e.message : e).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      ),
    [],
  );
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    const [snapshot, status] = await Promise.all([
      api.panelSnapshot(),
      api.desktopSnapshot(),
    ]);
    if (request === sequence.current) {
      setData(snapshot);
      setDesktop(status);
    }
    if (request !== sequence.current) return { snapshot, status };
    const requested = await api.consumeTraySwitchRequest();
    if (requested) queuedTrayTarget.current = requested;
    if (request !== sequence.current) return { snapshot, status };
    const trayTarget = queuedTrayTarget.current;
    if (trayTarget) {
      const target = snapshot.accounts.find((a) => a.id === trayTarget);
      if (
        !target?.desktop ||
        desktopCliMismatch(target) ||
        status.activeProfileId === trayTarget
      )
        queuedTrayTarget.current = null;
      else if (
        !lock.current &&
        !status.busy &&
        !status.recoveryRequired &&
        !status.pendingProfileId &&
        !snapshot.authFlows.some(pendingFlow)
      ) {
        queuedTrayTarget.current = null;
        setDesktopRequest({ accountId: trayTarget, kind: "switch" });
      }
    }
    return { snapshot, status };
  }, []);
  useEffect(() => {
    void refresh().catch(showError);
    const off = api.onAuth(() => {
      void refresh().catch(showError);
    });
    const offTray = api.onTraySwitch(() => {
      void refresh().catch(showError);
    });
    const timer = setInterval(() => {
      void refresh().catch(showError);
    }, 4000);
    const focus = () => {
      void refresh().catch(showError);
    };
    window.addEventListener("focus", focus);
    return () => {
      off();
      offTray();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [refresh, showError]);
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
  const suggestion = suggestedAccount(
    active,
    accounts,
    data?.usage ?? {},
    settings,
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
  const targetOrg = desktop?.organizations.includes(org)
    ? org
    : desktop?.organizations.length === 1
      ? desktop.organizations[0]
      : "";
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
      if (request.kind === "recover") await api.recoverDesktop();
      else if (request.kind === "cancel") await api.cancelDesktopLogin();
      else {
        if (!account)
          throw new Error(t("Hesap bulunamadı.", "Account not found."));
        if (request.kind === "switch") await api.switchDesktop(account.id);
        else if (request.kind === "history")
          await api.syncDesktopHistory(account.id);
        else if (request.kind === "capture")
          await api.captureDesktop(account.id, targetOrg);
        else await api.beginDesktopLogin(account.id);
      }
      setSetupId(undefined);
      setDesktopRequest(undefined);
      setHistoryRevision((value) => value + 1);
      setNotice(
        request.kind === "history"
          ? t(
              "Ortak Code geçmişi açık hesapla birleştirildi.",
              "Shared Code history was merged into the current account.",
            )
          : request.kind === "switch"
            ? t(
                `${account?.name} · Desktop hesabına geçildi.`,
                `${account?.name} · Desktop account switched.`,
              )
            : request.kind === "capture"
              ? t(
                  `${account?.name} · Desktop bağlantısı kaydedildi.`,
                  `${account?.name} · Desktop connection saved.`,
                )
              : request.kind === "cancel" || request.kind === "recover"
                ? t(
                    "Önceki Desktop bağlantısı geri yüklendi.",
                    "The previous Desktop connection was restored.",
                  )
                : t(
                    "Claude’da bu hesabın girişini tamamla, ardından Relay’e dön.",
                    "Complete this account’s sign-in in Claude, then return to Relay.",
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
