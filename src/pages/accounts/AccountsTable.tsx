import { Fragment, type MouseEvent } from "react";
import {
  AppWindow,
  ArrowLeftRight,
  type LucideIcon,
  ArrowUpRight,
  Globe2,
  KeyRound,
  Monitor,
  MoreHorizontal,
  RefreshCw,
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
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { pendingFlow } from "@/data/selectors";
import { offerAfter, usePrank, type PrankApi } from "@/pranks/PrankStage";
import { cn } from "@/lib/utils";
import {
  accountHealth,
  renewalIssue,
  usageSignInStatus,
} from "@/lib/account-health";
import { extensionGuide } from "@/lib/extension-ui";
import { formatPercent, percentUsed } from "@/lib/meter";
import { UsageRing } from "@/components/UsageRing";
import { useExtensionStatus } from "@/data/useExtension";
import type { ExtensionStatus } from "../../../shared/types";
import { avatarClass, planColumn } from "./accountLabels";

const toneText = {
  ok: "text-ok",
  warn: "text-warn",
  crit: "text-crit",
  off: "text-muted-foreground/40",
} as const;

/** A limit in a table cell: a small ring and the percent beside it. */
function CellMeter({ percent, label }: { percent?: number; label: string }) {
  const { language } = useI18n();
  if (percent === undefined) return <span className="text-muted-foreground">—</span>;
  const value = Math.max(0, Math.min(100, percent));
  const text = formatPercent(percentUsed(value), language);
  return (
    <div className="flex items-center gap-2">
      <UsageRing outer={value} size={22} label={`${label} ${text}`} />
      <span className="text-xs font-semibold tabular-nums">{text}</span>
    </div>
  );
}

/** The three connections as icons, each in its state's colour, with what it is in its title. */
function ConnectionIcons({
  account,
  usage,
  waiting,
  extension,
}: {
  account: Account;
  usage: Parameters<typeof usageSignInStatus>[1];
  waiting: boolean;
  extension: ExtensionStatus | null | undefined;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const signIn = usageSignInStatus(account, usage, waiting, t);
  const ext =
    extension && extensionGuide(account, extension, relay.accounts, t, language);
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
      title: t(`Limit okuma: ${signIn.label}`, `Usage limits: ${signIn.label}`),
    },
    ...(ext
      ? [
          {
            key: "extension",
            icon: AppWindow,
            tone: ext.tone,
            title: t(`Tarayıcı eklentisi: ${ext.label}`, `Browser extension: ${ext.label}`),
          },
        ]
      : []),
  ];
  return (
    <div className="flex items-center gap-2" data-slot="connection-icons">
      {items.map(({ key, icon: Icon, tone, title }) => (
        <span key={key} title={title} aria-label={title} role="img" className={toneText[tone]}>
          <Icon className="size-4" />
        </span>
      ))}
    </div>
  );
}

export interface RowAction {
  key:
    | "switch"
    | "open"
    | "cli"
    | "renew"
    | "desktop-reconnect"
    | "desktop-link"
    | "refresh";
  label: string;
  icon: LucideIcon;
  disabled: boolean;
  run: () => void;
}

/** Menu items for an account row, in display order. Pure so it can be tested. */
export function rowActions(
  a: Account,
  relay: Relay,
  t: (tr: string, en: string) => string,
  link: (id: string) => void = () => {},
): RowAction[] {
  const { desktop, desktopBusy, pendingDesktop } = relay;
  const isActive = a.id === relay.active?.id;
  const switchBlocked =
    desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired;
  const authFlow = relay.data?.authFlows.find((f) => f.accountId === a.id);
  const items: RowAction[] = [];
  if (a.desktop && !isActive)
    items.push({
      key: "switch",
      label: t("Geç", "Switch"),
      icon: ArrowLeftRight,
      disabled: switchBlocked,
      run: () => relay.requestDesktop(a, "switch"),
    });
  if (a.desktop && isActive)
    items.push({
      key: "open",
      label: t("Claude uygulamasını aç", "Open the Claude app"),
      icon: ArrowUpRight,
      disabled: switchBlocked,
      run: () =>
        void relay.action(`open:${a.id}`, () => relay.api.openDesktop()),
    });
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
  if (renewal)
    items.push({
      key: "renew",
      label:
        renewal === "keychain-locked"
          ? t("Anahtarlık erişimine izin ver", "Allow Keychain access")
          : t("Yenilemeye izin ver", "Allow renewal"),
      icon: KeyRound,
      disabled: relay.usageBusy.has(a.id),
      run: () => void relay.refreshUsage(a, true),
    });
  items.push(
    a.desktop
      ? {
          key: "desktop-reconnect",
          label: t(
            "Claude uygulaması girişini yenile…",
            "Renew Claude app sign-in…",
          ),
          icon: Monitor,
          disabled: desktopBusy || !!pendingDesktop,
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
  return items;
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
}: {
  accounts: Account[];
  selected?: string;
  /** Opens the detail sheet for an account. */
  open: (id: string) => void;
  /** Starts Desktop setup for an account that has no saved Desktop sign-in. */
  link: (id: string) => void;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { data, desktop, active } = relay;
  // Opening the list also checks the extension, so an account signed in to it gets linked.
  const extension = useExtensionStatus({ check: true }).status;
  const macOS = ["darwin", "preview"].includes(data?.diagnostics?.platform ?? "");
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("Hesap", "Account")}</TableHead>
          <TableHead>{t("Durum", "Status")}</TableHead>
          <TableHead>{t("5 saat", "5 hours")}</TableHead>
          <TableHead>{t("Hafta", "Week")}</TableHead>
          <TableHead>{t("Bağlantılar", "Connections")}</TableHead>
          <TableHead className="w-10">
            <span className="sr-only">{t("İşlemler", "Actions")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((a) => {
          const isActive = a.id === active?.id;
          const usage = data?.usage[a.id];
          const authFlow = data?.authFlows.find((f) => f.accountId === a.id);
          const waiting = pendingFlow(authFlow);
          const plan = planColumn(a);
          const health = accountHealth(
            a,
            usage,
            { active: isActive, desktopRunning: !!desktop?.running, waiting },
            t,
          );
          const actions = rowActions(a, relay, t, link);
          // The inline fix is the matching ⋯ menu item: same label, same handler.
          const fix = health.fix && actions.find((x) => x.key === health.fix);
          const five = usage?.fiveHour?.usedPercent;
          const week = usage?.sevenDay?.usedPercent;
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
              <TableCell className="max-w-0 w-[34%]">
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
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-semibold">{a.name}</span>
                      {plan && (
                        <Badge
                          variant="secondary"
                          className="shrink-0 px-1.5 text-[11px]"
                          title={
                            plan.source === "planning"
                              ? undefined
                              : t(
                                  "Abonelik · planlama için plan seçilmedi",
                                  "Subscription · no plan picked for planning",
                                )
                          }
                        >
                          {plan.label}
                        </Badge>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.desktop?.email ??
                        a.auth?.email ??
                        t("Henüz hesap bağlanmadı", "No account connected yet")}
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
                <CellMeter percent={five} label={t("5 saat", "5 hours")} />
              </TableCell>
              <TableCell>
                <CellMeter percent={week} label={t("Hafta", "Week")} />
              </TableCell>
              <TableCell>
                <ConnectionIcons
                  account={a}
                  usage={usage}
                  waiting={waiting}
                  extension={macOS ? extension : null}
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
                    {actions.map(
                      ({ key, label, icon: Icon, disabled, run }) => (
                        <Fragment key={key}>
                          {key === "refresh" && <DropdownMenuSeparator />}
                          <DropdownMenuItem
                            disabled={disabled}
                            {...itemHandlers({ key, disabled, run }, prank)}
                          >
                            <Icon />
                            {label}
                          </DropdownMenuItem>
                        </Fragment>
                      ),
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
    </div>
  );
}
