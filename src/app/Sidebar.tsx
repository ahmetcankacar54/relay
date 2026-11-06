import {
  Fragment,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  BarChart3,
  LayoutDashboard,
  Settings2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot } from "@/components/StatusDot";
import { UsageRing } from "@/components/UsageRing";
import { formatPercent, formatUsed, percentUsed } from "@/lib/meter";
import { accountHealth } from "@/lib/account-health";
import { timeLeft } from "@/lib/account-row";
import type { T } from "@/data/i18n";
import { RelayContext, type Relay } from "@/data/relay-context";
import { pendingFlow, type sidebarStatus } from "@/data/selectors";
import { accountFromHash, accountHash } from "@/pages/accounts/AccountDetail";
import type { PageId } from "./routes";

type Status = ReturnType<typeof sidebarStatus>;
export interface SidebarSummary {
  name: string;
  running: boolean;
  fiveHour?: number;
}
export interface SidebarProps {
  page: PageId;
  go(page: PageId): void;
  t: T;
  compact: boolean;
  status: Status;
  summary?: SidebarSummary;
  /** The panda over the account card (src/app/CardPanda.tsx); the shell draws it, the rail shows none. */
  panda?: ReactNode;
  /** A click in the sidebar, above the account card (the pages) or below it (Settings and the card itself). */
  onPoke?(where: "above" | "below"): void;
}

interface Item {
  id: PageId;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  tail?: number;
  on?: boolean;
  /** What the green dot means, for screen readers: the dot alone speaks only through colour. */
  onLabel?: string;
}

function NavItem({
  item,
  active,
  compact,
  go,
}: {
  item: Item;
  active: boolean;
  compact: boolean;
  go(page: PageId): void;
}) {
  const Icon = item.icon;
  const button = (
    <button
      type="button"
      onClick={() => go(item.id)}
      aria-current={active ? "page" : undefined}
      aria-label={
        compact
          ? item.on && item.onLabel
            ? `${item.label} · ${item.onLabel}`
            : item.label
          : undefined
      }
      className={cn(
        "relative flex h-7 w-full items-center justify-start gap-2 rounded-md px-2 text-left text-sm whitespace-nowrap text-sidebar-foreground [-webkit-app-region:no-drag]",
        compact && "h-8 justify-center px-2",
        active && "bg-sidebar-accent",
      )}
    >
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />
      {!compact && <span className="truncate">{item.label}</span>}
      {!compact && item.tail !== undefined && (
        <span className="ml-auto text-xs tabular-nums text-sidebar-muted">
          {item.tail}
        </span>
      )}
      {item.on && (
        <span
          data-status="on"
          className={cn(
            "flex",
            compact ? "absolute top-1.5 right-1.5" : "ml-auto",
          )}
        >
          <StatusDot tone="ok" />
          {item.onLabel && <span className="sr-only">{item.onLabel}</span>}
        </span>
      )}
    </button>
  );
  if (!compact) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

/** The account open on the Accounts page (`#/hesaplar/<id>`), following the hash. */
function useOpenAccount(): string | undefined {
  const read = () => accountFromHash(globalThis.window?.location?.hash ?? "");
  const [id, setId] = useState(read);
  useEffect(() => {
    const update = () => setId(read());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return id;
}

/**
 * The accounts under Hesaplar while the Accounts page or an account's page is open: each links to its
 * page with a dot, green when it is ready (or running) and grey otherwise; the open one is marked.
 */
function AccountLinks({
  relay,
  open,
  t,
  onPick,
}: {
  relay: Relay;
  open?: string;
  t: T;
  onPick(): void;
}) {
  return (
    <ul
      aria-label={t("Hesap listesi", "Account list")}
      className="ml-4 grid min-h-0 gap-px overflow-y-auto py-0.5 pl-2"
    >
      {relay.accounts.map((a) => {
        const health = accountHealth(
          a,
          relay.data?.usage[a.id],
          {
            active: a.id === relay.active?.id,
            desktopRunning: !!relay.desktop?.running,
            waiting: pendingFlow(
              relay.data?.authFlows.find((f) => f.accountId === a.id),
            ),
          },
          t,
        );
        const current = a.id === open;
        return (
          <li key={a.id} className="min-w-0">
            <a
              href={accountHash(a.id)}
              onClick={onPick}
              aria-current={current ? "true" : undefined}
              title={`${a.name} · ${health.label}`}
              className={cn(
                "flex h-6 min-w-0 items-center gap-2 rounded-md px-2 text-xs text-sidebar-muted [-webkit-app-region:no-drag]",
                current && "bg-sidebar-accent text-sidebar-foreground",
              )}
            >
              <StatusDot tone={health.tone === "ok" ? "ok" : "off"} />
              <span className="truncate">{a.name}</span>
              <span className="sr-only">{` · ${health.label}`}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function Sidebar({
  page,
  go,
  t,
  compact,
  status,
  summary,
  panda,
  onPoke,
}: SidebarProps) {
  const goFrom = (where: "above" | "below") => (page: PageId) => {
    onPoke?.(where);
    go(page);
  };
  // Read here rather than passed in, so the shell's props stay as they are; tests may render without it.
  const relay = useContext(RelayContext);
  const openAccount = useOpenAccount();
  const listAccounts = page === "hesaplar" && !compact && !!relay?.accounts.length;
  // The five-hour window's time left, as the Overview's rings say it.
  const left =
    summary?.fiveHour !== undefined && relay?.active
      ? timeLeft(
          relay.data?.usage[relay.active.id]?.fiveHour?.resetsAt,
          Date.now(),
          t,
        )
      : undefined;
  const items: Item[] = [
    { id: "genel", icon: LayoutDashboard, label: t("Genel bakış", "Overview") },
    {
      id: "hesaplar",
      icon: Users,
      label: t("Hesaplar", "Accounts"),
      tail: status.accounts,
    },
    { id: "kullanim", icon: BarChart3, label: t("Kullanım", "Usage") },
  ];
  // Automation and planning live in Settings now; its dot says when either runs by itself.
  const settings: Item = {
    id: "ayarlar",
    icon: Settings2,
    label: t("Ayarlar", "Settings"),
    on: status.switching || status.planning,
    onLabel:
      status.switching && status.planning
        ? t("Otomatik geçiş ve önceden başlatma açık", "Automatic switching and early start on")
        : status.switching
          ? t("Otomatik geçiş açık", "Automatic switching on")
          : t("Önceden başlatma açık", "Early start on"),
  };
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-sidebar pb-2 text-sidebar-foreground select-none vibrant:border-foreground/10 vibrant:bg-transparent",
        compact ? "w-14 items-center px-1.5" : "w-50 px-2.5",
      )}
    >
      {/* The traffic lights sit in this strip, which also drags the window. */}
      <div className="h-13 w-full shrink-0 [-webkit-app-region:drag]" />
      <nav
        aria-label={t("Sayfalar", "Pages")}
        className="flex min-h-0 w-full flex-col gap-0.5"
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            <NavItem
              item={item}
              active={page === item.id}
              compact={compact}
              go={goFrom("above")}
            />
            {item.id === "hesaplar" && listAccounts && relay && (
              <AccountLinks
                relay={relay}
                open={openAccount}
                t={t}
                onPick={() => onPoke?.("above")}
              />
            )}
          </Fragment>
        ))}
      </nav>
      <div className="flex-1" />
      {summary && !compact && (
        <div
          data-slot="account-card"
          className="relative mt-8 mb-1.5 w-full rounded-lg border bg-card p-2 text-xs shadow-xs [-webkit-app-region:no-drag]"
        >
          {panda}
          <button
            type="button"
            onClick={() => goFrom("below")("genel")}
            className="flex w-full items-center gap-2.5 rounded-md text-left whitespace-normal"
          >
            <UsageRing
              outer={summary.fiveHour}
              size={28}
              label={
                summary.fiveHour === undefined
                  ? t("5 saatlik dönem bilinmiyor", "5-hour period unknown")
                  : t(`5 saatlik dönem ${formatUsed(summary.fiveHour, "tr")}`, `5-hour period ${formatUsed(summary.fiveHour, "en")}`)
              }
            />
            <span className="grid min-w-0 gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusDot tone={summary.running ? "ok" : "off"} />
                <b className="truncate font-semibold">{summary.name}</b>
              </span>
              <span className="truncate text-muted-foreground">
                {summary.fiveHour === undefined
                  ? summary.running
                    ? t("Claude’da açık", "Open in Claude")
                    : t("Claude kapalı", "Claude closed")
                  : t(
                      `${formatPercent(percentUsed(summary.fiveHour), "tr")}${left ? ` · ${left}` : ""}${summary.running ? "" : " · Claude kapalı"}`,
                      `${formatPercent(percentUsed(summary.fiveHour), "en")}${left ? ` · ${left}` : ""}${summary.running ? "" : " · Claude closed"}`,
                    )}
              </span>
            </span>
          </button>
        </div>
      )}
      <div className="w-full">
        <NavItem
          item={settings}
          active={page === "ayarlar"}
          compact={compact}
          go={goFrom("below")}
        />
      </div>
    </aside>
  );
}
