import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  Globe2,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import type {
  Account,
  AuthFlow,
  DesktopState,
  Snapshot,
} from "../shared/types";
import { DEFAULT_SETTINGS } from "../shared/types";
import { suggestedAccount } from "../shared/usage";
import { UsageCard } from "./UsageCard";
import { Preferences } from "./Preferences";
import { previewApi } from "./preview";
import { localizeError } from "./messages";
import { ConnectionProgress } from "./ConnectionProgress";
import { DesktopSetup } from "./DesktopSetup";
import {
  DesktopActionReview,
  type DesktopActionRequest,
} from "./DesktopActionReview";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  duplicateCliAccount,
} from "../shared/account-state";
import { historySources } from "../shared/history-policy";
import { AutoSwitchStatus } from "./AutoSwitchStatus";
import { HistorySummary } from "./HistorySummary";
import packageInfo from "../package.json";

const api = window.relay ?? previewApi;
const APP_VERSION = packageInfo.version;
const preview = !window.relay;
const pending = (f?: AuthFlow) =>
  !!f && ["starting", "waiting", "verifying"].includes(f.status);
type Language = "tr" | "en";
export default function App() {
  const [language, setLanguage] = useState<Language>(() =>
    localStorage.getItem("relay-language") === "en" ? "en" : "tr",
  );
  const t = (tr: string, en: string) => (language === "tr" ? tr : en);
  const [data, setData] = useState<Snapshot>();
  const [desktop, setDesktop] = useState<DesktopState>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);
  const [setupId, setSetupId] = useState<string>();
  const [desktopRequest, setDesktopRequest] = useState<DesktopActionRequest>();
  const [usageBusy, setUsageBusy] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "work">("personal");
  const [group, setGroup] = useState("");
  const [org, setOrg] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const [authId, setAuthId] = useState<string>();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const lock = useRef(false);
  const sequence = useRef(0);
  const queuedTrayTarget = useRef<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const [dismissed, setDismissed] = useState<string>();
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
        !snapshot.authFlows.some(pending)
      ) {
        queuedTrayTarget.current = null;
        setExpanded(trayTarget);
        setSettings(false);
        setQuery("");
        setFilter("all");
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
  useEffect(() => {
    localStorage.setItem("relay-language", language);
    document.documentElement.lang = language;
    void api.setTrayLanguage(language).catch(showError);
  }, [language, showError]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const action = async (key: string, fn: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      showError(e);
    } finally {
      lock.current = false;
      setBusy("");
    }
  };
  const accounts = data?.accounts ?? [];
  const active = accounts.find((a) => a.id === desktop?.activeProfileId);
  const preferences = data?.settings ?? DEFAULT_SETTINGS;
  const suggestion = suggestedAccount(
    active,
    accounts,
    data?.usage ?? {},
    preferences,
  );
  useEffect(() => {
    if (settings)
      document
        .querySelector(".settings-panel")
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [settings]);
  const groupName = (a: Account) =>
    a.kind === "personal"
      ? t("Kişisel", "Personal")
      : a.group === `work:${a.id}`
        ? t("Ayrı çalışma alanı", "Separate workspace")
        : a.group.slice(5);
  const visible = accounts.filter(
    (a) =>
      `${a.name} ${a.auth?.email ?? ""} ${a.desktop?.email ?? ""} ${a.auth?.orgName ?? ""} ${groupName(a)}`
        .toLocaleLowerCase(language)
        .includes(query.toLocaleLowerCase(language)) &&
      (filter === "all" ||
        filter === a.kind ||
        (filter === "connected" && a.desktop)),
  );
  const flow =
    data?.authFlows.find((f) => f.accountId === authId) ??
    data?.authFlows.find((f) => pending(f) && f.id !== dismissed);
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
    !!busy || desktop?.busy || data?.continuation?.status === "executing";
  const desktopIdentityReady =
    !!pendingDesktop &&
    (hasUnclaimedDesktop || desktop?.activeProfileId === pendingDesktop.id);
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
  useEffect(() => {
    const id =
      flow?.id && flow.id !== dismissed
        ? "cli-connection-panel"
        : desktopRequest
          ? `details-${desktopRequest.accountId}`
          : setupId !== undefined
            ? setupId
              ? `details-${setupId}`
              : "desktop-setup-picker"
            : desktop?.pendingProfileId
              ? "desktop-pending-panel"
              : undefined;
    if (id)
      document
        .getElementById(id)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flow?.id, dismissed, desktop?.pendingProfileId, setupId, desktopRequest]);
  const requestDesktop = (
    account: Account | undefined,
    kind: DesktopActionRequest["kind"],
  ) => {
    setExpanded(account?.id);
    setQuery("");
    setFilter("all");
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
      setCode("");
      await api.login(a.id);
    });
  const buttonLabel = (key: string, label: string) => (
    <>
      {busy === key ? <LoaderCircle className="spin" size={15} /> : null}
      {label}
    </>
  );
  return (
    <div className="switcher">
      <header className="app-header">
        <div className="logo">
          <span>
            <ArrowLeftRight size={19} />
          </span>
          <b>relay</b>
          <small>DESKTOP SWITCHER</small>
        </div>
        <div className="header-actions">
          <select
            aria-label={t("Dil", "Language")}
            value={language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="tr">TR</option>
            <option value="en">EN</option>
          </select>
          <button
            className={`icon ${settings ? "selected" : ""}`}
            aria-label={t("Ayarlar", "Settings")}
            onClick={() => setSettings(!settings)}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>
      <main className="switcher-main">
        {preview && (
          <div className="banner preview-note">
            <Monitor size={16} />
            {t(
              "Tarayıcı önizlemesi · Hesaplar örnektir. Geçişler masaüstü uygulamasında çalışır.",
              "Browser preview · Sample accounts. Switching works in the desktop app.",
            )}
          </div>
        )}
        {(error || desktop?.error) && (
          <div className="banner error" role="alert">
            <span>
              {localizeError(error || desktop?.error || "", language)}
            </span>
            <button
              className="icon"
              aria-label={t("Hatayı kapat", "Dismiss error")}
              onClick={() => void dismissError()}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status">
            <Check size={16} />
            <span>{notice}</span>
            <button
              className="icon"
              aria-label={t("Bildirimi kapat", "Dismiss notification")}
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {preferences.autoSwitchMode !== "off" && (
          <AutoSwitchStatus
            value={data?.autoSwitch}
            accounts={accounts}
            t={t}
          />
        )}
        {desktop?.recoveryRequired && (
          <div className="banner error">
            <span>
              {t(
                "Yarım kalan Desktop geçişi var. Önce yedeği geri yükle.",
                "A Desktop switch was interrupted. Restore the backup first.",
              )}
            </span>
            <button
              className="secondary"
              disabled={desktopBusy}
              onClick={() => requestDesktop(active, "recover")}
            >
              {t("Geri yükle", "Restore backup")}
            </button>
          </div>
        )}
        {desktopRequest?.accountId === "recovery" && (
          <DesktopActionReview
            kind={desktopRequest.kind}
            active={active}
            busy={!!desktopBusy}
            t={t}
            cancel={() => setDesktopRequest(undefined)}
            confirm={confirmDesktopAction}
          />
        )}
        <section
          className="active-account"
          aria-label={t("Aktif Desktop hesabı", "Active Desktop account")}
        >
          <span className="desktop-symbol">
            <Monitor size={24} />
          </span>
          <div className="active-copy">
            <span className="overline">CLAUDE DESKTOP</span>
            <h2>
              {active?.name ??
                (hasUnclaimedDesktop
                  ? t(
                      "Desktop hesabı eşleştirilmedi",
                      "Desktop account not linked",
                    )
                  : t("İlk hesabını bağla", "Connect your first account"))}
            </h2>
            <p>
              {active
                ? t(
                    "Desktop’ta açık hesap. Geçiş Claude’u yeniden başlatır.",
                    "Active in Desktop. Switching restarts Claude.",
                  )
                : hasUnclaimedDesktop
                  ? t(
                      "Claude’da açık hesabı bir Relay profiliyle eşleştir. CLI bağlantısı bu adımı tamamlamaz.",
                      "Link the account open in Claude to a Relay profile. A CLI connection does not complete this step.",
                    )
                  : t(
                      "Her Desktop hesabını bir kez bağla. Sonrasında buradan değiştir.",
                      "Connect each Desktop account once. Switch between them here.",
                    )}
            </p>
          </div>
          {active ? (
            <div className="active-actions">
              <span className={`pill ${desktop?.running ? "green" : ""}`}>
                <i />
                {desktop?.running
                  ? t("Açık", "Running")
                  : t("Kapalı", "Closed")}
              </span>
              <button
                className="secondary"
                disabled={desktopBusy}
                onClick={() => void action("open", () => api.openDesktop())}
              >
                <ArrowUpRight size={14} />
                {t("Claude’u aç", "Open Claude")}
              </button>
            </div>
          ) : (
            <button
              className="primary"
              disabled={
                desktopBusy ||
                !desktop?.available ||
                !!pendingDesktop ||
                desktop?.recoveryRequired
              }
              onClick={() => {
                if (hasUnclaimedDesktop && accounts.some((a) => !a.desktop)) {
                  setSetupId("");
                  setAdding(false);
                } else setAdding(true);
              }}
            >
              <Plus size={15} />
              {hasUnclaimedDesktop
                ? t("Hesabı eşleştir", "Link account")
                : t("Hesap ekle", "Add account")}
            </button>
          )}
        </section>
        {setupId === "" && !pendingDesktop && (
          <DesktopSetup
            accounts={accounts}
            desktop={desktop}
            unclaimed={hasUnclaimedDesktop}
            org={targetOrg}
            busy={!!desktopBusy}
            t={t}
            selectOrg={setOrg}
            selectAccount={(id) => {
              setSetupId(id);
              setExpanded(id);
              setQuery("");
              setFilter("all");
            }}
            close={() => setSetupId(undefined)}
            connect={() => {}}
          />
        )}
        {pendingDesktop && (
          <section
            id="desktop-pending-panel"
            className="connection-panel"
            aria-live="polite"
          >
            <div className="panel-title">
              <Globe2 size={19} />
              <div>
                <h3>
                  {pendingDesktop.name} ·{" "}
                  {t("Desktop bağlantısı", "Desktop connection")}
                </h3>
                <p>
                  {t(
                    "Claude’da doğru hesaba giriş yap ve Code sekmesini aç. Sonra buradan bağlantıyı kaydet.",
                    "Sign in to the matching account inside Claude and open Code. Then save the connection here.",
                  )}
                </p>
              </div>
            </div>
            <ConnectionProgress
              current={desktopIdentityReady ? 2 : 1}
              state={
                desktop?.busy
                  ? "working"
                  : desktop?.error
                    ? "failed"
                    : "waiting"
              }
              label={
                desktop?.busy
                  ? t("Bağlantı kaydediliyor", "Saving connection")
                  : desktop?.error
                    ? t("Bağlantı tamamlanmadı", "Connection incomplete")
                    : desktopIdentityReady
                      ? targetOrg
                        ? t("Bağlantıyı tamamla", "Complete connection")
                        : t("Code bağlantısı bekleniyor", "Waiting for Code")
                      : t(
                          "Claude’da giriş bekleniyor",
                          "Waiting for sign-in in Claude",
                        )
              }
              steps={[
                {
                  title: t("Claude açıldı", "Claude opened"),
                  detail: t("Giriş ekranı hazır", "Sign-in is ready"),
                },
                {
                  title: t("Hesabına giriş yap", "Sign in"),
                  detail: t(
                    "Bağlayacağın hesabı seç",
                    "Choose the account to connect",
                  ),
                },
                {
                  title: t("Code’u aç ve bağla", "Open Code & connect"),
                  detail: t(
                    "Bağlantıyı Relay’den kaydet",
                    "Save the connection in Relay",
                  ),
                },
              ]}
            />
            {desktop?.organizations.length! > 1 && (
              <label>
                {t("Code çalışma alanı", "Code workspace")}
                <select
                  value={targetOrg}
                  onChange={(e) => setOrg(e.target.value)}
                >
                  <option value="">
                    {t("Çalışma alanı seç", "Choose a workspace")}
                  </option>
                  {desktop?.organizations.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="panel-actions">
              <button
                className="secondary"
                disabled={desktopBusy}
                onClick={() => void action("open", () => api.openDesktop())}
              >
                <ArrowUpRight size={14} />
                {t("Claude’u yeniden aç", "Reopen Claude")}
              </button>
              <button
                className="text-button"
                disabled={desktopBusy}
                onClick={() => requestDesktop(pendingDesktop, "cancel")}
              >
                {t(
                  "İptal et ve önceki hesaba dön",
                  "Cancel and return to previous account",
                )}
              </button>
              {(hasUnclaimedDesktop ||
                desktop?.activeProfileId === pendingDesktop.id) &&
                targetOrg && (
                  <button
                    className="text-button"
                    disabled={desktopBusy}
                    onClick={() => requestDesktop(pendingDesktop, "capture")}
                  >
                    {t("Bağlantıyı tamamla", "Complete connection")}
                  </button>
                )}
            </div>
          </section>
        )}
        {flow && flow.id !== dismissed && (
          <section
            id="cli-connection-panel"
            className={`connection-panel ${flow.status === "connected" ? "connected-panel" : ""}`}
            aria-live="polite"
          >
            <div className="panel-title">
              {flow.status === "connected" ? (
                <ShieldCheck size={22} />
              ) : (
                <Globe2 size={22} />
              )}
              <div>
                <h3>
                  {flowAccount?.name} ·{" "}
                  {t("Tarayıcı bağlantısı", "Browser connection")}
                </h3>
                <p>
                  {flow.status === "connected"
                    ? t(
                        "Tarayıcı bağlantısı tamamlandı. Bu hesaba ait kullanım limitleri okunabilir.",
                        "Browser sign-in completed. Usage limits for this account can now be read.",
                      )
                    : flow.status === "verifying"
                      ? t(
                          "Tarayıcı onayı alındı. Hesabın doğrulanıyor…",
                          "Browser authorization received. Verifying your account…",
                        )
                      : flow.status === "failed"
                        ? localizeError(flow.error ?? "", language)
                        : flow.status === "cancelled"
                          ? t(
                              "Giriş iptal edildi. İstediğinde yeniden bağlanabilirsin.",
                              "Sign-in cancelled. You can reconnect whenever you like.",
                            )
                          : t(
                              "Tarayıcıda seçtiğin hesabı onayla. Bu ekran otomatik güncellenecek.",
                              "Authorize your chosen account in the browser. This screen updates automatically.",
                            )}
                </p>
              </div>
            </div>
            {flow.status === "connected" && flowAccount?.auth?.email && (
              <p className="auth-identity">
                {flowAccount.auth.email}
                {flowAccount.auth.subscription
                  ? ` · ${flowAccount.auth.subscription}`
                  : ""}
              </p>
            )}
            {flow.status === "connected" &&
              flowAccount &&
              duplicateCliAccount(flowAccount, accounts) && (
                <p className="account-warning">
                  {t(
                    "Bu hesap başka bir profile de bağlı. İki profil aynı limitleri paylaşır.",
                    "This account is connected to another profile too. Both profiles share the same limits.",
                  )}
                </p>
              )}
            <ConnectionProgress
              current={
                flow.status === "starting"
                  ? 0
                  : flow.status === "waiting"
                    ? 1
                    : 2
              }
              state={
                flow.status === "connected"
                  ? "complete"
                  : flow.status === "failed"
                    ? "failed"
                    : flow.status === "cancelled"
                      ? "cancelled"
                      : flow.status === "waiting"
                        ? "waiting"
                        : "working"
              }
              label={
                flow.status === "connected"
                  ? t("Hesap doğrulandı", "Account verified")
                  : flow.status === "failed"
                    ? t("Bağlantı tamamlanmadı", "Connection incomplete")
                    : flow.status === "cancelled"
                      ? t("Giriş iptal edildi", "Sign-in cancelled")
                      : flow.status === "verifying"
                        ? t("Hesap doğrulanıyor", "Verifying account")
                        : flow.status === "waiting"
                          ? t(
                              "Tarayıcı onayı bekleniyor",
                              "Waiting for browser approval",
                            )
                          : t("Giriş hazırlanıyor", "Preparing sign-in")
              }
              steps={[
                {
                  title: t("Girişi başlat", "Start sign-in"),
                  detail: t(
                    "Güvenli bağlantı hazırlanır",
                    "Prepare the sign-in link",
                  ),
                },
                {
                  title: t("Tarayıcıda onayla", "Approve in browser"),
                  detail: t(
                    "Hesabını seç ve izin ver",
                    "Choose and authorize your account",
                  ),
                },
                {
                  title: t("Bağlantıyı doğrula", "Verify connection"),
                  detail: t(
                    "Relay sonucu otomatik kontrol eder",
                    "Relay checks the result automatically",
                  ),
                },
              ]}
            />
            {flow.codeRequested && (
              <form
                className="code-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const value = code;
                  setCode("");
                  void action("code", () =>
                    api.submitLoginCode(flow.accountId, flow.id, value),
                  );
                }}
              >
                <label>
                  {t(
                    "Tarayıcı bir kod gösterdiyse buraya yapıştır",
                    "If the browser shows a code, paste it here",
                  )}
                  <input
                    type="password"
                    autoComplete="off"
                    value={code}
                    maxLength={4096}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <button className="secondary" disabled={!!busy || !code.trim()}>
                  {t("Kodu gönder", "Submit code")}
                </button>
              </form>
            )}
            <div className="panel-actions">
              {pending(flow) ? (
                <>
                  <button
                    className="secondary"
                    disabled={!!busy || !flow.browserReady}
                    onClick={() =>
                      void action("reopen", () =>
                        api.reopenLogin(flow.accountId, flow.id),
                      )
                    }
                  >
                    <ArrowUpRight size={14} />
                    {t("Tarayıcıyı yeniden aç", "Reopen browser")}
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() =>
                      void action("cancel", () =>
                        api.cancelLogin(flow.accountId, flow.id),
                      )
                    }
                  >
                    {t("İptal et", "Cancel")}
                  </button>
                </>
              ) : (
                <>
                  {flow.status !== "connected" && (
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => flowAccount && void startCli(flowAccount)}
                    >
                      {t("Yeniden bağlan", "Reconnect")}
                    </button>
                  )}
                  <button
                    className="secondary"
                    onClick={() => {
                      setDismissed(flow.id);
                      setAuthId(undefined);
                    }}
                  >
                    {t("Tamam", "Done")}
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {adding && (
          <form
            className="profile-form"
            onSubmit={(e) => {
              e.preventDefault();
              void action("create", async () => {
                const account = await api.createAccount({
                  name,
                  kind,
                  group:
                    kind === "work" && group.trim() ? group.trim() : undefined,
                });
                setAdding(false);
                setName("");
                setGroup("");
                setExpanded(account.id);
                setSetupId(account.id);
                setQuery("");
                setFilter("all");
                setNotice(
                  t(
                    "Profil oluşturuldu. Bağlantı seçeneklerini aşağıdan seç.",
                    "Profile created. Choose a connection option below.",
                  ),
                );
              });
            }}
          >
            <div className="form-title">
              <h3>{t("Yeni profil", "New profile")}</h3>
              <button
                type="button"
                className="icon"
                aria-label={t("Formu kapat", "Close form")}
                onClick={() => setAdding(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="form-grid">
              <label>
                {t("Hesap adı", "Account name")}
                <input
                  required
                  autoFocus
                  maxLength={64}
                  placeholder={t("Örn. Kişisel Max", "e.g. Personal Max")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label>
                {t("Tür", "Type")}
                <select
                  value={kind}
                  onChange={(e) =>
                    setKind(e.target.value as "personal" | "work")
                  }
                >
                  <option value="personal">{t("Kişisel", "Personal")}</option>
                  <option value="work">{t("Şirket", "Work")}</option>
                </select>
              </label>
            </div>
            {kind === "work" && (
              <label>
                {t("Paylaşım grubu · isteğe bağlı", "Sharing group · optional")}
                <input
                  list="groups"
                  maxLength={64}
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                  placeholder={t(
                    "Aynı gruptaki şirket hesapları Code geçmişini paylaşır",
                    "Work accounts in the same group share Code history",
                  )}
                />
                <datalist id="groups">
                  {[
                    ...new Set(
                      accounts
                        .filter(
                          (a) =>
                            a.kind === "work" && a.group !== `work:${a.id}`,
                        )
                        .map((a) => a.group.slice(5)),
                    ),
                  ].map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </label>
            )}
            <div className="form-end">
              <small>
                {kind === "personal"
                  ? t(
                      "Kişisel hesapların Code geçmişi aynı grupta korunur.",
                      "Personal accounts share their local Code history.",
                    )
                  : t(
                      "Boş bırakırsan bu şirket hesabı ayrı tutulur.",
                      "Leave blank to keep this work account separate.",
                    )}
              </small>
              <button className="primary" disabled={!!busy || !name.trim()}>
                {buttonLabel("create", t("Profil oluştur", "Create profile"))}
              </button>
            </div>
          </form>
        )}
        {!settings && (
          <section className="accounts-section">
            <div className="section-title">
              <h2>
                {t("Hesaplar", "Accounts")} <span>{accounts.length}</span>
              </h2>
              <button
                className="text-button"
                disabled={
                  desktopBusy || !!pendingDesktop || accounts.length >= 50
                }
                onClick={() => {
                  setAdding(!adding);
                  setSetupId(undefined);
                }}
              >
                <Plus size={15} />
                {t("Hesap ekle", "Add account")}
              </button>
            </div>
            {accounts.length > 4 && (
              <div className="filters">
                <label className="search">
                  <Search size={16} />
                  <input
                    ref={search}
                    aria-label={t("Hesap ara", "Search accounts")}
                    placeholder={t(
                      "Hesap, e-posta veya grup ara…",
                      "Search accounts, email or group…",
                    )}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <select
                  aria-label={t("Hesap filtresi", "Filter accounts")}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">{t("Tümü", "All accounts")}</option>
                  <option value="connected">
                    {t("Desktop bağlı", "Desktop connected")}
                  </option>
                  <option value="personal">{t("Kişisel", "Personal")}</option>
                  <option value="work">{t("Şirket", "Work")}</option>
                </select>
              </div>
            )}
            {suggestion && (
              <aside className="usage-suggestion">
                <div>
                  <strong>
                    {t("Limit yaklaşıyor", "Approaching the limit")} ·{" "}
                    {active?.name}
                  </strong>
                  <p>
                    {t(
                      `${suggestion.name} hesabında yer var. Görevlerin bitince geçebilirsin.`,
                      `${suggestion.name} has quota left. Switch when your tasks finish.`,
                    )}
                  </p>
                </div>
                <button
                  className="secondary"
                  onClick={() => requestDesktop(suggestion, "switch")}
                >
                  {t("Geçişi incele", "Review switch")}
                </button>
              </aside>
            )}
            <div className="account-rows">
              {visible.map((a) => {
                const isActive = a.id === active?.id;
                const authFlow = data?.authFlows.find(
                  (f) => f.accountId === a.id,
                );
                const usage = data?.usage[a.id];
                const reconnect = cliNeedsReconnect(a, usage);
                const mismatch = desktopCliMismatch(a);
                const duplicate = duplicateCliAccount(a, accounts);
                return (
                  <article
                    key={a.id}
                    className={`account-row ${isActive ? "is-active" : ""}`}
                  >
                    <div className="row-main">
                      <span className={`avatar ${a.color}`}>
                        {a.name.slice(0, 1).toLocaleUpperCase(language)}
                      </span>
                      <div className="row-info">
                        <h3>
                          {a.name}
                          {isActive && (
                            <span className="pill green">
                              {t("Aktif", "Active")}
                            </span>
                          )}
                        </h3>
                        <p className="account-email">
                          {a.desktop?.email ??
                            a.auth?.email ??
                            t(
                              "Henüz hesap bağlanmadı",
                              "No account connected yet",
                            )}
                        </p>
                        <p className="account-meta">
                          {groupName(a)}
                          {a.auth?.subscription
                            ? ` · ${a.auth.subscription === "max" ? "Max" : a.auth.subscription === "team" ? "Team" : a.auth.subscription}`
                            : ""}
                        </p>
                        <div className="connection-badges">
                          <span
                            className={`connection-badge ${a.desktop ? "connected" : "not-connected"}`}
                          >
                            {a.desktop ? (
                              <Check size={12} />
                            ) : (
                              <Monitor size={12} />
                            )}
                            {a.desktop
                              ? t("Desktop bağlı", "Desktop connected")
                              : t(
                                  "Desktop ilk kurulumu gerekli",
                                  "Desktop setup required",
                                )}
                          </span>
                          {!pending(authFlow) && (
                            <span
                              className={`connection-badge ${reconnect ? "not-connected" : "connected"}`}
                            >
                              {reconnect ? (
                                <RefreshCw size={12} />
                              ) : (
                                <Check size={12} />
                              )}
                              {reconnect
                                ? t(
                                    "Limitler için giriş gerekli",
                                    "Sign-in needed for usage",
                                  )
                                : t(
                                    "Limit bağlantısı hazır",
                                    "Usage connected",
                                  )}
                            </span>
                          )}
                          {pending(authFlow) && (
                            <span className="connection-badge">
                              <LoaderCircle size={12} className="spin" />
                              {t(
                                "Tarayıcı onayı bekleniyor",
                                "Waiting for browser approval",
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      {a.desktop ? (
                        <button
                          className={isActive ? "secondary" : "primary"}
                          disabled={
                            desktopBusy ||
                            !!pendingDesktop ||
                            desktop?.recoveryRequired
                          }
                          onClick={() =>
                            isActive
                              ? void action(`open:${a.id}`, () =>
                                  api.openDesktop(),
                                )
                              : requestDesktop(a, "switch")
                          }
                          aria-expanded={
                            !isActive && desktopRequest?.accountId === a.id
                          }
                        >
                          {busy === `switch:${a.id}` ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : isActive ? (
                            <ArrowUpRight size={14} />
                          ) : (
                            <ArrowLeftRight size={14} />
                          )}{" "}
                          {isActive
                            ? t("Aç", "Open")
                            : t("Geçiş yap", "Switch")}
                        </button>
                      ) : (
                        <button
                          className="secondary"
                          disabled={
                            desktopBusy ||
                            !desktop?.available ||
                            !!pendingDesktop ||
                            desktop?.recoveryRequired
                          }
                          aria-expanded={setupId === a.id}
                          onClick={() => {
                            setSetupId(a.id);
                            setExpanded(a.id);
                            setDesktopRequest(undefined);
                            setAdding(false);
                          }}
                        >
                          {t("Desktop’a bağla", "Connect Desktop")}
                        </button>
                      )}
                      <button
                        className={`details-button ${expanded === a.id ? "selected" : ""}`}
                        aria-label={t(
                          `${a.name} ayrıntıları`,
                          `${a.name} details`,
                        )}
                        aria-expanded={expanded === a.id}
                        aria-controls={`details-${a.id}`}
                        onClick={() => {
                          setExpanded(expanded === a.id ? undefined : a.id);
                          setDesktopRequest(undefined);
                          setSetupId(undefined);
                        }}
                      >
                        {t("Ayrıntılar", "Details")} <ChevronDown size={15} />
                      </button>
                    </div>
                    <UsageCard
                      usage={usage}
                      busy={usageBusy.has(a.id)}
                      connectBusy={!!busy || pending(authFlow)}
                      settings={preferences}
                      t={t}
                      language={language}
                      refresh={(allowPrompt) =>
                        void refreshUsage(a, allowPrompt)
                      }
                      connect={() => void startCli(a)}
                    />
                    {expanded === a.id && (
                      <div id={`details-${a.id}`} className="row-details">
                        <dl className="identity-details">
                          <div>
                            <dt>{t("Bağlı e-posta", "Connected email")}</dt>
                            <dd>
                              {a.desktop?.email ??
                                a.auth?.email ??
                                t("Giriş bekleniyor", "Waiting for sign-in")}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("Plan", "Plan")}</dt>
                            <dd>
                              {a.auth?.subscription ??
                                t("Bilinmiyor", "Unknown")}
                            </dd>
                          </div>
                          <div>
                            <dt>{t("Paylaşım grubu", "Sharing group")}</dt>
                            <dd>{groupName(a)}</dd>
                          </div>
                          {a.auth?.orgName && (
                            <div>
                              <dt>
                                {t("Bağlı kuruluş", "Connected organization")}
                              </dt>
                              <dd>{a.auth.orgName}</dd>
                            </div>
                          )}
                        </dl>
                        {duplicate && (
                          <p className="account-warning" role="status">
                            {t(
                              `Bu hesap ${duplicate.name} profiline de bağlı. İki profil aynı kullanım limitlerini paylaşır.`,
                              `This account is also connected to ${duplicate.name}. Both profiles share the same usage limits.`,
                            )}
                          </p>
                        )}
                        {mismatch && (
                          <p className="account-warning" role="alert">
                            {t(
                              "Desktop ve limit bağlantısı farklı hesaplara ait. Bu profilin doğru hesabıyla tarayıcı girişini yenile.",
                              "Desktop and usage are connected to different accounts. Reconnect browser sign-in with the correct account for this profile.",
                            )}
                          </p>
                        )}
                        <div className="connection-detail">
                          <div className="connection-detail-copy">
                            <Monitor size={17} />
                            <span>
                              <strong>Claude Desktop</strong>
                              <small>
                                {a.desktop
                                  ? t(
                                      "Kaydedildi · hesap geçişine hazır",
                                      "Saved · ready to switch",
                                    )
                                  : t(
                                      "İlk kurulum gerekli · henüz geçiş yapılamaz",
                                      "Setup required · switching is not ready yet",
                                    )}
                              </small>
                            </span>
                          </div>
                          {a.desktop ? (
                            <button
                              className="secondary"
                              disabled={!!desktopBusy || !!pendingDesktop}
                              onClick={() => requestDesktop(a, "reconnect")}
                            >
                              {t(
                                "Desktop girişini yenile…",
                                "Reconnect Desktop…",
                              )}
                            </button>
                          ) : (
                            <button
                              className="secondary"
                              disabled={
                                !!desktopBusy ||
                                !desktop?.available ||
                                !!pendingDesktop ||
                                desktop?.recoveryRequired
                              }
                              onClick={() => {
                                setSetupId(a.id);
                                setDesktopRequest(undefined);
                              }}
                            >
                              {t("Desktop’a bağla", "Connect Desktop")}
                            </button>
                          )}
                        </div>
                        {a.desktop && (
                          <HistorySummary
                            key={`${a.id}:${historyRevision}`}
                            account={a}
                            sources={historySources(a, accounts, preferences)}
                            api={api}
                            t={t}
                          />
                        )}
                        <div className="connection-detail">
                          <div className="connection-detail-copy">
                            <Globe2 size={17} />
                            <span>
                              <strong>
                                {t(
                                  "Kullanım limitleri · tarayıcı girişi",
                                  "Usage limits · browser sign-in",
                                )}
                              </strong>
                              <small>
                                {pending(authFlow)
                                  ? t(
                                      "Tarayıcı onayı bekleniyor",
                                      "Waiting for browser approval",
                                    )
                                  : reconnect
                                    ? t(
                                        "Giriş yenilenmeli",
                                        "Sign-in needs renewal",
                                      )
                                    : t("Bağlı", "Connected")}
                                {a.auth?.email ? ` · ${a.auth.email}` : ""}
                              </small>
                            </span>
                          </div>
                          <div className="connection-detail-actions">
                            <button
                              className="secondary"
                              disabled={!!busy || pending(authFlow)}
                              onClick={() => void startCli(a)}
                            >
                              {pending(authFlow)
                                ? t("Bağlanıyor…", "Connecting…")
                                : a.auth?.email
                                  ? t("Girişi yenile", "Reconnect")
                                  : t("Tarayıcıda bağla", "Connect in browser")}
                            </button>
                            <button
                              className="icon"
                              aria-label={t(
                                "CLI bağlantısını doğrula",
                                "Verify CLI connection",
                              )}
                              title={t(
                                "Bağlantıyı kontrol et",
                                "Check connection",
                              )}
                              disabled={!!busy || pending(authFlow)}
                              onClick={() =>
                                void action(`verify:${a.id}`, async () => {
                                  const checked = await api.checkAuth(a.id);
                                  setNotice(
                                    checked.auth?.loggedIn
                                      ? t(
                                          `${a.name} · ${checked.auth.email ?? ""} bağlantısı doğrulandı.`,
                                          `${a.name} · ${checked.auth.email ?? ""} connection verified.`,
                                        )
                                      : t(
                                          "Giriş doğrulanamadı. Tarayıcı girişini yenile.",
                                          "Could not verify sign-in. Reconnect in the browser.",
                                        ),
                                  );
                                })
                              }
                            >
                              <RefreshCw size={14} />
                            </button>
                          </div>
                        </div>
                        {setupId === a.id &&
                          !pendingDesktop &&
                          !desktopRequest && (
                            <DesktopSetup
                              account={a}
                              accounts={accounts}
                              desktop={desktop}
                              unclaimed={hasUnclaimedDesktop}
                              org={targetOrg}
                              busy={!!desktopBusy}
                              t={t}
                              selectAccount={setSetupId}
                              selectOrg={setOrg}
                              close={() => setSetupId(undefined)}
                              connect={() =>
                                requestDesktop(
                                  a,
                                  hasUnclaimedDesktop ? "capture" : "login",
                                )
                              }
                            />
                          )}
                        {desktopRequest?.accountId === a.id && (
                          <DesktopActionReview
                            key={`${a.id}:${desktopRequest.kind}`}
                            account={a}
                            active={active}
                            kind={desktopRequest.kind}
                            historyAccounts={historySources(
                              a,
                              accounts,
                              preferences,
                            )}
                            busy={!!desktopBusy}
                            t={t}
                            cancel={() => setDesktopRequest(undefined)}
                            confirm={confirmDesktopAction}
                          />
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            {!visible.length && (
              <div className="empty">
                <Monitor size={26} />
                <h3>
                  {accounts.length
                    ? t("Eşleşen hesap yok", "No matching accounts")
                    : t(
                        "Tek panel. Tüm hesapların.",
                        "One panel. All your accounts.",
                      )}
                </h3>
                <p>
                  {accounts.length
                    ? t(
                        "Aramayı veya filtreyi değiştir.",
                        "Try a different search or filter.",
                      )
                    : t(
                        "Önce Claude’da açık hesabını kaydet; ardından diğerlerini ekle.",
                        "Save the account open in Claude, then add your other accounts.",
                      )}
                </p>
              </div>
            )}
          </section>
        )}
        {settings && (
          <section className="settings-panel">
            <div className="form-title">
              <h3>{t("Ayarlar", "Settings")}</h3>
              <button className="secondary" onClick={() => setSettings(false)}>
                {t("Hesaplara dön", "Back to accounts")}
              </button>
            </div>
            <Preferences
              value={preferences}
              accounts={accounts}
              active={active}
              autoSwitch={data?.autoSwitch}
              continuation={data?.continuation}
              inspectContinuation={() =>
                void action("continuation-check", async () => {
                  const checked = await api.inspectContinuation();
                  setData((current) =>
                    current ? { ...current, continuation: checked } : current,
                  );
                })
              }
              armContinuation={() =>
                void action("continuation-arm", () =>
                  api.armContinuation(
                    "automatic",
                    "guarded-native-at-most-once",
                  ),
                )
              }
              disarmContinuation={() =>
                void action("continuation-disarm", () =>
                  api.disarmContinuation(),
                )
              }
              reconcileContinuation={() =>
                void action("continuation-reconcile", () =>
                  api.reconcileContinuation(),
                )
              }
              abandonContinuation={() =>
                void action("continuation-abandon", () =>
                  api.abandonContinuation(),
                )
              }
              fleet={data?.fleet}
              setFleet={(enabled) =>
                void action("fleet", () => api.setFleetContinuation(enabled))
              }
              requestAccessibility={() =>
                void action("continuation-permission", () =>
                  api.requestDesktopAccessibility(),
                )
              }
              usage={data?.usage ?? {}}
              statistics={data?.usageStatistics ?? {}}
              routines={data?.routines}
              updateAccount={(id, input) =>
                void action(`plan:${id}`, () =>
                  api.updateAccountPlanning(id, input),
                )
              }
              platform={data?.diagnostics.platform ?? "unknown"}
              sync={() => requestDesktop(active, "history")}
              syncDisabled={
                !!desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired
              }
              t={t}
              disabled={!!busy || !!desktop?.busy}
              update={(patch) =>
                void action("settings", () => api.updateSettings(patch))
              }
            />
            <details className="connection-info">
              <summary>
                {t(
                  "Bağlantı ve teknik bilgiler",
                  "Connection and technical details",
                )}
              </summary>
              <dl>
                <div>
                  <dt>Claude Desktop</dt>
                  <dd>
                    {desktop?.available
                      ? t("Bulundu", "Detected")
                      : t(
                          "Bulunamadı / desteklenmiyor",
                          "Not found / unsupported",
                        )}
                  </dd>
                </div>
                <div>
                  <dt>Claude Code CLI</dt>
                  <dd>
                    {data?.diagnostics.version ?? t("Bulunamadı", "Not found")}
                  </dd>
                </div>
              </dl>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void action("executable", () => api.pickExecutable())
                }
              >
                {t("Claude CLI dosyasını seç", "Choose Claude CLI executable")}
              </button>
              <p>
                {t(
                  "Desktop geçişi, Claude’un yerel dosya biçimine bağlı deneysel bir entegrasyondur. Code oturumları ve yerel proje kayıtları seçtiğin paylaşım kapsamında birleştirilir. Chat geçmişi ve sunucudaki proje grupları hesaplarına bağlı kalır.",
                  "Desktop switching is an experimental integration with Claude’s local file format. Code sessions and local project records merge within your chosen sharing scope. Chat history and server-managed project groups remain account-specific.",
                )}
              </p>
              <p>
                {t(
                  "Giriş kayıtları bu cihazda işletim sistemi şifrelemesiyle saklanır. Her geçişten önce yedek alınır. CLI girişi resmi Claude Code üzerinden tamamlanır.",
                  "Saved Desktop sign-ins are encrypted on this device using the operating system. Every switch creates a backup. CLI sign-in uses the official Claude Code.",
                )}
              </p>
            </details>
          </section>
        )}
        <footer>
          <span>
            <ShieldCheck size={13} />
            {t(
              "Yerelde saklanır. Kontrol sende.",
              "Stored locally. You’re in control.",
            )}
          </span>
          <span>
            {t("Bağımsız araç", "Independent tool")} · {APP_VERSION}
          </span>
        </footer>
      </main>
    </div>
  );
}
