import { Fragment, useState, type MouseEvent } from "react";
import { AntigravityAction, AntigravityPrompt, type AntigravityAsk } from "@/features/AntigravityAccount";
import {
  AppWindow,
  ArrowLeftRight,
  type LucideIcon,
  ArrowUpRight,
  Globe2,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Account, AccountProvider } from "../../../shared/types";
import type { Relay } from "@/data/relay-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n, type Language } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { keychainWords } from "@/data/platform";
import { limitFull, pendingFlow, windowAccounts } from "@/data/selectors";
import { offerAfter, usePrank, type PrankApi } from "@/pranks/PrankStage";
import { cn } from "@/lib/utils";
import {
  accountHealth,
  renewalIssue,
  } from "@/lib/account-health";
import { fullLimitNote } from "@/lib/account-row";
import { useExtensionStatus } from "@/data/useExtension";
import { useTerminalStatus } from "@/data/useTerminal";
import { accountPlan, planTitle, providerShortLabel } from "./accountLabels";
import { isClaudeAccount } from "@/lib/account-health";
import { fullestByPeriod, limitHeadline, modelOnlyUsage } from "../../../shared/quota-windows";
import { freshUsage } from "../../../shared/usage";
import { AccountDot } from "@/components/AccountDot";
import { LimitLine } from "@/components/LimitLine";
import { ListCard, ListGroup, ListHead, ListRow, narrowHidden } from "@/components/ListCard";
import { StatusLabel } from "@/components/StatusLabel";
import { relayProviders } from "@/features/Providers";
import { accountStatus } from "@/lib/account-status";
import { inUseIds } from "@/lib/provider-view";

/**
 * Says an account runs in its own Claude window, beside the main Claude. `compact`, in the table,
 * shows the icon alone, so a narrow row keeps the account's name.
 */
export function WindowBadge({
  t,
  compact = false,
}: {
  t: (tr: string, en: string) => string;
  compact?: boolean;
}) {
  const label = t("ayrı pencere", "separate window");
  return (
    <Badge
      variant="outline"
      data-slot="window-badge"
      className={cn("shrink-0 gap-1 text-2xs", compact ? "px-1" : "px-1.5")}
      title={t("Ayrı Claude penceresinde açık", "Open in a separate Claude window")}
    >
      <AppWindow className="size-3" />
      {compact ? <span className="sr-only">{label}</span> : label}
    </Badge>
  );
}

export interface RowAction {
  key:
    | "switch"
    | "open"
    | "window"
    | "window-show"
    | "window-close"
    | "cli"
    | "renew"
    | "desktop-reconnect"
    | "desktop-link"
    | "refresh"
    | "edit"
    | "remove";
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  run: () => void;
  /** Said under the label: why the item is disabled, or what to know before choosing it. */
  note?: string;
  /** "warn": a switch to an account whose limit is full; "destructive": the removal. */
  tone?: "warn" | "destructive";
}

/** Menu items for an account row, in display order. Pure so it can be tested. */
export function rowActions(
  a: Account,
  relay: Relay,
  t: (tr: string, en: string) => string,
  link: (id: string) => void = () => {},
  options: {
    /** Asks to remove the account (the confirmation dialog). */
    remove?: (id: string) => void;
    /** Opens the account's name, type and group for editing. */
    edit?: (id: string) => void;
    language?: Language;
    now?: number;
  } = {},
): RowAction[] {
  const { desktop, desktopBusy, pendingDesktop } = relay;
  const { language = "tr", now = Date.now() } = options;
  const isActive = a.id === relay.active?.id;
  const switchBlocked =
    desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired;
  const authFlow = relay.data?.authFlows.find((f) => f.accountId === a.id);
  // A full account can still be switched to; the item is tinted and says when it opens.
  const full = limitFull(relay.data?.usage[a.id], now);
  const windows = relay.data?.windows;
  // Its own window holds its sign-in: the main Claude cannot take it over until it closes.
  const inWindow = windowAccounts(relay.data).has(a.id);
  const windowNote = t("Önce ayrı penceresini kapat", "Close its separate window first");
  const items: RowAction[] = [];
  // Codex and Antigravity accounts feed the gateway: the Claude app, its windows and Claude Code sign-in do not apply.
  const claude = isClaudeAccount(a);
  if (claude && a.desktop && !isActive)
    items.push({
      key: "switch",
      label: t("Geç", "Switch"),
      icon: ArrowLeftRight,
      disabled: switchBlocked || inWindow,
      run: () => relay.requestDesktop(a, "switch"),
      ...(inWindow
        ? { note: windowNote }
        : full && {
            tone: "warn" as const,
            note: fullLimitNote(full.availableAt, t, language, relay.settings.planning.timeZone, now),
          }),
    });
  // An open window can always be brought forward or closed, even once the feature is turned off.
  if (claude && a.desktop && !isActive && windows?.supported && (windows.enabled || inWindow))
    items.push(
      ...(inWindow
        ? [
            {
              key: "window-show" as const,
              label: t("Penceresini öne getir", "Bring its window forward"),
              icon: AppWindow,
              disabled: false,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.openWindow(a.id)),
            },
            {
              key: "window-close" as const,
              label: t("Penceresini kapat", "Close its window"),
              icon: X,
              disabled: desktopBusy,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.closeWindow(a.id)),
            },
          ]
        : [
            {
              key: "window" as const,
              label: t("Ayrı pencerede aç", "Open in a separate window"),
              icon: AppWindow,
              disabled: switchBlocked,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.openWindow(a.id)),
            },
          ]),
    );
  if (claude && a.desktop && isActive)
    items.push({
      key: "open",
      label: t("Claude uygulamasını aç", "Open the Claude app"),
      icon: ArrowUpRight,
      disabled: switchBlocked,
      run: () =>
        void relay.action(`open:${a.id}`, () => relay.api.openDesktop()),
    });
  if (claude)
    items.push({
      key: "cli",
      label: a.auth?.email
        ? t("Limit okuma girişini yenile", "Renew usage sign-in")
        : t("Limit okuma girişi yap", "Sign in to read usage"),
      icon: Globe2,
      disabled: !!relay.busy || pendingFlow(authFlow),
      run: () => void relay.startCli(a),
    });
  // Only a refresh that may prompt clears these, so it is its own item, apart from "Refresh limits".
  const renewal = renewalIssue(relay.data?.usage[a.id]);
  if (claude && renewal)
    items.push({
      key: "renew",
      label:
        renewal === "keychain-locked"
          ? keychainWords(relay.data?.diagnostics?.platform, t).allow
          : t("Yenilemeye izin ver", "Allow renewal"),
      icon: KeyRound,
      disabled: relay.usageBusy.has(a.id),
      run: () => void relay.refreshUsage(a, true),
    });
  if (claude)
    items.push(
    a.desktop
      ? {
          key: "desktop-reconnect",
          label: t(
            "Claude uygulaması girişini yenile…",
            "Renew Claude app sign-in…",
          ),
          icon: Monitor,
          disabled: desktopBusy || !!pendingDesktop || inWindow,
          ...(inWindow && { note: windowNote }),
          run: () => relay.requestDesktop(a, "reconnect"),
        }
      : {
          key: "desktop-link",
          label: t(
            "Claude uygulaması girişini kaydet",
            "Save Claude app sign-in",
          ),
          icon: Monitor,
          disabled:
            desktopBusy ||
            !desktop?.available ||
            !!pendingDesktop ||
            !!desktop?.recoveryRequired,
          run: () => link(a.id),
        },
  );
  items.push({
    key: "refresh",
    label: t("Limitleri yenile", "Refresh limits"),
    icon: RefreshCw,
    disabled: relay.usageBusy.has(a.id),
    run: () => void relay.refreshUsage(a),
  });
  if (options.edit)
    items.push({
      key: "edit",
      label: t("Adı ve türü düzenle…", "Edit name and type…"),
      icon: Pencil,
      disabled: !!relay.busy,
      run: () => options.edit?.(a.id),
    });
  // Main refuses the same; the menu says why before it is chosen.
  const running = relay.data?.runs?.some(
    (r) => r.accountId === a.id && r.status === "running",
  );
  const removeBlock = isActive
    ? t("Önce başka bir hesaba geç", "Switch to another account first")
    : inWindow
      ? t("Önce ayrı penceresini kapat", "Close its separate window first")
      : pendingDesktop?.id === a.id
      ? t(
          "Önce Claude uygulaması girişini tamamla ya da iptal et",
          "Finish or cancel its Claude app sign-in first",
        )
      : pendingFlow(authFlow)
        ? t(
            "Önce limit okuma girişini tamamla ya da iptal et",
            "Finish or cancel its usage sign-in first",
          )
        : running
          ? t("Önce çalışan oturumu durdur", "Stop its active session first")
          : desktopBusy
            ? t("Claude uygulamasında bir işlem sürüyor", "A Claude app action is in progress")
            : undefined;
  items.push({
    key: "remove",
    label: t("Hesabı kaldır", "Remove account"),
    icon: Trash2,
    tone: "destructive",
    disabled: !!removeBlock,
    ...(removeBlock && { note: removeBlock }),
    run: () => options.remove?.(a.id),
  });
  return items;
}

/**
 * The ⋯ menu's items, for the table row and the account page alike: the sign-in items, then
 * Refresh limits and the removal, each after a separator. A note goes under its label.
 */
export function RowActionItems({
  actions,
  prank,
}: {
  actions: RowAction[];
  prank: PrankApi;
}) {
  return actions.map(({ key, label, icon: Icon, disabled, run, note, tone }) => (
    <Fragment key={key}>
      {(key === "refresh" || key === "remove") && <DropdownMenuSeparator />}
      <DropdownMenuItem
        disabled={disabled}
        variant={tone === "destructive" ? "destructive" : "default"}
        data-tone={tone}
        className={cn(tone === "warn" && "text-warn-foreground focus:text-warn-foreground")}
        {...itemHandlers({ key, disabled, run }, prank)}
      >
        <Icon className={cn(tone === "warn" && "text-warn")} />
        {note ? (
          <span className="grid">
            <span>{label}</span>
            <span className="text-xs text-muted-foreground">{note}</span>
          </span>
        ) : (
          label
        )}
      </DropdownMenuItem>
    </Fragment>
  ));
}

/**
 * What choosing a menu item does. Every item runs from `onSelect`, except the switch: Radix runs an
 * item's own `onClick` before its `onSelect`, so a click that only offered the prank would offer
 * before it switched. The switch item therefore switches from its click, through `offerAfter`, which
 * runs it first and offers after. Radix sends a mouse click, Enter and Space, and a release over the
 * item all through that click, and still closes the menu once it has run.
 */
export function itemHandlers(
  { key, disabled, run }: Pick<RowAction, "key" | "disabled" | "run">,
  prank: PrankApi,
): {
  onSelect?: () => void;
  onClick?: (event: MouseEvent<Element>) => void;
} {
  if (key !== "switch") return { onSelect: run };
  // A disabled switch item does nothing: it neither switches nor offers.
  if (disabled) return {};
  return { onClick: (e) => offerAfter(prank, "nibble-cursor", e, run) };
}

export function AccountsTable({
  accounts,
  selected,
  open,
  link,
  remove,
  edit,
}: {
  accounts: Account[];
  selected?: string;
  /** Opens the detail sheet for an account. */
  open: (id: string) => void;
  /** Starts Desktop setup for an account that has no saved Desktop sign-in. */
  link: (id: string) => void;
  /** Asks to remove an account (the confirmation dialog). */
  remove?: (id: string) => void;
  /** Opens an account's name, type and group for editing. */
  edit?: (id: string) => void;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { data, desktop, active } = relay;
  // Opening the list also checks the extension, so an account signed in to it gets linked.
  useExtensionStatus({ check: true });
  useTerminalStatus({ check: true });
  // An Antigravity row's switch or sign-in, confirmed under that row.
  const [antigravityAsk, setAntigravityAsk] = useState<AntigravityAsk>();
  const antigravityApp = data?.antigravity;
  const promptOn = (id: string) =>
    antigravityAsk
      ? antigravityAsk.accountId === id
      : antigravityApp?.busy
        ? antigravityApp.signInFor === id || (antigravityApp.busy === "switching" && antigravityApp.result?.accountId === id)
        : antigravityApp?.result?.accountId === id;
  const now = Date.now();
  const inUse = inUseIds(relayProviders(relay, now));
  const inWindows = windowAccounts(relay.data);
  const groups = PROVIDER_ORDER.flatMap((provider) => {
    const own = accounts.filter((a) => (a.provider ?? "claude") === provider);
    return own.length ? [{ provider, own }] : [];
  });
  return (
    <ListCard label={t("Hesaplar", "Accounts")} slot="accounts-list">
      <ListHead columns="accounts">
        <span />
        <span>{t("Hesap", "Account")}</span>
        <span>{t("Durum", "Status")}</span>
        <span>{t("5 saat", "5 hours")}</span>
        <span className={narrowHidden}>{t("Hafta", "Week")}</span>
        <span />
        <span />
      </ListHead>
      {groups.map(({ provider, own }) => (
        <Fragment key={provider}>
          <ListGroup provider={provider} name={providerShortLabel(provider)} count={own.length} />
          {own.map((a) => {
            const isActive = a.id === active?.id;
            const usage = data?.usage[a.id];
            const authFlow = data?.authFlows.find((f) => f.accountId === a.id);
            const waiting = pendingFlow(authFlow);
            const plan = accountPlan(a);
            const health = accountHealth(
              a,
              usage,
              { active: isActive, desktopRunning: !!desktop?.running, waiting, platform: data?.diagnostics?.platform },
              t,
            );
            const status = accountStatus({ account: a, usage, health, inUse: inUse.has(a.id), now, t });
            const actions = rowActions(a, relay, t, link, { remove, edit, language, now });
            // The one visible step: what fixes the account first, then a refresh of an old reading,
            // then the suggested switch. Everything else is in the ⋯ menu.
            const fix = health.tone !== "ok" && !health.limit && health.fix ? actions.find((x) => x.key === health.fix) : undefined;
            const stale = !waiting && !health.fix && !!usage && (usage.stale || usage.status === "error");
            const refresh = stale ? actions.find((x) => x.key === "refresh") : undefined;
            const suggested = relay.suggestion?.id === a.id;
            const switchTo = suggested && !inWindows.has(a.id) ? actions.find((x) => x.key === "switch") : undefined;
            const step = fix ?? refresh;
            // An Antigravity account's limits are its pools: each column shows the fullest pool of that
            // length, named. Windows of unknown length (an older reading) show the fullest in the first.
            const pooled = modelOnlyUsage(usage);
            const byPeriod = pooled ? fullestByPeriod(usage, now) : {};
            const head = pooled ? (byPeriod.five_hour ?? (byPeriod.seven_day ? undefined : limitHeadline(usage, now))) : undefined;
            const weekHead = byPeriod.seven_day;
            const five = pooled ? head : usage?.fiveHour;
            const week = pooled ? weekHead : usage?.sevenDay;
            const faded = !!usage && !freshUsage(usage, now);
            const cell = (window: typeof five, name: string) =>
              window ? (
                <LimitLine
                  label=""
                  ariaLabel={pooled ? `${name} · ${(window as { label?: string }).label ?? ""}` : name}
                  usedPercent={window.usedPercent}
                  resetsAt={window.resetsAt}
                  now={now}
                  t={t}
                  faded={faded}
                  showReset={false}
                />
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              );
            const stop = (e: MouseEvent) => e.stopPropagation();
            return (
              <Fragment key={a.id}>
                <ListRow
                  columns="accounts"
                  onOpen={() => open(a.id)}
                  selected={selected === a.id}
                  label={a.name}
                  data={{ "data-account": a.id }}
                >
                  <AccountDot color={a.color} />
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm font-semibold" title={a.name}>
                      {a.name}
                    </span>
                    {plan && (
                      <span className={cn("shrink-0 text-2xs text-muted-foreground", narrowHidden)} title={planTitle(a, plan, t)}>
                        {plan.short}
                      </span>
                    )}
                    {inWindows.has(a.id) && <WindowBadge t={t} compact />}
                  </div>
                  <StatusLabel status={status} />
                  {cell(five, t("5 saat", "5 hours"))}
                  <div className={narrowHidden}>{cell(week, t("Hafta", "Week"))}</div>
                  <div className="flex justify-end" onClick={stop}>
                    {a.provider === "antigravity" && !step ? (
                      <AntigravityAction account={a} onAsk={setAntigravityAsk} primary={suggested} />
                    ) : step ? (
                      <Button size="xs" variant="outline" aria-label={`${step.label} · ${a.name}`} title={step.label} disabled={step.disabled} onClick={() => step.run()}>
                        {step === refresh ? t("Yenile", "Refresh") : shortFix(step.key, t) ?? step.label}
                      </Button>
                    ) : switchTo ? (
                      <Button size="xs" aria-label={`${switchTo.label} · ${a.name}`} disabled={switchTo.disabled} onClick={(e) => itemHandlers(switchTo, prank).onClick?.(e)}>
                        {t("Geç", "Switch")}
                      </Button>
                    ) : null}
                  </div>
                  <div onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t(`${a.name} işlemleri`, `${a.name} actions`)}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      {/* Portaled, but React events still bubble to the row. */}
                      <DropdownMenuContent align="end" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
                        <RowActionItems actions={actions} prank={prank} />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </ListRow>
                {a.provider === "antigravity" && promptOn(a.id) && (
                  <div className="border-b px-4 py-2 last:border-b-0">
                    <AntigravityPrompt ask={antigravityAsk} onClose={() => setAntigravityAsk(undefined)} now={now} size="sm" />
                  </div>
                )}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </ListCard>
  );
}

/** The providers' order in a list: Claude first, then the gateway's. */
const PROVIDER_ORDER: AccountProvider[] = ["claude", "codex", "antigravity", "gemini"];

/** A fix's button in a narrow column: one or two words; the menu item keeps the full label. */
function shortFix(key: string, t: (tr: string, en: string) => string): string | undefined {
  if (key === "desktop-link") return t("Kaydet", "Save");
  if (key === "cli") return t("Bağla", "Connect");
  if (key === "renew") return t("Yenile", "Renew");
  return undefined;
}
