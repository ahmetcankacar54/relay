import { LoaderCircle, RefreshCw } from "lucide-react";
import type {
  AccountUsage,
  RelaySettings,
  UsageIssue,
  UsageWindow,
} from "../shared/types";
import { remaining } from "../shared/usage";
type T = (tr: string, en: string) => string;
const issues: Record<UsageIssue, [string, string]> = {
  "connect-cli": [
    "Limitleri görmek için hesabını tarayıcıdan bağla.",
    "Connect your account in the browser to see usage limits.",
  ],
  "credentials-missing": [
    "Bu profilin giriş bilgisi okunamadı. Tarayıcı girişini yenile.",
    "This profile’s sign-in is unavailable. Reconnect in the browser.",
  ],
  "keychain-locked": [
    "Limitleri okumak için Anahtarlık erişimi gerekiyor.",
    "Keychain access is needed to read usage limits.",
  ],
  "renewal-required": [
    "Bağlantının yenilenmesi gerekiyor.",
    "The connection needs to be renewed.",
  ],
  expired: [
    "Limit bağlantısı yenilenemedi. Tarayıcıdan yeniden bağlan.",
    "The usage connection could not be renewed. Reconnect in the browser.",
  ],
  scope: [
    "Bu giriş kullanım verisine erişemiyor. Tarayıcı girişini yenile.",
    "This sign-in cannot access usage. Reconnect in the browser.",
  ],
  "identity-mismatch": [
    "Giriş kimliği bu profille eşleşmiyor. Bağlantıyı kontrol et.",
    "The sign-in identity does not match this profile. Check the connection.",
  ],
  "rate-limited": [
    "Kullanım servisi beklememizi istiyor.",
    "The usage service requested a pause.",
  ],
  unavailable: [
    "Kullanım servisine ulaşılamadı.",
    "The usage service is unavailable.",
  ],
  unsupported: [
    "Bu hesap için limit verisi okunamıyor.",
    "Usage data is unavailable for this account.",
  ],
};
export function UsageCard({
  usage,
  settings,
  t,
  language,
  refresh,
  connect,
  busy = false,
  connectBusy = false,
  now = Date.now(),
}: {
  usage?: AccountUsage;
  settings: RelaySettings;
  t: T;
  language: string;
  refresh: (allowPrompt?: boolean) => void;
  connect: () => void;
  busy?: boolean;
  connectBusy?: boolean;
  now?: number;
}) {
  const loading = busy || usage?.status === "loading";
  const displayedIssue =
    usage?.issue ??
    (usage?.connectionRenewalRequired ? "renewal-required" : undefined);
  const reconnect = [
    "expired",
    "credentials-missing",
    "scope",
    "identity-mismatch",
  ].includes(usage?.issue ?? "");
  const retry = usage?.retryAt && Date.parse(usage.retryAt) > now;
  const clock = (date: string) =>
    new Date(date).toLocaleString(language, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  const meter = (
    window: UsageWindow | undefined,
    title: string,
    key: "fiveHour" | "sevenDay",
  ) => {
    const left = remaining(window);
    // Team and Enterprise seats can return a five-hour window without a weekly one.
    const notReported =
      key === "sevenDay" &&
      !window &&
      usage?.status === "ready" &&
      !usage.issue &&
      !!usage.fiveHour;
    const warning =
      settings.usageWarnings &&
      usage?.status === "ready" &&
      !usage?.stale &&
      !usage.issue &&
      window &&
      (!window.resetsAt || Date.parse(window.resetsAt) > now) &&
      window.usedPercent >= settings.usageWarningPercent;
    const currentReset =
      window?.resetsAt && Number.isFinite(Date.parse(window.resetsAt))
        ? window.resetsAt
        : undefined;
    const currentResetIsFresh =
      currentReset &&
      usage?.status === "ready" &&
      !usage.stale &&
      !usage.issue &&
      Date.parse(currentReset) > now;
    const lastKnown = usage?.lastKnownResets?.[key];
    const validLastKnown =
      lastKnown &&
      Number.isFinite(Date.parse(lastKnown.resetsAt)) &&
      Number.isFinite(Date.parse(lastKnown.checkedAt)) &&
      Date.parse(lastKnown.checkedAt) <= now
        ? lastKnown
        : undefined;
    const historical =
      !currentResetIsFresh &&
      (validLastKnown ??
        (currentReset &&
        usage?.checkedAt &&
        Number.isFinite(Date.parse(usage.checkedAt)) &&
        Date.parse(usage.checkedAt) <= now
          ? { resetsAt: currentReset, checkedAt: usage.checkedAt }
          : undefined));
    return (
      <div className={`usage-window ${warning ? "usage-low" : ""}`}>
        <div className="usage-heading">
          <span>{title}</span>
          <strong>
            {left === undefined
              ? "—"
              : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(left)}%`}{" "}
            <small>
              {left !== undefined
                ? t("kaldı", "left")
                : notReported
                  ? t("Limit bildirilmiyor", "No limit reported")
                  : t("Veri yok", "No data")}
            </small>
          </strong>
        </div>
        <div
          className="usage-track"
          role={window ? "meter" : undefined}
          aria-label={title + t(" kalan kullanım", " remaining usage")}
          aria-valuemin={window ? 0 : undefined}
          aria-valuemax={window ? 100 : undefined}
          aria-valuenow={left}
        >
          <span style={{ width: `${left ?? 0}%` }} />
        </div>
        <div className="usage-reset">
          {currentResetIsFresh ? (
            <>
              {t("Yenilenir", "Resets")}{" "}
              <time dateTime={currentReset} title={currentReset}>
                {clock(currentReset!)}
              </time>
            </>
          ) : historical ? (
            <>
              {Date.parse(historical.resetsAt) <= now
                ? t("Önceki dönem", "Previous window")
                : t("Son bilinen yenilenme", "Last known reset")}{" "}
              <time dateTime={historical.resetsAt} title={historical.resetsAt}>
                {clock(historical.resetsAt)}
              </time>
              <div>
                {t("Son doğrulama", "Last verified")}{" "}
                <time
                  dateTime={historical.checkedAt}
                  title={historical.checkedAt}
                >
                  {clock(historical.checkedAt)}
                </time>
              </div>
            </>
          ) : notReported ? null : (
            t("Yenilenme zamanı yok", "Reset time unavailable")
          )}
          {warning && (
            <b>
              {window?.usedPercent === 100
                ? t(" · Limit doldu", " · Limit reached")
                : t(" · Limit yaklaşıyor", " · Near limit")}
            </b>
          )}
        </div>
      </div>
    );
  };
  if (usage?.issue === "connect-cli")
    return (
      <div className="usage-connect">
        <span>{t(...issues["connect-cli"])}</span>
        <button
          className="text-button"
          disabled={connectBusy}
          onClick={connect}
        >
          {t("Tarayıcıda bağla", "Connect in browser")}
        </button>
      </div>
    );
  return (
    <div className={`usage-card ${usage?.stale ? "is-stale" : ""}`}>
      <div className="usage-meters">
        {meter(usage?.fiveHour, t("5 saatlik", "5-hour"), "fiveHour")}
        {meter(usage?.sevenDay, t("Haftalık", "Weekly"), "sevenDay")}
      </div>
      <div className="usage-caption">
        <span>
          {usage?.stale && <b>{t("Eski veri · ", "Stale data · ")}</b>}
          {loading
            ? t("Limitler okunuyor…", "Reading usage…")
            : displayedIssue
              ? t(...issues[displayedIssue])
              : usage?.checkedAt
                ? `${t("Güncellendi", "Updated")} ${clock(usage.checkedAt)}`
                : t("Henüz sorgulanmadı", "Not checked yet")}
          {retry &&
            !reconnect &&
            usage?.issue !== "keychain-locked" &&
            displayedIssue !== "renewal-required" &&
            ` ${t("Tekrar", "Retry")} ${clock(usage!.retryAt!)}`}
        </span>
        {reconnect ? (
          <button
            className="text-button"
            disabled={loading || connectBusy}
            onClick={connect}
          >
            {t("Girişi yenile", "Reconnect")}
          </button>
        ) : displayedIssue === "keychain-locked" ||
          displayedIssue === "renewal-required" ? (
          <button
            className="text-button"
            disabled={loading}
            onClick={() => refresh(true)}
          >
            {displayedIssue === "renewal-required"
              ? t("Bağlantıyı yenile", "Renew connection")
              : t("Anahtarlık erişimine izin ver", "Allow Keychain access")}
          </button>
        ) : (
          <button
            className="icon"
            aria-label={t(
              "Kullanım limitlerini yenile",
              "Refresh usage limits",
            )}
            disabled={loading || !!retry}
            onClick={() => refresh()}
          >
            {loading ? (
              <LoaderCircle size={13} className="spin" />
            ) : (
              <RefreshCw size={13} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
