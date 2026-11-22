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
import { usageRowLabel, usageWindowRows } from "@/data/selectors";
import { keychainWords, usePlatform } from "@/data/platform";
import {
  formatPercent,
  formatUsed,
  meterFill,
  percentUsed,
  usedWord,
} from "@/lib/meter";
import { cn } from "@/lib/utils";
import type { MessageId, T } from "../../shared/i18n/translate";
import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
/** How long before a Claude Code sign-in's end the card says so (Claude Code itself warns 3 days ahead). */
const SIGN_IN_END_WARNING_MS = 3 * 86_400_000;
/** The Keychain's (Linux: keyring's) sentence comes from keychainWords. */
const issues: Record<Exclude<UsageIssue, "keychain-locked">, MessageId> = {
  "connect-cli": "usageCard.noUsageSignInYet",
  "credentials-missing": "usageCard.relayCannotReadThisProfilesSign",
  "renewal-required": "usageCard.theUsageSignInNeedsTo",
  expired: "usageCard.relayCannotRenewTheUsageSign",
  scope: "usageCard.thisSignInCannotReadUsage",
  "identity-mismatch": "usageCard.theUsageSignInDoesNot",
  "rate-limited": "usageCard.theUsageServiceAskedRelayTo",
  unavailable: "usageCard.cannotReachTheUsageService",
  unsupported: "usageCard.relayCannotReadLimitsForThis",
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
  appSignIn = false,
  now = Date.now(),
}: {
  /**
   * The account has a Claude app sign-in: when its Claude Code sign-in ended, the limits can be
   * read through it once the user allows the Keychain.
   */
  appSignIn?: boolean;
  /** The sign-in has its own button nearby (the account page's connection row): name the problem, offer no second button. */
  connectElsewhere?: boolean;
  usage?: AccountUsage;
  settings: RelaySettings;
  t: T;
  language: Locale;
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
  const keychain = keychainWords(usePlatform(), t);
  // A Claude Code sign-in ends about 30 days after it was made, whatever its renewals.
  const endsAt = usage?.cliSignInEndsAt ? Date.parse(usage.cliSignInEndsAt) : NaN;
  const endsInDays =
    !usage?.cliSignInEnded && endsAt > now && endsAt - now <= SIGN_IN_END_WARNING_MS
      ? Math.max(1, Math.ceil((endsAt - now) / 86_400_000))
      : undefined;
  const reconnect =
    [
      "expired",
      "credentials-missing",
      "scope",
      "identity-mismatch",
    ].includes(usage?.issue ?? "") ||
    !!usage?.cliSignInEnded ||
    endsInDays !== undefined;
  const retry = usage?.retryAt && Date.parse(usage.retryAt) > now;
  const clock = (date: string) =>
    new Date(date).toLocaleString(FORMAT_LOCALE[language], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  /** One limit: the account's five hours or week (`key`), or a model's own limit (`"model"`). */
  const meter = (
    window: UsageWindow | undefined,
    title: string,
    key: "fiveHour" | "sevenDay" | "model",
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
    const lastKnown = key === "model" ? undefined : usage?.lastKnownResets?.[key];
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
      <div key={title} className="min-w-0">
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
                  ? t("usageCard.noLimitReported")
                  : t("usageCard.noData")}
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
            style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }}
          />
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {currentResetIsFresh ? (
            <>
              {t("usageCard.resets")}{" "}
              <time dateTime={currentReset} title={currentReset}>
                {clock(currentReset!)}
              </time>
            </>
          ) : unused ? (
            t("usageCard.startsWithTheNextMessage")
          ) : historical ? (
            <>
              {Date.parse(historical.resetsAt) <= now
                ? t("usageCard.previousPeriod")
                : t("usageCard.lastKnownReset")}{" "}
              <time dateTime={historical.resetsAt} title={historical.resetsAt}>
                {clock(historical.resetsAt)}
              </time>
              <div>
                {t("usageCard.lastVerified")}{" "}
                <time
                  dateTime={historical.checkedAt}
                  title={historical.checkedAt}
                >
                  {clock(historical.checkedAt)}
                </time>
              </div>
            </>
          ) : notReported ? null : (
            t("usageCard.noResetTime")
          )}
          {warning && (
            <b className="font-semibold text-crit">
              {window?.usedPercent === 100
                ? t("usageCard.limitReached")
                : t("usageCard.nearLimit")}
            </b>
          )}
        </div>
      </div>
    );
  };
  if (usage?.issue === "connect-cli")
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
        <span>{t(issues["connect-cli"])}</span>
        {!connectElsewhere && (
          <Button size="sm" variant="outline" disabled={connectBusy} onClick={connect}>
            {t("common.signInToReadUsage")}
          </Button>
        )}
      </div>
    );
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-2 gap-3">
        {meter(usage?.fiveHour, t("usageCard.n5Hour"), "fiveHour")}
        {meter(usage?.sevenDay, t("usageCard.weekly"), "sevenDay")}
        {/* A model's own limit (Fable's week) stays in an old reading too, faded like the others. */}
        {usageWindowRows(usage)
          .filter((row) => row.model)
          .map((row) => meter(row, usageRowLabel(row, t), "model"))}
      </div>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0">
          {usage?.stale && <b className="font-semibold text-warn-foreground">{t("usageCard.usageDataIsOutOfDate")}</b>}
          {loading
            ? t("usageCard.relayReadsTheLimits")
            : shownIssue
              ? shownIssue === "keychain-locked"
                ? keychain.needed
                : t(issues[shownIssue])
              : usage?.checkedAt
                ? t("usageCard.updatedAt", {
                    time: clock(usage.checkedAt),
                    source: usage.source ?? "",
                    signIn: usage.cliSignInEnded ? "ended" : endsInDays !== undefined ? "ending" : "",
                    days: endsInDays ?? 0,
                  })
                : t("usageCard.notCheckedYet")}
          {retry &&
            !reconnect &&
            !renewal &&
            ` ${t("usageCard.nextTry", { time: clock(usage!.retryAt!) })}`}
        </span>
        {appSignIn && usage?.issue === "expired" && (
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading}
            onClick={() => refresh(true)}
          >
            {t("usageCard.readViaTheClaudeApp")}
          </Button>
        )}
        {reconnect && connectElsewhere ? (
          <span className="shrink-0">{t("usageCard.renewItUnderConnections")}</span>
        ) : reconnect ? (
          <Button
            size="sm"
            variant="link"
            className="h-auto shrink-0 px-0"
            disabled={loading || connectBusy}
            onClick={connect}
          >
            {usage?.source === "desktop" && !usage.cliSignInEnded
              ? t("common.signInToReadUsage")
              : t("common.renewUsageSignIn")}
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
              ? t("common.allowRenewal")
              : keychain.allow}
          </Button>
        ) : (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={t("common.refreshLimits")}
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
