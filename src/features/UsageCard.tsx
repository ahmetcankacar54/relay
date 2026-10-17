import { LoaderCircle, RefreshCw } from "lucide-react";
import type {
  AccountUsage,
  RelaySettings,
  UsageIssue,
  UsageWindow,
} from "../../shared/types";
import { remaining } from "../../shared/usage";
import { Button } from "@/components/ui/button";
import { meterClass, meterTone } from "@/lib/meter";
import { cn } from "@/lib/utils";
type T = (tr: string, en: string) => string;
const issues: Record<UsageIssue, [string, string]> = {
  "connect-cli": [
    "Limitleri görmek için limit okuma girişini yap.",
    "Sign in to read usage to see usage limits.",
  ],
  "credentials-missing": [
    "Bu profilin giriş bilgisi okunamadı. Limit okuma girişini yenile.",
    "This profile’s sign-in is unavailable. Renew the usage sign-in.",
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
    "Limit okuma girişi yenilenemedi. Limit okuma girişini yenile.",
    "The usage sign-in could not be renewed. Renew the usage sign-in.",
  ],
  scope: [
    "Bu giriş kullanım verisine erişemiyor. Limit okuma girişini yenile.",
    "This sign-in cannot access usage. Renew the usage sign-in.",
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
    // A window with no usage yet has no reset; it starts with the next request.
    const unused =
      !!window &&
      window.usedPercent === 0 &&
      !window.resetsAt &&
      usage?.status === "ready" &&
      !usage.stale &&
      !usage.issue;
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
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>{title}</span>
          <strong
            className={cn(
              "text-sm whitespace-nowrap tabular-nums",
              warning ? "text-crit" : "text-foreground",
            )}
          >
            {left === undefined
              ? "—"
              : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(left)}%`}{" "}
            <small className="text-[11px] font-normal text-muted-foreground">
              {left !== undefined
                ? t("kaldı", "left")
                : notReported
                  ? t("Limit bildirilmiyor", "No limit reported")
                  : t("Veri yok", "No data")}
            </small>
          </strong>
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-track"
          role={window ? "meter" : undefined}
          aria-label={title + t(" kalan kullanım", " remaining usage")}
          aria-valuemin={window ? 0 : undefined}
          aria-valuemax={window ? 100 : undefined}
          aria-valuenow={left}
        >
          <span
            className={cn(
              "block h-full rounded-full",
              usage?.stale
                ? "bg-muted-foreground/40"
                : meterClass[meterTone(window?.usedPercent)],
            )}
            style={{ width: `${left ?? 0}%` }}
          />
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {currentResetIsFresh ? (
            <>
              {t("Yenilenir", "Resets")}{" "}
              <time dateTime={currentReset} title={currentReset}>
                {clock(currentReset!)}
              </time>
            </>
          ) : unused ? (
            t("İlk mesajla başlar", "Starts with the next message")
          ) : historical ? (
            <>
              {Date.parse(historical.resetsAt) <= now
                ? t("Önceki dönem", "Previous period")
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
            <b className="font-semibold text-crit">
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
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
        <span>{t(...issues["connect-cli"])}</span>
        <Button size="sm" variant="outline" disabled={connectBusy} onClick={connect}>
          {t("Limit okuma girişi yap", "Sign in to read usage")}
        </Button>
      </div>
    );
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-3">
        {meter(usage?.fiveHour, t("5 saatlik", "5-hour"), "fiveHour")}
        {meter(usage?.sevenDay, t("Haftalık", "Weekly"), "sevenDay")}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0">
          {usage?.stale && <b className="font-semibold text-warn-foreground">{t("Eski veri · ", "Stale data · ")}</b>}
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
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading || connectBusy}
            onClick={connect}
          >
            {t("Limit okuma girişini yenile", "Renew usage sign-in")}
          </Button>
        ) : displayedIssue === "keychain-locked" ||
          displayedIssue === "renewal-required" ? (
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading}
            onClick={() => refresh(true)}
          >
            {displayedIssue === "renewal-required"
              ? t("Bağlantıyı yenile", "Renew connection")
              : t("Anahtarlık erişimine izin ver", "Allow Keychain access")}
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={t(
              "Kullanım limitlerini yenile",
              "Refresh usage limits",
            )}
            disabled={loading || !!retry}
            onClick={() => refresh()}
          >
            {loading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
