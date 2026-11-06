import { LoaderCircle } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import type {
  AccountUsage,
  RelaySettings,
  UsageIssue,
  UsageWindow,
} from "../../shared/types";
import { Button } from "@/components/ui/button";
import { displayedIssue, renewalIssue } from "@/lib/account-health";
import {
  formatPercent,
  formatUsed,
  meterFill,
  percentUsed,
  usedWord,
} from "@/lib/meter";
import { cn } from "@/lib/utils";
type T = (tr: string, en: string) => string;
const issues: Record<UsageIssue, [string, string]> = {
  "connect-cli": [
    "Henüz limit okuma girişi yok.",
    "No usage sign-in yet.",
  ],
  "credentials-missing": [
    "Bu profilin giriş bilgisi okunamadı.",
    "Relay cannot read this profile’s sign-in.",
  ],
  "keychain-locked": [
    "Limitleri okumak için Anahtarlık erişimi gerekiyor.",
    "Relay needs Keychain access to read limits.",
  ],
  "renewal-required": [
    "Limit okuma girişinin yenilenmesi gerekiyor.",
    "The usage sign-in needs to be renewed.",
  ],
  expired: [
    "Limit okuma girişi kendiliğinden yenilenemedi.",
    "Relay cannot renew the usage sign-in automatically.",
  ],
  scope: [
    "Bu giriş kullanım verisine erişemiyor.",
    "This sign-in cannot read usage.",
  ],
  "identity-mismatch": [
    "Limit okuma girişi bu profilin hesabına ait değil.",
    "The usage sign-in does not belong to this profile’s account.",
  ],
  "rate-limited": [
    "Kullanım servisi kısa bir süre beklenmesini istedi.",
    "The usage service asked Relay to wait.",
  ],
  unavailable: [
    "Kullanım servisine ulaşılamadı.",
    "Cannot reach the usage service.",
  ],
  unsupported: [
    "Bu hesap için limit verisi okunamıyor.",
    "Relay cannot read limits for this account.",
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
  connectElsewhere = false,
  now = Date.now(),
}: {
  /** The sign-in has its own button nearby (the account page's connection row): name the problem, offer no second button. */
  connectElsewhere?: boolean;
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
  // The same reading as the account's status and the banners.
  const shownIssue = displayedIssue(usage);
  const renewal = renewalIssue(usage);
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
    const used = window
      ? Math.max(0, Math.min(100, window.usedPercent))
      : undefined;
    const shown = percentUsed(used);
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
              "text-sm tabular-nums",
              warning ? "text-crit" : "text-foreground",
            )}
          >
            {/* The phrase after it may wrap; the percentage never breaks. */}
            <span className="whitespace-nowrap">
              {formatPercent(shown, language)}
            </span>{" "}
            <small className="text-xs font-normal text-muted-foreground">
              {shown !== undefined
                ? usedWord(language)
                : notReported
                  ? t("Limit bildirilmiyor", "No limit reported")
                  : t("Veri yok", "No data")}
            </small>
          </strong>
        </div>
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-track"
          role={window ? "meter" : undefined}
          aria-label={title}
          aria-valuemin={window ? 0 : undefined}
          aria-valuemax={window ? 100 : undefined}
          aria-valuenow={used}
          aria-valuetext={window ? formatUsed(used, language) : undefined}
        >
          <span
            className={cn(
              "block h-full rounded-full",
              usage?.stale
                ? "bg-muted-foreground/40"
                : meterFill(window?.usedPercent),
            )}
            style={{ width: `${used ?? 0}%` }}
          />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {currentResetIsFresh ? (
            <>
              {t("Yenilenir", "Resets")}{" "}
              <time dateTime={currentReset} title={currentReset}>
                {clock(currentReset!)}
              </time>
            </>
          ) : unused ? (
            t("Sonraki mesajla başlar", "Starts with the next message")
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
            t("Yenilenme zamanı yok", "No reset time")
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
        {!connectElsewhere && (
          <Button size="sm" variant="outline" disabled={connectBusy} onClick={connect}>
            {t("Limit okuma girişi yap", "Sign in to read usage")}
          </Button>
        )}
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
          {usage?.stale && <b className="font-semibold text-warn-foreground">{t("Limit verisi eski · ", "Usage data is out of date · ")}</b>}
          {loading
            ? t("Limitler okunuyor…", "Relay reads the limits…")
            : shownIssue
              ? t(...issues[shownIssue])
              : usage?.checkedAt
                ? `${t("Güncellendi", "Updated")} ${clock(usage.checkedAt)}`
                : t("Henüz sorgulanmadı", "Not checked yet")}
          {retry &&
            !reconnect &&
            !renewal &&
            ` ${t("Tekrar", "Next try")} ${clock(usage!.retryAt!)}`}
        </span>
        {reconnect && connectElsewhere ? (
          <span className="shrink-0">{t("Bağlantılar’dan yenile", "Renew it under Connections")}</span>
        ) : reconnect ? (
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading || connectBusy}
            onClick={connect}
          >
            {t("Limit okuma girişini yenile", "Renew usage sign-in")}
          </Button>
        ) : renewal ? (
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading}
            onClick={() => refresh(true)}
          >
            {renewal === "renewal-required"
              ? t("Yenilemeye izin ver", "Allow renewal")
              : t("Anahtarlık erişimine izin ver", "Allow Keychain access")}
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={t("Limitleri yenile", "Refresh limits")}
            disabled={loading || !!retry}
            onClick={() => refresh()}
          >
            {loading ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RefreshIcon />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
