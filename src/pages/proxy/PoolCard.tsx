import { Fragment } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { intentHash } from "@/app/routes";
import { AccountDot } from "@/components/AccountDot";
import { LimitLine } from "@/components/LimitLine";
import { ListCard, ListGroup, ListHead, ListRow, ListSection, narrowHidden } from "@/components/ListCard";
import { PageSection } from "@/components/PageSection";
import { Private } from "@/components/Private";
import { StatusDot } from "@/components/StatusDot";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { macWording, usePlatform } from "@/data/platform";
import { useRelay } from "@/data/relay-context";
import { compactCount, moveWithinProvider, pickReasonLabel, quotaAtRisk, resetLabel, usd } from "@/lib/proxy-ui";
import { cn } from "@/lib/utils";
import type { ProxyAccountStatus, ProxyStatus } from "../../../shared/types";
import { limitColumns, modelOnlyUsage } from "../../../shared/quota-windows";
import type { Patch } from "./shared";

/** The wall-clock time a wait of `minutes` ends at. */
function untilClock(minutes: number, language: string): string {
  return new Date(Date.now() + minutes * 60_000).toLocaleTimeString(language === "tr" ? "tr-TR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Why the gateway is leaving an account out, for the badge's tooltip. */
function waitingTitle(reason: "limit" | "auth" | "transient", t: (tr: string, en: string) => string): string {
  if (reason === "auth")
    return t(
      "Giriş reddedildi ya da okunamadı; Relay yeniliyor. Bu hesaptaki oturumlar giriş dönünce aynı hesaba döner.",
      "Its sign-in was refused or could not be read; Relay is renewing it. Sessions on this account come back to it once it works.",
    );
  if (reason === "transient")
    return t(
      "Anthropic yoğun ya da araya bir engel girdi; birkaç saniye beklenir. Oturumlar hesabında kalır.",
      "Anthropic is busy or something in front of it refused; a few seconds' wait. Sessions stay on the account.",
    );
  return t(
    "Bir limit dönemi doldu; sıfırlanınca yeniden kullanılır. Oturumları başka hesaba geçti.",
    "A limit window is spent; it is used again when it resets. Its sessions moved to another account.",
  );
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
  if (!account.inPool) return note("off", t("Havuz dışı", "Out of pool"));
  if (!account.signedIn) return note("crit", t("Giriş yok", "Not signed in"));
  // Saved, but the gateway could not read it: the page must not call the account ready.
  if (account.gatewaySignIn === "missing")
    return (
      <a href={`#/hesaplar/${account.id}`} data-slot="gateway-sign-in" className="flex min-w-0 shrink items-center gap-1 text-2xs text-crit underline-offset-2 hover:underline"
        title={
          mac
            ? t(
                "Ağ geçidi bu hesabın girişini okuyamadı (Keychain'de yok); istekler başka hesaplara gidiyor. Hesabın sayfasında limit okuma girişini yenile.",
                "The gateway could not read this account's sign-in (not in the Keychain); requests go to other accounts. Renew its usage sign-in on the account's page.",
              )
            : t(
                "Ağ geçidi bu hesabın girişini okuyamadı (kayıtlı giriş yok); istekler başka hesaplara gidiyor. Hesabın sayfasında limit okuma girişini yenile.",
                "The gateway could not read this account's sign-in (no saved sign-in); requests go to other accounts. Renew its usage sign-in on the account's page.",
              )
        }
      >
        <StatusDot tone="crit" />
        <span className="truncate">{t("Ağ geçidi girişi okuyamıyor", "Gateway can't read sign-in")}</span>
      </a>
    );
  if (account.extraUsage?.kind === "billed") return note("crit", t("Ekstra kullanım", "Extra usage"));
  if (account.waiting) {
    const when = resetLabel(account.waiting.minutes, t);
    const label =
      account.waiting.reason === "auth"
        ? t(`Giriş yenileniyor · ${when}`, `Renewing sign-in · ${when}`)
        : account.waiting.reason === "transient"
          ? t(`Kısa ara · ${when}`, `Short pause · ${when}`)
          : t(`Limitte · ${when}`, `At its limit · ${when}`);
    return note("warn", label, {
      slot: "waiting",
      title: `${waitingTitle(account.waiting.reason, t)} ${t(
        `Bitiş: ${untilClock(account.waiting.minutes, language)}.`,
        `Until ${untilClock(account.waiting.minutes, language)}.`,
      )}`,
    });
  }
  if ((account.quotaPercent ?? 0) >= 100) return note("crit", t("Dolu", "Full"));
  if (risk)
    return note("warn", t(`%${risk.percent} yanacak`, `${risk.percent}% expiring`), {
      slot: "at-risk",
      title: t(
        `Haftalık limit ${resetLabel(risk.minutes, t)} içinde sıfırlanıyor; kalan %${risk.percent} o zamana kadar kullanılmazsa boşa gider.`,
        `The weekly limit resets in ${resetLabel(risk.minutes, t)}; the ${risk.percent}% left is lost unless it is used by then.`,
      ),
    });
  if (account.gatewaySignIn === "expired")
    return note("warn", t("Giriş yenileniyor", "Renewing sign-in"), {
      slot: "gateway-sign-in",
      title: t(
        "Girişinin süresi doldu; Relay limit okurken yeniliyor. O zamana kadar istekler başka hesaplara gider.",
        "Its sign-in expired; Relay renews it when it reads the limits. Until then requests go to other accounts.",
      ),
    });
  if (account.active) return note("ok", t("Son istek", "Last request"));
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
  const locale = language === "tr" ? "tr-TR" : "en-US";
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
      title={t("Havuz", "Pool")}
      info={
        strict
          ? t(
              "Hesaplar bu sırayla kullanılır; biri dolunca sıradaki başlar. Okla sırala, anahtarla havuzdan çıkar.",
              "Accounts are used in this order; the next starts when one is full. Reorder with the arrows; the switch takes one out.",
            )
          : t(
              "Her istek kendi sağlayıcısının hesaplarından birine gider. Anahtar hesabı silmeden havuzdan çıkarır.",
              "Each request goes to an account of its own provider. The switch takes an account out without removing it.",
            )
      }
    >
      <ListCard label={t("Havuzdaki hesaplar", "Accounts in the pool")}>
        {accounts.length ? (
          <>
            <ListHead columns="pool">
              <span />
              <span>{t("Hesap", "Account")}</span>
              <span>{t("5 saat", "5 hours")}</span>
              <span className={narrowHidden}>{t("Hafta", "Week")}</span>
              <span className="text-right">{t("Havuzda", "In pool")}</span>
            </ListHead>
            {groups.map(({ provider, own }) => (
              <Fragment key={provider}>
                <ListGroup provider={provider} name={POOL_PROVIDER_NAMES[provider]} count={own.length} />
                <ListSection id={`pool-${provider}`} label={POOL_PROVIDER_NAMES[provider]}>
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
                      account.requests ? t(`${account.requests} istek`, `${account.requests} requests`) : undefined,
                      cache ? t(`önbellek ${compactCount(cache, locale)}`, `cache ${compactCount(cache, locale)}`) : undefined,
                      account.live ? t("canlı", "live") : undefined,
                      account.percentCost
                        ? t(`%1 ≈ ${usd(account.percentCost.dollars, locale)}`, `1% ≈ ${usd(account.percentCost.dollars, locale)}`)
                        : undefined,
                    ].filter(Boolean);
                    const details = [
                      account.live
                        ? t(
                            "Yüzdeler bu hesabın son yanıtındaki limit başlıklarından okundu.",
                            "The percents are from the limit headers of this account's last answer.",
                          )
                        : undefined,
                      account.percentCost
                        ? t(
                            `5 saatlik limitin %1'i son 7 günde ${account.percentCost.windows} dönemde ortalama ${usd(account.percentCost.dollars, locale)} tuttu (Claude Code kullanımı, API fiyatıyla). claude.ai sohbetleri bu hesapta yoksa oran daha güvenilirdir.`,
                            `1% of the 5-hour limit took ${usd(account.percentCost.dollars, locale)} on average over ${account.percentCost.windows} windows in the last 7 days (Claude Code use, at API prices). It is more reliable when the account is not also used for claude.ai chats.`,
                          )
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(" ");
                    const cell = (window: { usedPercent: number; resetsAt?: string; label?: string } | undefined, name: string) =>
                      window ? (
                        <LimitLine
                          label={pools ? (window.label ?? "") : ""}
                          ariaLabel={name}
                          usedPercent={window.usedPercent}
                          resetsAt={window.resetsAt}
                          period={pools ? undefined : name === t("Hafta", "Week") ? "seven_day" : "five_hour"}
                          now={now}
                          t={t}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      );
                    const unread = !five && !week;
                    return (
                      <ListRow
                        key={account.id}
                        columns="pool"
                        data={{
                          "data-account": account.id,
                          "data-in-pool": String(account.inPool),
                          ...(account.active ? { "data-active": "true" } : {}),
                        }}
                      >
                        <span className="flex flex-col">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={disabled || index === 0}
                            aria-label={t(`${account.name} yukarı`, `Move ${account.name} up`)}
                            onClick={() => move(account.id, -1)}
                          >
                            <ArrowUp />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={disabled || index === own.length - 1}
                            aria-label={t(`${account.name} aşağı`, `Move ${account.name} down`)}
                            onClick={() => move(account.id, 1)}
                          >
                            <ArrowDown />
                          </Button>
                        </span>
                        <div className={cn("grid min-w-0 gap-0.5", quiet && "opacity-60")} title={details || undefined}>
                          <span className="flex min-w-0 items-center gap-1.5">
                            <AccountDot color={known?.color} />
                            <span className="min-w-0 truncate text-sm font-medium">{account.name}</span>
                            <PoolNote account={account} />
                          </span>
                          {(served.length > 0 || account.email || clock) && (
                            <span className="truncate text-2xs text-muted-foreground tabular-nums">
                              {account.email && <Private>{account.email}</Private>}
                              {account.email && served.length ? " · " : ""}
                              {served.join(" · ")}
                              {clock && (
                                <span
                                  data-slot="full-at"
                                  className="text-warn-foreground"
                                  title={t(
                                    "Son yarım saatin hızıyla bu dönem sıfırlanmadan dolar.",
                                    "At the last half hour's pace this window fills before it resets.",
                                  )}
                                >
                                  {t(` · ${clock} gibi dolar`, ` · full by ${clock}`)}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                        {unread ? (
                          <span
                            className="text-2xs text-muted-foreground"
                            title={
                              account.provider === undefined || account.provider === "claude"
                                ? t("Limitler henüz okunmadı", "Limits not read yet")
                                : t("Relay bu sağlayıcının limitini okuyamıyor", "Relay cannot read this provider's limits")
                            }
                          >
                            {account.provider === undefined || account.provider === "claude"
                              ? t("Henüz okunmadı", "Not read yet")
                              : t("Okunamıyor", "Not readable")}
                          </span>
                        ) : (
                          <div className={cn("min-w-0", quiet && "opacity-60")}>{cell(five, t("5 saat", "5 hours"))}</div>
                        )}
                        <div className={cn("min-w-0", narrowHidden, quiet && "opacity-60")}>{unread ? null : cell(week, t("Hafta", "Week"))}</div>
                        <Switch
                          className="justify-self-end"
                          checked={account.inPool}
                          disabled={disabled}
                          aria-label={t(`${account.name} havuzda`, `${account.name} in the pool`)}
                          onCheckedChange={(on) => setInPool(account.id, on)}
                        />
                      </ListRow>
                    );
                  })}
                </ListSection>
              </Fragment>
            ))}
            {status.nextPick && (
              <p data-slot="next-pick" className="border-t px-4 py-2 text-2xs text-muted-foreground">
                {Object.entries(status.nextPick).map(([provider, pick], index, all) => {
                  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.name ?? "?";
                  const skipped = pick.nearlyFull?.length
                    ? t(
                        `; ${pick.nearlyFull.map(nameOf).join(", ")} limite yakın, atlanıyor`,
                        `; ${pick.nearlyFull.map(nameOf).join(", ")} near the limit, passed over`,
                      )
                    : "";
                  const who = all.length > 1 ? `${provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Antigravity"}: ` : "";
                  return (
                    <span key={provider} className="block">
                      {who}
                      {t("Yeni oturum şimdi → ", "A new session now → ")}
                      <span className="font-medium text-foreground">{nameOf(pick.accountId)}</span>
                      {` (${pickReasonLabel(pick.reason, t)})${skipped}`}
                      {pick.byModel?.map((scoped) => (
                        <span key={scoped.model} className="block">
                          {t(`${scoped.label} oturumu → `, `A ${scoped.label} session → `)}
                          <span className="font-medium text-foreground">
                            {scoped.accountId ? nameOf(scoped.accountId) : t("hiçbiri (her hesapta limit dolu)", "none (its limit is spent everywhere)")}
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
              {t(
                "Havuz boş. Bir hesap ekle; ağ geçidi istekleri onunla karşılar.",
                "The pool is empty. Add an account and the gateway answers with it.",
              )}
            </p>
            <Button asChild size="sm">
              <a href={intentHash("hesaplar", "ekle")}>
                <Plus />
                {t("Hesap ekle", "Add account")}
              </a>
            </Button>
          </div>
        )}
      </ListCard>
    </PageSection>
  );
}
