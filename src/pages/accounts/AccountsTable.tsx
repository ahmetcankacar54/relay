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
import { accountPlan, accountProvider, planTitle } from "./accountLabels";
import { groupAccounts, sectionCount, type AccountGroupBy, type AccountSection, type AccountSort } from "./accountGroups";
import { isClaudeAccount } from "@/lib/account-health";
import { limitColumns } from "../../../shared/quota-windows";
import { freshUsage } from "../../../shared/usage";
import { AccountRow, RowLimits, RowTag } from "@/components/AccountRow";
import { ListCard, ListGroup, ListNote, ListSection } from "@/components/ListCard";
import { ProviderLogo } from "@/components/ProviderLogo";
import { StatusLabel } from "@/components/StatusLabel";
import { relayProviders } from "@/features/Providers";
import { accountStatus } from "@/lib/account-status";
import { inUseIds } from "@/lib/provider-view";
import type { T } from "../../../shared/i18n/translate";

/**
 * Says an account runs in its own Claude window, beside the main Claude. `compact`, in the table,
 * shows the icon alone, so a narrow row keeps the account's name.
 */
export function WindowBadge({
  t,
  compact = false,
}: {
  t: T;
  compact?: boolean;
}) {
  const label = t("accountsTable.separateWindow");
  return (
    <Badge
      variant="outline"
      data-slot="window-badge"
      className={cn("shrink-0 gap-1 text-2xs", compact ? "px-1" : "px-1.5")}
      title={t("accountsTable.openInASeparateClaudeWindow")}
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
  t: T,
  language: Language,
  link: (id: string) => void = () => {},
  options: {
    /** Asks to remove the account (the confirmation dialog). */
    remove?: (id: string) => void;
    /** Opens the account's name, type and group for editing. */
    edit?: (id: string) => void;
    now?: number;
  } = {},
): RowAction[] {
  const { desktop, desktopBusy, pendingDesktop } = relay;
  const { now = Date.now() } = options;
  const isActive = a.id === relay.active?.id;
  const switchBlocked =
    desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired;
  const authFlow = relay.data?.authFlows.find((f) => f.accountId === a.id);
  // A full account can still be switched to; the item is tinted and says when it opens.
  const full = limitFull(relay.data?.usage[a.id], now);
  const windows = relay.data?.windows;
  // Its own window holds its sign-in: the main Claude cannot take it over until it closes.
  const inWindow = windowAccounts(relay.data).has(a.id);
  const windowNote = t("accountsTable.closeItsSeparateWindowFirst");
  const items: RowAction[] = [];
  // Codex and Antigravity accounts feed the gateway: the Claude app, its windows and Claude Code sign-in do not apply.
  const claude = isClaudeAccount(a);
  if (claude && a.desktop && !isActive)
    items.push({
      key: "switch",
      label: t("common.switch"),
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
              label: t("accountsTable.bringItsWindowForward"),
              icon: AppWindow,
              disabled: false,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.openWindow(a.id)),
            },
            {
              key: "window-close" as const,
              label: t("accountsTable.closeItsWindow"),
              icon: X,
              disabled: desktopBusy,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.closeWindow(a.id)),
            },
          ]
        : [
            {
              key: "window" as const,
              label: t("accountsTable.openInASeparateWindow"),
              icon: AppWindow,
              disabled: switchBlocked,
              run: () => void relay.action(`window:${a.id}`, () => relay.api.openWindow(a.id)),
            },
          ]),
    );
  if (claude && a.desktop && isActive)
    items.push({
      key: "open",
      label: t("accountsTable.openTheClaudeApp"),
      icon: ArrowUpRight,
      disabled: switchBlocked,
      run: () =>
        void relay.action(`open:${a.id}`, () => relay.api.openDesktop()),
    });
  if (claude)
    items.push({
      key: "cli",
      label: a.auth?.email
        ? t("common.renewUsageSignIn")
        : t("common.signInToReadUsage"),
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
          : t("common.allowRenewal"),
      icon: KeyRound,
      disabled: relay.usageBusy.has(a.id),
      run: () => void relay.refreshUsage(a, true),
    });
  if (claude)
    items.push(
    a.desktop
      ? {
          key: "desktop-reconnect",
          label: t("accountsTable.renewClaudeAppSignIn"),
          icon: Monitor,
          disabled: desktopBusy || !!pendingDesktop || inWindow,
          ...(inWindow && { note: windowNote }),
          run: () => relay.requestDesktop(a, "reconnect"),
        }
      : {
          key: "desktop-link",
          label: t("common.saveClaudeAppSignIn"),
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
    label: t("common.refreshLimits"),
    icon: RefreshCw,
    disabled: relay.usageBusy.has(a.id),
    run: () => void relay.refreshUsage(a),
  });
  if (options.edit)
    items.push({
      key: "edit",
      label: t("accountsTable.editNameAndType"),
      icon: Pencil,
      disabled: !!relay.busy,
      run: () => options.edit?.(a.id),
    });
  // Main refuses the same; the menu says why before it is chosen.
  const running = relay.data?.runs?.some(
    (r) => r.accountId === a.id && r.status === "running",
  );
  const removeBlock = isActive
    ? t("accountsTable.switchToAnotherAccountFirst")
    : inWindow
      ? t("accountsTable.closeItsSeparateWindowFirst")
      : pendingDesktop?.id === a.id
      ? t("accountsTable.finishOrCancelItsClaudeApp")
      : pendingFlow(authFlow)
        ? t("accountsTable.finishOrCancelItsUsageSign")
        : running
          ? t("accountsTable.stopItsActiveSessionFirst")
          : desktopBusy
            ? t("accountsTable.aClaudeAppActionIsIn")
            : undefined;
  items.push({
    key: "remove",
    label: t("accountsTable.removeAccount"),
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
  groupBy = "provider",
  sort = "default",
  collapsed = [],
  toggle,
  selected,
  open,
  link,
  remove,
  edit,
}: {
  accounts: Account[];
  groupBy?: AccountGroupBy;
  sort?: AccountSort;
  /** Keys of the sections whose rows are hidden under their header. */
  collapsed?: readonly string[];
  /** Opens or closes a section; without it the headers are not buttons. */
  toggle?: (key: string) => void;
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
  const sections = groupAccounts(accounts, { by: groupBy, sort, usage: data?.usage ?? {}, now, language, t });
  // Grouped by provider, the header names it; otherwise each row carries its provider's mark.
  const markRows = groupBy !== "provider";
  const row = (a: Account) => {
    const isActive = a.id === active?.id;
    const usage = data?.usage[a.id];
    const authFlow = data?.authFlows.find((f) => f.accountId === a.id);
    const waiting = pendingFlow(authFlow);
    const plan = accountPlan(a);
    const health = accountHealth(
      a,
      usage,
      { active: isActive, desktopRunning: !!desktop?.running, waiting, platform: data?.diagnostics?.platform, language },
      t,
    );
    const status = accountStatus({ account: a, usage, health, inUse: inUse.has(a.id), now, t });
    const actions = rowActions(a, relay, t, language, link, { remove, edit, now });
    // The one visible step: what fixes the account first, then a refresh of an old reading,
    // then the suggested switch. Everything else is in the ⋯ menu.
    const fix = health.tone !== "ok" && !health.limit && health.fix ? actions.find((x) => x.key === health.fix) : undefined;
    const stale = !waiting && !health.fix && !!usage && (usage.stale || usage.status === "error");
    const refresh = stale ? actions.find((x) => x.key === "refresh") : undefined;
    const suggested = relay.suggestion?.id === a.id;
    const switchTo = suggested && !inWindows.has(a.id) ? actions.find((x) => x.key === "switch") : undefined;
    const step = fix ?? refresh;
    // The two columns as every list fills them: Antigravity's from its pools (`limitColumns`).
    const { five, week, pooled } = limitColumns(usage, now);
    const faded = !!usage && !freshUsage(usage, now);
    const stop = (e: MouseEvent) => e.stopPropagation();
    // The one visible step, then the menu with every action.
    const actionsNode = (
      <>
        {a.provider === "antigravity" && !step ? (
          <AntigravityAction account={a} onAsk={setAntigravityAsk} primary={suggested} />
        ) : step ? (
          <Button size="xs" variant="outline" className="block min-w-0 max-w-full truncate leading-6" aria-label={`${step.label} · ${a.name}`} title={step.label} disabled={step.disabled} onClick={() => step.run()}>
            {step === refresh ? t("accountsTable.refresh") : shortFix(step.key, t) ?? step.label}
          </Button>
        ) : switchTo ? (
          <Button size="xs" className="block min-w-0 max-w-full truncate leading-6" title={t("common.switch")} aria-label={`${switchTo.label} · ${a.name}`} disabled={switchTo.disabled} onClick={(e) => itemHandlers(switchTo, prank).onClick?.(e)}>
            {t("common.switch")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("accountsTable.actions", { aName: a.name })}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          {/* Portaled, but React events still bubble to the row. */}
          <DropdownMenuContent align="end" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
            <RowActionItems actions={actions} prank={prank} />
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
    return (
      <Fragment key={a.id}>
        <AccountRow
          color={a.color}
          name={a.name}
          onOpen={() => open(a.id)}
          selected={selected === a.id}
          data={{ "data-account": a.id }}
          tags={
            <>
              {markRows && <ProviderLogo provider={accountProvider(a)} />}
              {plan && <RowTag title={planTitle(a, plan, t)}>{plan.short}</RowTag>}
              {inWindows.has(a.id) && <WindowBadge t={t} compact />}
            </>
          }
          meta={<StatusLabel status={status} />}
          limits={<RowLimits five={five} week={week} pooled={pooled} faded={faded} now={now} t={t} />}
          actions={actionsNode}
        />
        {a.provider === "antigravity" && promptOn(a.id) && (
          <ListNote>
            <AntigravityPrompt ask={antigravityAsk} onClose={() => setAntigravityAsk(undefined)} now={now} size="sm" />
          </ListNote>
        )}
      </Fragment>
    );
  };
  // A section is its header, then its rows (or its work groups) indented below it.
  const section = (s: AccountSection) => {
    const id = `accounts-${s.key}`;
    const shown = !collapsed.includes(s.key);
    return (
      <Fragment key={s.key}>
        <ListGroup
          provider={s.provider}
          name={s.label}
          count={sectionCount(s)}
          level={s.level}
          open={shown}
          onToggle={toggle && (() => toggle(s.key))}
          controls={toggle && id}
        />
        <ListSection id={id} level={s.level} label={s.label} hidden={!shown}>
          {s.accounts.map(row)}
          {s.children.map(section)}
        </ListSection>
      </Fragment>
    );
  };
  return (
    <ListCard label={t("common.accounts")} slot="accounts-list">
      {groupBy === "none" ? sections.flatMap((s) => s.accounts).map(row) : sections.map(section)}
    </ListCard>
  );
}

/** A fix's button in a narrow column: one or two words; the menu item keeps the full label. */
function shortFix(key: string, t: T): string | undefined {
  if (key === "desktop-link") return t("accountsTable.save");
  if (key === "cli") return t("common.connect");
  if (key === "renew") return t("accountsTable.renew");
  return undefined;
}
