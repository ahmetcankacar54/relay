import { useState } from "react";
import { cva } from "class-variance-authority";
import { Badge } from "@/components/ui/badge";
import { LimitLine, MiniMeter, countdown } from "@/components/LimitLine";
import { useI18n, type T } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { usageWindowRows } from "@/data/selectors";
import { meterFill } from "@/lib/meter";
import { providerViews, type ProviderId, type ProviderView } from "@/lib/provider-view";
import { formatRelative } from "@/lib/time";
import { cn } from "@/lib/utils";
import { AccountDot } from "@/components/AccountDot";
import { ProviderLogo } from "@/components/ProviderLogo";
import { limitHeadline } from "../../shared/quota-windows";
import { freshUsage } from "../../shared/usage";
import type { Account, AccountUsage } from "../../shared/types";
import { accountPlan } from "../pages/accounts/accountLabels";
import { AntigravityAction, AntigravityPrompt, AntigravitySteps, antigravityAccountState, type AntigravityAsk } from "./AntigravityAccount";

export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

/** The providers Relay shows now, from the snapshot. */
export const relayProviders = (relay: Relay, now: number) =>
  providerViews({
    accounts: relay.accounts,
    usage: relay.data?.usage ?? {},
    active: relay.active,
    proxy: relay.desktop?.proxyStatus,
    antigravity: relay.data?.antigravity,
    now,
  });

const tab = cva(
  "grid min-w-0 gap-1 rounded-md px-2 pt-1 pb-1.5 text-center font-medium outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50",
  {
    variants: {
      selected: { true: "bg-accent text-foreground", false: "text-muted-foreground hover:text-foreground" },
      size: { sm: "text-2xs", md: "text-xs" },
    },
    defaultVariants: { selected: false, size: "md" },
  },
);

/**
 * One tab per provider (variant A), each with a hairline bar under its name: how full the account in
 * use is, so every provider reads at a glance without opening its tab.
 */
export function ProviderTabs({
  views,
  value,
  onChange,
  size = "md",
}: {
  views: ProviderView[];
  value: ProviderId;
  onChange: (id: ProviderId) => void;
  size?: "sm" | "md";
}) {
  const { t } = useI18n();
  return (
    <div role="tablist" aria-label={t("Sağlayıcılar", "Providers")} className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border bg-card p-1">
      {views.map((view) => {
        const used = view.head?.usedPercent;
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            data-provider={view.id}
            aria-selected={view.id === value}
            className={tab({ selected: view.id === value, size })}
            onClick={() => onChange(view.id)}
          >
            <span className="flex min-w-0 items-center justify-center gap-1.5">
              <ProviderLogo provider={view.id} size={size === "sm" ? "sm" : "md"} />
              <span className="truncate">{PROVIDER_NAMES[view.id]}</span>
            </span>
            <span aria-hidden="true" className="h-0.5 overflow-hidden rounded-full bg-track">
              {used !== undefined && view.tone !== "none" && (
                <span className={cn("block h-full rounded-full", meterFill(used))} style={{ width: `${Math.min(100, used)}%` }} />
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The tab Relay opens on: the one chosen last (kept per viewer), else the first. */
export function useProviderTab(views: ProviderView[], key: string): [ProviderId | undefined, (id: ProviderId) => void] {
  const [chosen, setChosen] = useState<ProviderId | undefined>(() => {
    try {
      return (window.localStorage?.getItem(key) as ProviderId | null) ?? undefined;
    } catch {
      return undefined;
    }
  });
  const value = views.some((v) => v.id === chosen) ? chosen : views[0]?.id;
  const set = (id: ProviderId) => {
    setChosen(id);
    try {
      window.localStorage?.setItem(key, id);
    } catch {
      // Not kept: the next open starts on the first tab.
    }
  };
  return [value, set];
}

/** A limit's short name: "5 saat", "Hafta", or the model's. */
function lineLabel(row: ReturnType<typeof usageWindowRows>[number], language: "tr" | "en", t: T) {
  if (row.key === "five_hour") return t("5 saat", "5 hours");
  if (row.key === "seven_day") return t("Hafta", "Week");
  return language === "tr" ? row.label.tr : row.label.en;
}

/** An account's limits as lines, the fullest model first; at most `max`. */
export function AccountLimits({
  usage,
  now,
  size = "sm",
  max = 4,
  note = true,
  layout = "stack",
}: {
  usage: AccountUsage | undefined;
  now: number;
  size?: "sm" | "md";
  max?: number;
  /** `grid` on a wide page: the lines side by side (pools in pairs, Claude's limits in threes). */
  layout?: "stack" | "grid";
  /** Says when an old reading was made (off where the caller says it). */
  note?: boolean;
}) {
  const { t, language } = useI18n();
  const rows = usageWindowRows(usage).slice(0, max);
  if (!rows.length) return <p className={cn("text-muted-foreground", size === "sm" ? "text-2xs" : "text-xs")}>{t("Limit verisi yok", "No usage data")}</p>;
  const faded = !freshUsage(usage, now);
  const readAt = usage?.checkedAt;
  return (
    <div
      className={cn(
        "grid",
        layout === "grid"
          ? cn("gap-x-6 gap-y-3 @lg:grid-cols-2", rows.length % 2 === 1 && "@2xl:grid-cols-3")
          : size === "sm"
            ? "gap-2"
            : "gap-3",
      )}
    >
      {rows.map((row) => (
        <LimitLine
          key={row.key}
          label={lineLabel(row, language, t)}
          usedPercent={row.usedPercent}
          resetsAt={row.resetsAt}
          period={row.period}
          now={now}
          t={t}
          size={size}
          faded={faded}
        />
      ))}
      {note && faded && readAt && (
        <p className="text-2xs text-muted-foreground">
          {t(`Eski okuma · ${formatRelative(readAt, now, language)}`, `Old reading · ${formatRelative(readAt, now, language)}`)}
        </p>
      )}
    </div>
  );
}

/** "%6", "Dolu · 25 dk" or "—": an account's binding limit in a row. */
export function headlineFigure(usage: AccountUsage | undefined, now: number, t: T) {
  const head = limitHeadline(usage, now);
  if (!head) return { text: "—", used: undefined, full: false };
  const full = head.usedPercent >= 100;
  const left = countdown(head.resetsAt, now, t);
  return {
    text: full ? (left ? t(`Dolu · ${left}`, `Full · ${left}`) : t("Dolu", "Full")) : `%${Math.round(head.usedPercent)}`,
    used: head.usedPercent,
    full,
  };
}

const via = (view: ProviderView, t: T) =>
  view.foreign
    ? t("Relay dışı hesap", "Not in Relay")
    : view.via === "gateway"
      ? t("Ağ geçidi", "Gateway")
      : view.via === "app"
        ? view.id === "claude"
          ? t("Claude uygulamasında", "In the Claude app")
          : t("Uygulamada açık", "Open in the app")
        : view.via === "own"
          ? t("Kendi girişi", "Own sign-in")
          : undefined;

const noCurrent = (view: ProviderView, t: T) =>
  view.foreign
    ? t("Antigravity, Relay'de olmayan bir hesapla açık", "Antigravity uses an account Relay does not have")
    : view.id === "antigravity"
      ? t("Antigravity'de açık hesap yok", "No account is open in Antigravity")
      : view.id === "codex"
        ? t("Henüz kullanılan bir hesap yok", "No account in use yet")
        : t("Claude uygulamasında kayıtlı hesap açık değil", "No saved account is open in the Claude app");

/**
 * A provider's accounts (variant A): the one in use on top with each of its limits, the others one
 * row each (name, one bar, one figure) with their one action. An Antigravity account moves the app
 * with "Geç" or has its sign-in saved first; Codex moves through the gateway by itself.
 */
export function ProviderPane({ view, now, size = "md" }: { view: ProviderView; now: number; size?: "sm" | "md" }) {
  const relay = useRelay();
  const { t } = useI18n();
  const [ask, setAsk] = useState<AntigravityAsk>();
  const usage = relay.data?.usage ?? {};
  const { current } = view;
  const others = view.accounts
    .filter((a) => a.id !== current?.id)
    .map((account) => ({ account, figure: headlineFigure(usage[account.id], now, t) }))
    .sort((a, b) => (a.figure.used ?? 101) - (b.figure.used ?? 101));
  const stuck = (view.head?.usedPercent ?? 0) >= 90;
  // The suggested move: the roomiest other account, when the one in use is (nearly) spent.
  const suggested = stuck ? others.find((o) => (o.figure.used ?? 100) < 90)?.account : undefined;
  const app = relay.data?.antigravity;
  const text = size === "sm" ? "text-xs" : "text-sm";
  const plan = current && accountPlan(current)?.short;
  const where = via(view, t);
  return (
    <div data-slot="provider-pane" data-provider={view.id} className="grid gap-2">
      <div data-slot="provider-current" className={cn("grid gap-2 rounded-lg border bg-card", size === "sm" ? "px-3 py-2.5" : "px-4 py-3")}>
        <div className="flex min-w-0 items-center gap-1.5">
          {current && <AccountDot color={current.color} />}
          <span className={cn("truncate font-semibold", text)}>{current?.name ?? PROVIDER_NAMES[view.id]}</span>
          {plan && <Badge variant="secondary">{plan}</Badge>}
          {current && where && <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{where}</span>}
        </div>
        {current ? (
          <AccountLimits usage={usage[current.id]} now={now} size={size} />
        ) : (
          <p className="text-2xs text-muted-foreground">{noCurrent(view, t)}</p>
        )}
      </div>
      {others.length > 0 && (
        <ul data-slot="provider-others" className="divide-y overflow-hidden rounded-lg border bg-card">
          {others.map(({ account, figure }) => (
            <li key={account.id} data-account={account.id} className={cn("flex items-center gap-2.5", size === "sm" ? "px-3 py-2" : "px-4 py-2.5")}>
              <AccountDot color={account.color} />
              <div className="grid min-w-0 flex-1 gap-1">
                <div className={cn("flex min-w-0 items-baseline justify-between gap-2", size === "sm" ? "text-xs" : "text-sm")}>
                  <span className="truncate font-medium">{account.name}</span>
                  <span className={cn("shrink-0 tabular-nums text-2xs", figure.full ? "font-semibold text-crit" : "text-muted-foreground")}>{figure.text}</span>
                </div>
                <MiniMeter usedPercent={figure.used} label={`${account.name} ${figure.text}`} />
              </div>
              {view.id === "antigravity" && <AntigravityAction account={account} onAsk={setAsk} primary={account.id === suggested?.id} />}
            </li>
          ))}
        </ul>
      )}
      {view.id === "antigravity" &&
        (app?.canSwitch ? (
          <AntigravityPrompt ask={ask} onClose={() => setAsk(undefined)} now={now} size={size} />
        ) : suggested && app?.installed && antigravityAccountState(app, suggested.id) === "unavailable" ? (
          <AntigravitySteps target={suggested} size={size} />
        ) : null)}
    </div>
  );
}
