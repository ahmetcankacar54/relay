import {
  ArrowLeftRight,
  ArrowUpRight,
  Globe2,
  Monitor,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import type { Account } from "../../../shared/types";
import { cliNeedsReconnect } from "../../../shared/account-state";
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
import { cn } from "@/lib/utils";
import { avatarClass, planLabel } from "./accountLabels";

const percent = (value?: number) =>
  value === undefined ? "—" : `%${Math.round(value)}`;

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
  const { t, language } = useI18n();
  const { api, data, desktop, active, busy, desktopBusy, pendingDesktop } =
    relay;
  const switchBlocked =
    desktopBusy || !!pendingDesktop || !!desktop?.recoveryRequired;
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t("Hesap", "Account")}</TableHead>
          <TableHead>{t("Plan", "Plan")}</TableHead>
          <TableHead>Desktop</TableHead>
          <TableHead className="hidden md:table-cell">
            {t("Limit bağlantısı", "Usage connection")}
          </TableHead>
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
          const desktopState =
            isActive && desktop?.running
              ? { tone: "ok" as const, label: t("Açık", "Running") }
              : a.desktop
                ? { tone: "ok" as const, label: t("Kayıtlı", "Saved") }
                : { tone: "off" as const, label: t("Bağlı değil", "Not linked") };
          const usageState = waiting
            ? {
                tone: "warn" as const,
                label: t("Tarayıcı onayı bekleniyor", "Waiting for browser approval"),
              }
            : !a.auth
              ? { tone: "off" as const, label: "—" }
              : cliNeedsReconnect(a, usage)
                ? { tone: "crit" as const, label: t("Süresi doldu", "Expired") }
                : { tone: "ok" as const, label: t("Bağlı", "Connected") };
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
                <Badge variant={plan ? "secondary" : "outline"}>
                  {plan ?? t("Plan seç", "Choose plan")}
                </Badge>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={desktopState.tone} />
                  {desktopState.label}
                </span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot tone={usageState.tone} />
                  {usageState.label}
                </span>
              </TableCell>
              <TableCell className="tabular-nums">
                {five === undefined && week === undefined
                  ? "—"
                  : `${percent(five)} · ${percent(week)}`}
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
                    {!isActive && a.desktop && (
                      <DropdownMenuItem
                        disabled={switchBlocked}
                        onSelect={() => relay.requestDesktop(a, "switch")}
                      >
                        <ArrowLeftRight />
                        {t("Geçiş yap", "Switch")}
                      </DropdownMenuItem>
                    )}
                    {isActive && (
                      <DropdownMenuItem
                        disabled={desktopBusy}
                        onSelect={() =>
                          void relay.action(`open:${a.id}`, () =>
                            api.openDesktop(),
                          )
                        }
                      >
                        <ArrowUpRight />
                        {t("Claude’u aç", "Open Claude")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      disabled={!!busy || waiting}
                      onSelect={() => void relay.startCli(a)}
                    >
                      <Globe2 />
                      {t("Girişi yenile", "Reconnect")}
                    </DropdownMenuItem>
                    {a.desktop ? (
                      <DropdownMenuItem
                        disabled={desktopBusy || !!pendingDesktop}
                        onSelect={() => relay.requestDesktop(a, "reconnect")}
                      >
                        <Monitor />
                        {t("Desktop girişini yenile…", "Reconnect Desktop…")}
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        disabled={
                          desktopBusy ||
                          !desktop?.available ||
                          !!pendingDesktop ||
                          !!desktop?.recoveryRequired
                        }
                        onSelect={() => link(a.id)}
                      >
                        <Monitor />
                        {t("Desktop'a bağla", "Link to Desktop")}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={relay.usageBusy.has(a.id)}
                      onSelect={() => void relay.refreshUsage(a)}
                    >
                      <RefreshCw />
                      {t("Limitleri yenile", "Refresh limits")}
                    </DropdownMenuItem>
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
