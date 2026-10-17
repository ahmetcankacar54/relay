import { Fragment, type MouseEvent } from "react";
import {
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
import { accountHealth, renewalIssue } from "@/lib/account-health";
import { formatPercent } from "@/lib/meter";
import { avatarClass, planLabel } from "./accountLabels";

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
      label: t("Geçiş yap", "Switch"),
      icon: ArrowLeftRight,
      disabled: switchBlocked,
      run: () => relay.requestDesktop(a, "switch"),
    });
  if (a.desktop && isActive)
    items.push({
      key: "open",
      label: t("Claude’u aç", "Open Claude"),
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
          : t("Bağlantıyı yenile", "Renew connection"),
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
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("Hesap", "Account")}</TableHead>
          <TableHead>{t("Plan", "Plan")}</TableHead>
          <TableHead>{t("Durum", "Status")}</TableHead>
          <TableHead>{t("5 sa · hafta", "5 h · week")}</TableHead>
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
          const plan = planLabel(a);
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
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{a.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {a.desktop?.email ??
                        a.auth?.email ??
                        t("Henüz hesap bağlanmadı", "No account connected yet")}
                    </div>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {plan ? (
                  <Badge variant="secondary">{plan}</Badge>
                ) : (
                  <span className="text-muted-foreground">
                    {t("Plan yok", "No plan")}
                  </span>
                )}
              </TableCell>
              <TableCell>
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
              <TableCell className="tabular-nums">
                {five === undefined && week === undefined
                  ? "—"
                  : `${formatPercent(five, language)} · ${formatPercent(week, language)}`}
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
  );
}
