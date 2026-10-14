import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Globe2,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Account } from "../../shared/types";
import {
  cliNeedsReconnect,
  desktopCliMismatch,
  duplicateCliAccount,
} from "../../shared/account-state";
import { historySources } from "../../shared/history-policy";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { UsageCard } from "../UsageCard";
import { Preferences } from "../Preferences";
import { DesktopSetup } from "../DesktopSetup";
import { HistorySummary } from "../HistorySummary";
import type { DesktopActionRequest } from "../DesktopActionReview";

// Temporary: the pre-redesign accounts list and preferences, mounted inside the
// new shell until the dedicated pages replace them (Tasks 7–13).

export function LegacyHome() {
  const relay = useRelay();
  const { t, language } = useI18n();
  const {
    api,
    version: APP_VERSION,
    data,
    desktop,
    accounts,
    active,
    settings: preferences,
    busy,
    usageBusy,
    desktopBusy,
    pendingDesktop,
    hasUnclaimedDesktop,
    targetOrg,
    setOrg,
    action,
    setNotice,
    refreshUsage,
    desktopRequest,
    setupId,
    setSetupId,
    flow,
    historyRevision,
    suggestion,
  } = relay;
  const pending = pendingFlow;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"personal" | "work">("personal");
  const [group, setGroup] = useState("");
  const [expanded, setExpanded] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
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
  useEffect(() => {
    const id = flow?.id
      ? "cli-connection-panel"
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
  }, [flow?.id, desktop?.pendingProfileId, setupId]);
  const requestDesktop = (
    account: Account | undefined,
    kind: DesktopActionRequest["kind"],
  ) => relay.requestDesktop(account, kind);
  const startCli = (a: Account) => relay.startCli(a);
  const buttonLabel = (key: string, label: string) => (
    <>
      {busy === key ? <LoaderCircle className="spin" size={15} /> : null}
      {label}
    </>
  );
  return (
    <div className="switcher">
      <div className="switcher-main mx-0 max-w-none px-6 pt-0">
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
                              : t("Limit bağlantısı hazır", "Usage connected")}
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
                        aria-haspopup={isActive ? undefined : "dialog"}
                      >
                        {busy === `switch:${a.id}` ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : isActive ? (
                          <ArrowUpRight size={14} />
                        ) : (
                          <ArrowLeftRight size={14} />
                        )}{" "}
                        {isActive ? t("Aç", "Open") : t("Geçiş yap", "Switch")}
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
                          relay.cancelDesktopRequest();
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
                        relay.cancelDesktopRequest();
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
                    refresh={(allowPrompt) => void refreshUsage(a, allowPrompt)}
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
                            {a.auth?.subscription ?? t("Bilinmiyor", "Unknown")}
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
                              relay.cancelDesktopRequest();
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
      </div>
    </div>
  );
}

export function LegacySettings({
  section,
}: {
  section: "switch" | "usage" | "planning";
}) {
  const relay = useRelay();
  const { t } = useI18n();
  const {
    api,
    data,
    desktop,
    accounts,
    active,
    settings: preferences,
    busy,
    desktopBusy,
    pendingDesktop,
    action,
    setData,
  } = relay;
  const requestDesktop = relay.requestDesktop;
  return (
    <div className="switcher">
      <div className="switcher-main mx-0 max-w-none px-6 pt-0">
        <section className="settings-panel">
          <Preferences
            only={section}
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
                api.armContinuation("automatic", "guarded-native-at-most-once"),
              )
            }
            disarmContinuation={() =>
              void action("continuation-disarm", () => api.disarmContinuation())
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
            keeper={data?.planning}
            updatePlanning={(patch) =>
              void action("planning", () => api.updatePlanning(patch))
            }
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
      </div>
    </div>
  );
}
