import { Fragment, useState, type MouseEvent } from "react";
import { AntigravityAction, AntigravityPrompt, antigravityAccountState, type AntigravityAsk } from "@/features/AntigravityAccount";
import { Private } from "@/components/Private";
import {
  AppWindow,
  ArrowLeftRight,
  type LucideIcon,
  ArrowUpRight,
  Globe2,
  KeyRound,
  Monitor,
  MoreHorizontal,
  Network,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import type { Account } from "../../../shared/types";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusDot } from "@/components/StatusDot";
import { ProviderBadge } from "@/components/ProviderBadge";
import { useI18n, type Language } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { keychainWords } from "@/data/platform";
import { limitFull, pendingFlow, windowAccounts } from "@/data/selectors";
import { offerAfter, usePrank, type PrankApi } from "@/pranks/PrankStage";
import { cn } from "@/lib/utils";
import {
  accountHealth,
  renewalIssue,
  usageSignInStatus,
} from "@/lib/account-health";
import { fullLimitNote } from "@/lib/account-row";
import { extensionGuide } from "@/lib/extension-ui";
import { formatPercent, percentUsed } from "@/lib/meter";
import { formatRelative } from "@/lib/time";
import { MiniMeter } from "@/components/LimitLine";
import { useExtensionStatus } from "@/data/useExtension";
import { useTerminalStatus } from "@/data/useTerminal";
import { terminalGuide } from "@/lib/terminal-ui";
import type { TerminalStatus } from "../../../shared/terminal-identity";
import type { ExtensionStatus } from "../../../shared/types";
import { accountPlan, avatarClass, planTitle, providerLabel } from "./accountLabels";
import { isClaudeAccount } from "@/lib/account-health";
import { fullestByPeriod, limitHeadline, modelOnlyUsage } from "../../../shared/quota-windows";

/**
 * A connection icon's three states: green when ready, amber with a dot when it needs a step (a
 * sign-in to renew reads the same; the Durum column says how bad), grey when absent.
 */
const toneText = {
  ok: "text-ok",
  warn: "text-warn-foreground",
  crit: "text-warn-foreground",
  off: "text-muted-foreground/40",
} as const;

/** A limit in a table cell: a small ring and the percent beside it. */
function CellMeter({ percent, label, note }: { percent?: number; label: string; note?: string }) {
  const { language } = useI18n();
  if (percent === undefined) return <span className="text-muted-foreground">—</span>;
  const value = Math.max(0, Math.min(100, percent));
  const text = formatPercent(percentUsed(value), language);
  // The same bar as everywhere else (variant A): the figure on top, the bar under it.
  return (
    <div className="grid w-20 min-w-0 gap-1" title={note}>
      <span className={cn("text-xs leading-tight font-semibold tabular-nums", value >= 100 && "text-crit")}>{text}</span>
      <MiniMeter usedPercent={value} label={`${label} ${text}`} />
      {/* A model's own limit (Antigravity) says which model it is, under its bar. */}
      {note && <span className="block truncate text-2xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** The connections as icons, each in its state's colour, with what it is in its title. */
function ConnectionIcons({
  account,
  usage,
  waiting,
  extension,
  terminal,
}: {
  account: Account;
  usage: Parameters<typeof usageSignInStatus>[1];
  waiting: boolean;
  extension: ExtensionStatus | null | undefined;
  terminal?: TerminalStatus | null;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  // Codex and Antigravity have no Claude app, extension or terminal. Antigravity's own app is one
  // icon (in use, sign-in saved, or not saved); the gateway pool is the other.
  if (!isClaudeAccount(account)) {
    const inPool = account.auth?.loggedIn === true;
    const app = relay.data?.antigravity;
    const appState = account.provider === "antigravity" ? antigravityAccountState(app, account.id) : undefined;
    const items: { key: string; icon: LucideIcon; tone: keyof typeof toneText; title: string }[] = [
      ...(appState && appState !== "unavailable"
        ? [
            {
              key: "antigravity-app",
              icon: Monitor,
              tone: (appState === "current" || appState === "saved" ? "ok" : "warn") as keyof typeof toneText,
              title:
                appState === "current"
                  ? t("Antigravity uygulaması: bu hesapta açık", "Antigravity app: open on this account")
                  : appState === "saved"
                    ? t("Antigravity uygulaması: giriş kayıtlı", "Antigravity app: sign-in saved")
                    : appState === "waiting"
                      ? t("Antigravity uygulaması: giriş bekleniyor", "Antigravity app: waiting for the sign-in")
                      : t("Antigravity uygulaması: giriş kayıtlı değil", "Antigravity app: sign-in not saved"),
            },
          ]
        : []),
      {
        key: "gateway",
        icon: Network,
        tone: inPool ? "ok" : "off",
        title: !inPool
          ? t("Ağ geçidi: giriş yok", "Gateway: not signed in")
          : relay.desktop?.proxyStatus?.accounts.some((p) => p.id === account.id && p.active)
            ? t("Ağ geçidi: şu an bu hesabı kullanıyor", "Gateway: using this account now")
            : t("Ağ geçidi: havuzda", "Gateway: in the pool"),
      },
    ];
    return (
      <div className="flex items-center gap-2" data-slot="connection-icons" data-provider={account.provider}>
        {items.map(({ key, icon: Icon, tone, title }) => (
          <span key={key} role="img" title={title} aria-label={title} data-icon={key} className={cn("relative", toneText[tone])}>
            <Icon className="size-4" />
            {(tone === "warn" || tone === "crit") && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warn ring-2 ring-card" />
            )}
          </span>
        ))}
      </div>
    );
  }
  const signIn = usageSignInStatus(account, usage, waiting, t, relay.data?.diagnostics?.platform);
  const ext =
    extension &&
    extensionGuide(account, extension, relay.accounts, t, language, undefined, relay.data?.diagnostics?.platform);
  const term =
    terminal && terminal.mode !== "off" ? terminalGuide(account, terminal, t, language) : undefined;
  const items: { key: string; icon: LucideIcon; tone: keyof typeof toneText; title: string }[] = [
    {
      key: "desktop",
      icon: Monitor,
      tone: account.desktop ? "ok" : "off",
      title: t(
        `Claude uygulaması: ${account.desktop ? "kayıtlı" : "kayıtlı değil"}`,
        `Claude app: ${account.desktop ? "saved" : "not saved"}`,
      ),
    },
    {
      key: "usage",
      icon: Globe2,
      tone: signIn.tone,
      title: t(`Limit okuma girişi: ${signIn.label}`, `Usage sign-in: ${signIn.label}`),
    },
    ...(ext
      ? [
          {
            key: "extension",
            icon: AppWindow,
            tone: ext.tone,
            title: t(
              `Tarayıcı eklentisi (isteğe bağlı): ${ext.label}`,
              `Browser extension (optional): ${ext.label}`,
            ),
          },
        ]
      : []),
    ...(term
      ? [
          {
            key: "terminal",
            icon: SquareTerminal,
            tone: term.tone,
            title: t(
              `Terminal (isteğe bağlı): ${term.label}`,
              `Terminal (optional): ${term.label}`,
            ),
          },
        ]
      : []),
  ];
  return (
    <div className="flex items-center gap-2" data-slot="connection-icons">
      {items.map(({ key, icon: Icon, tone, title }) => {
        const step = tone === "warn" || tone === "crit";
        return (
          <span
            key={key}
            title={title}
            aria-label={title}
            role="img"
            data-step={step || undefined}
            className={cn("relative", toneText[tone])}
          >
            <Icon className="size-4" />
            {/* The dot marks a step to take; its title and label say which. */}
            {step && (
              <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-warn ring-2 ring-card" />
            )}
          </span>
        );
      })}
    </div>
  );
}

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
  const extension = useExtensionStatus({ check: true }).status;
  const terminal = useTerminalStatus({ check: true }).status;
  // An Antigravity row's switch or sign-in, confirmed under that row.
  const [antigravityAsk, setAntigravityAsk] = useState<AntigravityAsk>();
  const antigravityApp = data?.antigravity;
  const promptOn = (id: string) =>
    antigravityAsk
      ? antigravityAsk.accountId === id
      : antigravityApp?.busy
        ? antigravityApp.signInFor === id || (antigravityApp.busy === "switching" && antigravityApp.result?.accountId === id)
        : antigravityApp?.result?.accountId === id;
  const browserSteps = ["darwin", "preview", "linux"].includes(data?.diagnostics?.platform ?? "");
  const now = Date.now();
  return (
    <>
    <div className="overflow-hidden rounded-lg border bg-card">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("Hesap", "Account")}</TableHead>
          <TableHead>{t("Durum", "Status")}</TableHead>
          <TableHead>{t("5 saat", "5 hours")}</TableHead>
          {/* A narrow page drops the week; the account page and the Overview still show it. */}
          <TableHead className="@max-3xl:hidden">{t("Hafta", "Week")}</TableHead>
          <TableHead>{t("Bağlantılar", "Connections")}</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">{t("İşlemler", "Actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((a) => {
          const inWindows = windowAccounts(relay.data);
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
          const actions = rowActions(a, relay, t, link, { remove, edit, language, now });
          // The inline fix is the matching ⋯ menu item: same label, same handler.
          const fix = health.fix && actions.find((x) => x.key === health.fix);
          // "Limit verisi eski" is the one warning without a fix: a refresh is its step.
          const stale =
            !waiting && !health.fix && !!usage && (usage.stale || usage.status === "error");
          const refresh = stale && actions.find((x) => x.key === "refresh");
          const suggested = relay.suggestion?.id === a.id;
          // An account in its own window is not switched to from here.
          const switchTo =
            suggested &&
            !inWindows.has(a.id) &&
            actions.find((x) => x.key === "switch");
          // An Antigravity account's limits are its pools: each column shows the fullest pool of that
          // length, named. Windows of unknown length (an older reading) show the fullest in the first.
          const pooled = modelOnlyUsage(usage);
          const byPeriod = pooled ? fullestByPeriod(usage, now) : {};
          const head = pooled ? (byPeriod.five_hour ?? (byPeriod.seven_day ? undefined : limitHeadline(usage, now))) : undefined;
          const weekHead = byPeriod.seven_day;
          const five = pooled ? head?.usedPercent : usage?.fiveHour?.usedPercent;
          const week = pooled ? weekHead?.usedPercent : usage?.sevenDay?.usedPercent;
          return (
            <TableRow
              key={a.id}
              tabIndex={0}
              data-state={selected === a.id ? "selected" : undefined}
              className="cursor-pointer"
              onClick={() => open(a.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  open(a.id);
                }
              }}
            >
              <TableCell className="max-w-0 w-[38%]">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold",
                      avatarClass[a.color] ?? "bg-muted text-muted-foreground",
                    )}
                  >
                    {a.name.slice(0, 1).toLocaleUpperCase(language)}
                  </span>
                  {/* The name has its own line so badges never cut it; provider, plan and e-mail go under it. */}
                  <div className="grid min-w-0 gap-0.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-semibold" title={a.name}>{a.name}</span>
                      {inWindows.has(a.id) && (
                        <WindowBadge t={t} compact />
                      )}
                      {suggested && (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-2xs font-semibold text-accent-foreground">
                          {t("önerilen", "suggested")}
                        </span>
                      )}
                    </div>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <ProviderBadge provider={a.provider} className="shrink-0 px-1.5" />
                      {plan && (
                        <Badge
                          variant="secondary"
                          // A long plan ("Google AI Ultra") narrows and is cut, never spills into the next column.
                          className="block min-w-0 max-w-full shrink overflow-hidden px-1.5 text-2xs text-ellipsis"
                          title={planTitle(a, plan, t)}
                        >
                          {plan.label}
                        </Badge>
                      )}
                      <span className="min-w-0 truncate">
                        {a.desktop?.email ?? a.auth?.email ? (
                          <Private>{a.desktop?.email ?? a.auth?.email}</Private>
                        ) : (
                          t("Henüz giriş yok", "No sign-in yet")
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span
                    title={health.detail}
                    className="inline-flex items-center gap-1.5"
                  >
                    <StatusDot tone={health.tone} />
                    {health.label}
                  </span>
                  {a.provider === "antigravity" && (
                    // The row opens the account; its button only asks.
                    <span className="contents" onClick={(e) => e.stopPropagation()}>
                      <AntigravityAction account={a} onAsk={setAntigravityAsk} />
                    </span>
                  )}
                  {a.provider === "antigravity" && promptOn(a.id) && (
                    <div className="basis-full" onClick={(e) => e.stopPropagation()}>
                      <AntigravityPrompt ask={antigravityAsk} onClose={() => setAntigravityAsk(undefined)} now={now} size="sm" />
                    </div>
                  )}
                  {stale && usage?.checkedAt && (
                    <span
                      data-slot="data-age"
                      className="shrink-0 rounded-full border px-1.5 py-px text-2xs text-muted-foreground"
                    >
                      {t(
                        `${formatRelative(usage.checkedAt, now, language)} okundu`,
                        `Read ${formatRelative(usage.checkedAt, now, language)}`,
                      )}
                    </span>
                  )}
                  {refresh && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`${t("Yenile", "Refresh")} · ${a.name}`}
                      title={refresh.label}
                      disabled={refresh.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        refresh.run();
                      }}
                    >
                      {t("Yenile", "Refresh")}
                    </Button>
                  )}
                  {/* The suggested account's switch is the ⋯ menu's own: the same review, the same prank after it. */}
                  {switchTo && !(health.tone !== "ok" && fix) && (
                    <Button
                      size="xs"
                      aria-label={`${switchTo.label} · ${a.name}`}
                      disabled={switchTo.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        itemHandlers(switchTo, prank).onClick?.(e);
                      }}
                    >
                      {switchTo.label}
                    </Button>
                  )}
                  {health.tone !== "ok" && fix && (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`${fix.label} · ${a.name}`}
                      disabled={fix.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        fix.run();
                      }}
                    >
                      {fix.label}
                    </Button>
                  )}
                </div>
              </TableCell>
              <TableCell>
                <CellMeter percent={five} label={head?.label ?? t("5 saat", "5 hours")} note={head?.label} />
              </TableCell>
              <TableCell className="@max-3xl:hidden">
                <CellMeter percent={week} label={weekHead?.label ?? t("Hafta", "Week")} note={weekHead?.label} />
              </TableCell>
              <TableCell>
                <ConnectionIcons
                  account={a}
                  usage={usage}
                  waiting={waiting}
                  extension={browserSteps ? extension : null}
                  terminal={browserSteps ? terminal : null}
                />
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t(`${a.name} işlemleri`, `${a.name} actions`)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  {/* Portaled, but React events still bubble to the row. */}
                  <DropdownMenuContent
                    align="end"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <RowActionItems actions={actions} prank={prank} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
    <ConnectionLegend />
    </>
  );
}

/** What each connection icon is, and what its colours and dot mean, under the table. */
function ConnectionLegend() {
  const { t } = useI18n();
  const icons: [LucideIcon, string][] = [
    // The Claude app for a Claude account, the Antigravity app for an Antigravity one.
    [Monitor, t("Uygulama", "App")],
    [Globe2, t("Limit okuma girişi", "Usage sign-in")],
    [AppWindow, t("Eklenti (isteğe bağlı)", "Extension (optional)")],
    [SquareTerminal, t("Terminal (isteğe bağlı)", "Terminal (optional)")],
    [Network, t("Ağ geçidi", "Gateway")],
  ];
  return (
    <p
      data-slot="connection-legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-2xs text-muted-foreground"
    >
      {icons.map(([Icon, name]) => (
        <span key={name} className="inline-flex items-center gap-1">
          <Icon aria-hidden="true" className="size-3" />
          {name}
        </span>
      ))}
      <span aria-hidden="true" className="text-muted-foreground/40">
        |
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" />
        {t("hazır", "ready")}
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="relative size-1.5 rounded-full bg-warn">
          <span className="absolute -top-1 -right-1 size-1 rounded-full bg-warn ring-1 ring-background" />
        </span>
        {t("adım gerekiyor", "step needed")}
      </span>
      <span className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground/40" />
        {t("yok", "none")}
      </span>
    </p>
  );
}
