import { Fragment } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { intentHash } from "@/app/routes";
import { AccountCard, AccountLimits } from "@/components/AccountCard";
import { ListCard, ListGroup, ListNote, ListSection } from "@/components/ListCard";
import { RiskNote } from "@/components/RiskConsent";
import { PageSection } from "@/components/PageSection";
import { Private } from "@/components/Private";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { FORMAT_LOCALE, type Locale } from "../../../shared/i18n/locales";
import { macWording, usePlatform } from "@/data/platform";
import { useRelay } from "@/data/relay-context";
import { compactCount, moveWithinProvider, pickReasonLabel, quotaAtRisk, resetLabel, usd } from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyAccountStatus, ProxyStatus } from "../../../shared/types";
import { limitColumns, modelOnlyUsage } from "../../../shared/quota-windows";
import type { Patch } from "./shared";
import type { T } from "../../../shared/i18n/translate";

/** The wall-clock time a wait of `minutes` ends at. */
function untilClock(minutes: number, language: Locale): string {
  return new Date(Date.now() + minutes * 60_000).toLocaleTimeString(FORMAT_LOCALE[language], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Why the gateway is leaving an account out, for the badge's tooltip. */
function waitingTitle(reason: "limit" | "auth" | "transient", t: T): string {
  if (reason === "auth")
    return t("poolCard.itsSignInWasRefusedOr");
  if (reason === "transient")
    return t("poolCard.anthropicIsBusyOrSomethingIn");
  return t("poolCard.aLimitWindowIsSpentIt");
}

/**
 * What an account's state needs said, as a short quiet note beside its name: out of the pool, no
 * sign-in, the gateway unable to read it, billed, waiting, full, about to lose quota, last served.
 * The colour is on the dot; the reason is the title.
 */
function PoolNote({ account }: { account: ProxyAccountStatus }) {
  const { t, language } = useI18n();
  const mac = macWording(usePlatform());
  const risk = quotaAtRisk(account);
  const note = (tone: "ok" | "warn" | "crit" | "off", text: string, extra: { slot?: string; title?: string } = {}) => (
    <span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
      <StatusDot tone={tone} />
      <span data-slot={extra.slot} title={extra.title} className="truncate">
        {text}
      </span>
    </span>
  );
  if (!account.inPool) return note("off", t("poolCard.outOfPool"));
  if (!account.signedIn) return note("crit", t("poolCard.notSignedIn"));
  // Saved, but the gateway could not read it: the page must not call the account ready.
  if (account.gatewaySignIn === "missing")
    return (
      <a href={`#/hesaplar/${account.id}`} data-slot="gateway-sign-in" className="flex min-w-0 shrink items-center gap-1 text-2xs text-crit underline-offset-2 hover:underline"
        title={
          mac
            ? t("poolCard.theGatewayCouldNotReadThis")
            : t("poolCard.theGatewayCouldNotReadThis2")
        }
      >
        <StatusDot tone="crit" />
        <span className="truncate">{t("poolCard.gatewayCanTReadSignIn")}</span>
      </a>
    );
  if (account.extraUsage?.kind === "billed") return note("crit", t("poolCard.extraUsage"));
  if (account.waiting) {
    const when = resetLabel(account.waiting.minutes, t);
    const label =
      account.waiting.reason === "auth"
        ? t("poolCard.renewingSignIn", { when })
        : account.waiting.reason === "transient"
          ? t("poolCard.shortPause", { when })
          : t("poolCard.atItsLimit", { when });
    return note("warn", label, {
      slot: "waiting",
      title: `${waitingTitle(account.waiting.reason, t)} ${t("poolCard.until", { untilClock: untilClock(account.waiting.minutes, language) })}`,
    });
  }
  if ((account.quotaPercent ?? 0) >= 100) return note("crit", t("common.full"));
  if (risk)
    return note("warn", t("poolCard.expiring", { riskPercent: risk.percent }), {
      slot: "at-risk",
      title: t("poolCard.theWeeklyLimitResetsInThe", { resetLabel: resetLabel(risk.minutes, t), riskPercent: risk.percent }),
    });
  if (account.gatewaySignIn === "expired")
    return note("warn", t("poolCard.renewingSignIn2"), {
      slot: "gateway-sign-in",
      title: t("poolCard.itsSignInExpiredRelayRenews"),
    });
  if (account.active) return note("ok", t("poolCard.lastRequest"));
  return null;
}

/** The pool's providers in the order every list shows them. */
const POOL_PROVIDERS = ["claude", "codex", "antigravity", "gemini"] as const;
const POOL_PROVIDER_NAMES: Record<(typeof POOL_PROVIDERS)[number], string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  gemini: "Gemini",
};

/** A window the gateway reports in minutes, as the time it resets. */
const resetAt = (minutes: number | undefined, now: number) =>
  minutes === undefined ? undefined : new Date(now + minutes * 60_000).toISOString();

/**
 * The pool: every account under its provider, in the order the gateway uses them, with both limit
 * windows and a switch that takes it out of the pool without removing it from Relay. What it served
 * and why it is left out are one quiet line; the details are the name's title.
 */
export function PoolCard({
  status,
  disabled,
  onConfigure,
}: {
  status: ProxyStatus;
  disabled: boolean;
  onConfigure: (patch: Patch) => Promise<boolean>;
}) {
  const { t, language } = useI18n();
  const relay = useRelay();
  const locale = FORMAT_LOCALE[language];
  const accounts = status.accounts;
  const excluded = accounts.filter((a) => !a.inPool).map((a) => a.id);
  const strict = status.routingStrategy === "strict-priority";
  const now = Date.now();
  const move = (id: string, by: -1 | 1) => void onConfigure({ accountOrder: moveWithinProvider(accounts, id, by) });
  const setInPool = (id: string, on: boolean) =>
    void onConfigure({
      excludedAccountIds: on ? excluded.filter((x) => x !== id) : [...excluded, id],
    });
  const groups = POOL_PROVIDERS.flatMap((provider) => {
    const own = accounts.filter((a) => (a.provider ?? "claude") === provider);
    return own.length ? [{ provider, own }] : [];
  });
  return (
    <PageSection
      slot="pool"
      title={t("poolCard.pool")}
      info={
        strict
          ? t("poolCard.accountsAreUsedInThisOrder")
          : t("poolCard.eachRequestGoesToAnAccount")
      }
    >
      <ListCard label={t("poolCard.accountsInThePool")} layout="cards">
        {accounts.length ? (
          <>
            {groups.map(({ provider, own }) => (
              <Fragment key={provider}>
                <ListGroup provider={provider} name={POOL_PROVIDER_NAMES[provider]} count={own.length} />
                <ListSection id={`pool-${provider}`} label={POOL_PROVIDER_NAMES[provider]}>
                  {/* Google forbids Antigravity sign-ins in other software outright: say so where they join the pool. */}
                  {provider === "antigravity" && (
                    <ListNote className="text-xs text-muted-foreground">
                      <RiskNote id="antigravity-gateway" slot="antigravity-risk" />
                    </ListNote>
                  )}
                  {own.map((account, index) => {
                    const quiet = !account.inPool;
                    const cache = account.tokens ? account.tokens.cacheRead : undefined;
                    const known = relay.accounts.find((a) => a.id === account.id);
                    const usage = relay.data?.usage[account.id];
                    // An Antigravity account's limits are its pools: each column the fullest of its length.
                    const pools = modelOnlyUsage(usage) ? limitColumns(usage, now) : undefined;
                    const five = pools
                      ? pools.five
                      : account.fiveHourPercent === undefined
                        ? undefined
                        : { usedPercent: account.fiveHourPercent, resetsAt: resetAt(account.fiveHourResetMinutes, now) };
                    const week = pools
                      ? pools.week
                      : account.weeklyPercent === undefined
                        ? undefined
                        : { usedPercent: account.weeklyPercent, resetsAt: resetAt(account.weeklyResetMinutes, now) };
                    const clock = account.fullAt
                      ? new Date(account.fullAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
                      : undefined;
                    const served = [
                      account.requests ? t("poolCard.requests", { accountRequests: account.requests }) : undefined,
                      cache ? t("poolCard.cache", { compactCount: compactCount(cache, locale) }) : undefined,
                      account.live ? t("poolCard.live") : undefined,
                      account.percentCost
                        ? t("poolCard.n1", { usd: usd(account.percentCost.dollars, locale) })
                        : undefined,
                    ].filter(Boolean);
                    const details = [
                      account.live
                        ? t("poolCard.thePercentsAreFromTheLimit")
                        : undefined,
                      account.percentCost
                        ? t("poolCard.n1OfThe5HourLimit", { usd: usd(account.percentCost.dollars, locale), percentCostWindows: account.percentCost.windows })
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const unread = !five && !week;
                    const unreadNote =
                      account.provider === undefined || account.provider === "claude" ? (
                        <span className="text-2xs text-muted-foreground" title={t("poolCard.limitsNotReadYet")}>
                          {t("poolCard.notReadYet")}
                        </span>
                      ) : (
                        <span className="text-2xs text-muted-foreground" title={t("poolCard.relayCannotReadThisProviderS")}>
                          {t("poolCard.notReadable")}
                        </span>
                      );
                    return (
                      <AccountCard
                        key={account.id}
                        color={known?.color}
                        name={account.name}
                        quiet={quiet}
                        title={details || undefined}
                        data={{
                          "data-account": account.id,
                          "data-in-pool": String(account.inPool),
                          ...(account.active ? { "data-active": "true" } : {}),
                        }}
                        action={
                          <span className="flex">
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={disabled || index === 0}
                              aria-label={t("poolCard.moveUp", { accountName: account.name })}
                              onClick={() => move(account.id, -1)}
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              disabled={disabled || index === own.length - 1}
                              aria-label={t("poolCard.moveDown", { accountName: account.name })}
                              onClick={() => move(account.id, 1)}
                            >
                              <ArrowDown />
                            </Button>
                          </span>
                        }
                        tags={<PoolNote account={account} />}
                        meta={
                          (served.length > 0 || account.email || clock) && (
                            <span className="min-w-0 truncate text-2xs tabular-nums">
                              {account.email && <Private>{account.email}</Private>}
                              {account.email && served.length ? " · " : ""}
                              {served.join(" · ")}
                              {clock && (
                                <span data-slot="full-at" className="text-warn-foreground" title={t("poolCard.atTheLastHalfHourS")}>
                                  {t("poolCard.fullBy", { clock })}
                                </span>
                              )}
                            </span>
                          )
                        }
                        limits={
                          unread ? (
                            unreadNote
                          ) : (
                            <AccountLimits five={five} week={week} pooled={!!pools} now={now} t={t} />
                          )
                        }
                        menu={
                          <Switch
                            checked={account.inPool}
                            disabled={disabled}
                            aria-label={t("poolCard.inThePool", { accountName: account.name })}
                            onCheckedChange={(on) => setInPool(account.id, on)}
                          />
                        }
                      />
                    );
                  })}
                </ListSection>
              </Fragment>
            ))}
            {status.nextPick && (
              <p data-slot="next-pick" className="px-1 pt-1 text-2xs text-muted-foreground">
                {Object.entries(status.nextPick).map(([provider, pick], index, all) => {
                  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? "?";
                  const skipped = pick.nearlyFull?.length
                    ? t("poolCard.nearTheLimitPassedOver", { join: pick.nearlyFull.map(nameOf).join(", ") })
                    : "";
                  const who = all.length > 1 ? `${provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Antigravity"}: ` : "";
                  return (
                    <span key={provider} className="block">
                      {who}
                      {t("poolCard.aNewSessionNow")}
                      <span className="font-medium text-foreground">{nameOf(pick.accountId)}</span>
                      {` (${pickReasonLabel(pick.reason, t)})${skipped}`}
                      {pick.byModel?.map((scoped) => (
                        <span key={scoped.model} className="block">
                          {t("poolCard.aSession", { scopedLabel: scoped.label })}
                          <span className="font-medium text-foreground">
                            {scoped.accountId ? nameOf(scoped.accountId) : t("poolCard.noneItsLimitIsSpentEverywhere")}
                          </span>
                        </span>
                      ))}
                    </span>
                  );
                })}
              </p>
            )}
          </>
        ) : (
          <div className="grid justify-items-start gap-2 px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {t("poolCard.thePoolIsEmptyAddAn")}
            </p>
            <Button asChild size="sm">
              <a href={intentHash("hesaplar", "ekle")}>
                <Plus />
                {t("common.addAccount")}
              </a>
            </Button>
          </div>
        )}
      </ListCard>
    </PageSection>
  );
}
