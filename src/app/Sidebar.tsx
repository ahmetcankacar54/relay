import {
  Fragment,
  useContext,
  useRef,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  AccountsIcon,
  OverviewIcon,
  PinsIcon,
  PlanningIcon,
  ProxyIcon,
  SettingsIcon,
  SidebarIcon,
  SwitchingIcon,
  TokensIcon,
  UsageIcon,
} from "@/components/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusDot } from "@/components/StatusDot";
import { MiniMeter } from "@/components/LimitLine";
import { formatPercent, formatUsed, percentUsed } from "@/lib/meter";
import { timeLeft } from "@/lib/account-row";
import type { Locale, T } from "@/data/i18n";
import { RelayContext } from "@/data/relay-context";
import { macWording } from "@/data/platform";
import { type sidebarStatus } from "@/data/selectors";
import type { PageId } from "./routes";
import { SidebarUpdate } from "./SidebarUpdate";
import { SIDEBAR, dragSidebar, keySidebar, type SidebarSize } from "./useSidebarSize";

/** `sidebarStatus`, where the gateway's fields may be left out (a window without a gateway, the tests). */
type Status = Omit<ReturnType<typeof sidebarStatus>, "proxyRunning"> & { proxyRunning?: boolean };
export interface SidebarSummary {
  name: string;
  running: boolean;
  fiveHour?: number;
}
export interface SidebarProps {
  page: PageId;
  go(page: PageId): void;
  t: T;
  language: Locale;
  compact: boolean;
  status: Status;
  summary?: SidebarSummary;
  /** The panda over the account card (src/app/CardPanda.tsx); the shell draws it, the rail shows none. */
  panda?: ReactNode;
  /** A click in the sidebar, above the account card (the pages) or below it (Settings and the card itself). */
  onPoke?(where: "above" | "below"): void;
  /** The expanded width in px (src/app/useSidebarSize.ts). */
  width?: number;
  /** Folded into the icon rail by the user (a narrow window folds it too, through `compact`). */
  collapsed?: boolean;
  /** Moves the edge; without it the sidebar has no handle (a narrow window, the tests). */
  onResize?(size: SidebarSize, save?: boolean): void;
  /** Folds or unfolds the sidebar; without it there is no toggle button. */
  onToggle?(): void;
}

interface Item {
  id: PageId;
  icon: ComponentType<{ className?: string }>;
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
        "relative flex items-center rounded-md text-sm whitespace-nowrap text-sidebar-muted outline-none hover:bg-foreground/5 hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 [-webkit-app-region:no-drag]",
        compact
          ? "size-10 justify-center"
          : "h-8 w-full justify-start gap-2.5 px-2.5 text-left",
        active && "bg-sidebar-accent text-sidebar-foreground hover:bg-sidebar-accent",
      )}
    >
      <Icon className={cn("size-5 shrink-0", active && "text-primary")} />
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
            compact ? "absolute top-2 right-2" : "ml-auto",
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

/**
 * The sidebar's edge: drag it to set the width, past `SIDEBAR.collapseBelow` to fold it into the
 * rail; double-click for the initial width. With the keyboard: ←/→ move it 16 px (⇧ 48 px), → opens
 * the rail and ← at the narrowest width folds it.
 */
function ResizeHandle({
  width,
  collapsed,
  onResize,
  t,
}: {
  width: number;
  collapsed: boolean;
  onResize(size: SidebarSize, save?: boolean): void;
  t: T;
}) {
  // Where the drag started, and the expanded width to keep if it ends folded.
  const start = useRef<{ x: number; width: number; expanded: number }>(undefined);
  const shown = collapsed ? SIDEBAR.rail : width;
  const move = (e: PointerEvent<HTMLDivElement>, save: boolean) => {
    if (!start.current) return;
    onResize(dragSidebar(start.current.width, e.clientX - start.current.x, start.current.expanded), save);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const direction = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!direction) return;
    e.preventDefault();
    onResize(keySidebar({ width, collapsed }, direction, e.shiftKey ? 48 : 16));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("sidebar.sidebarWidth")}
      aria-valuemin={SIDEBAR.rail}
      aria-valuemax={SIDEBAR.max}
      aria-valuenow={shown}
      tabIndex={0}
      className="group/handle absolute inset-y-0 -right-1 z-30 w-2 cursor-col-resize outline-none [-webkit-app-region:no-drag] focus-visible:bg-ring/30"
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: shown, expanded: width };
      }}
      onPointerMove={(e) => move(e, false)}
      onPointerUp={(e) => {
        move(e, true);
        start.current = undefined;
      }}
      onPointerCancel={() => (start.current = undefined)}
      onDoubleClick={() => onResize({ width: SIDEBAR.initial, collapsed: false })}
      onKeyDown={key}
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover/handle:bg-ring/60 group-active/handle:bg-ring" />
    </div>
  );
}

export function Sidebar({
  page,
  go,
  t,
  language,
  compact,
  status,
  summary,
  panda,
  onPoke,
  width = SIDEBAR.initial,
  collapsed = false,
  onResize,
  onToggle,
}: SidebarProps) {
  const goFrom = (where: "above" | "below") => (page: PageId) => {
    onPoke?.(where);
    go(page);
  };
  // Read here rather than passed in, so the shell's props stay as they are; tests may render without it.
  const relay = useContext(RelayContext);
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
    { id: "genel", icon: OverviewIcon, label: t("sidebar.overview") },
    {
      id: "hesaplar",
      icon: AccountsIcon,
      label: t("common.accounts"),
      tail: status.accounts,
    },
    // A green dot says the page's automation runs by itself.
    {
      id: "gecis",
      icon: SwitchingIcon,
      label: t("common.switching"),
      on: status.switching,
      onLabel: t("sidebar.automaticSwitchingOn"),
    },
    {
      id: "planlama",
      icon: PlanningIcon,
      label: t("sidebar.planning"),
      on: status.planning,
      onLabel: t("sidebar.earlyStartOn"),
    },
  ];
  // After the usage pages, so ⌘3–⌘5 still open them as before the gateway had a page.
  const proxy: Item = {
    id: "proxy",
    icon: ProxyIcon,
    label: t("sidebar.proxyGateway"),
    on: status.proxyRunning,
    onLabel: status.proxyAddress
      ? t("sidebar.gatewayRunning", { statusProxyAddress: status.proxyAddress })
      : t("sidebar.gatewayRunning2"),
  };
  // Usage is three pages, grouped under one heading.
  const usage: Item[] = [
    { id: "kullanim", icon: UsageIcon, label: t("sidebar.limitHistory") },
    { id: "tokenlar", icon: TokensIcon, label: t("sidebar.tokensAndCost") },
    { id: "rozetler", icon: PinsIcon, label: t("sidebar.pins") },
  ];
  const settings: Item = {
    id: "ayarlar",
    icon: SettingsIcon,
    label: t("common.settings"),
  };

  const toggleLabel = compact
    ? t("sidebar.showTheSidebar")
    : t("sidebar.hideTheSidebar");
  const toggle = onToggle && (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={toggleLabel}
      // ⌃⌘S is the macOS menu's shortcut; elsewhere the button has none.
      title={macWording(relay?.data?.diagnostics?.platform) ? `${toggleLabel} (⌃⌘S)` : toggleLabel}
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="text-sidebar-muted [-webkit-app-region:no-drag] hover:text-sidebar-foreground"
    >
      <SidebarIcon className="size-4.5" />
    </Button>
  );
  return (
    <aside
      className={cn(
        "relative flex h-full shrink-0 flex-col pb-2 text-sidebar-foreground select-none",
        compact ? "w-21 items-center px-2" : "px-2.5",
      )}
      style={compact ? undefined : { width }}
    >
      {/* The traffic lights sit in this strip, which also drags the window; the toggle sits beside them. */}
      <div className="relative h-13 w-full shrink-0 [-webkit-app-region:drag]">
        {!compact && toggle && <div className="absolute top-2.75 left-17.5">{toggle}</div>}
      </div>
      <nav
        aria-label={t("sidebar.pages")}
        className={cn("flex min-h-0 w-full flex-col gap-0.5", compact && "items-center")}
      >
        {compact && toggle && <div className="mb-1">{toggle}</div>}
        {items.map((item) => (
          <Fragment key={item.id}>
            <NavItem
              item={item}
              active={page === item.id}
              compact={compact}
              go={goFrom("above")}
            />
          </Fragment>
        ))}
        <div
          role="group"
          aria-labelledby={compact ? undefined : "sidebar-usage"}
          aria-label={compact ? t("sidebar.usage") : undefined}
          className={cn(
            "flex w-full flex-col gap-0.5",
            compact ? "mt-2 items-center border-t pt-2" : "mt-4",
          )}
        >
          {!compact && (
            <h2 id="sidebar-usage" className="px-2.5 pb-1 text-xs font-medium text-sidebar-muted">
              {t("sidebar.usage")}
            </h2>
          )}
          {usage.map((item) => (
            <NavItem
              key={item.id}
              item={item}
              active={page === item.id}
              compact={compact}
              go={goFrom("above")}
            />
          ))}
        </div>
        <div className={cn("w-full", compact ? "mt-2 flex justify-center border-t pt-2" : "mt-4")}>
          <NavItem item={proxy} active={page === "proxy"} compact={compact} go={goFrom("above")} />
        </div>
      </nav>
      <div className="flex-1" />
      {summary && !compact && (
        <div
          data-slot="account-card"
          className="relative mt-8 mb-1.5 w-full rounded-lg border bg-card/80 p-2.5 text-xs [-webkit-app-region:no-drag]"
        >
          {panda}
          <button
            type="button"
            onClick={() => goFrom("below")("genel")}
            className="flex w-full items-center gap-2.5 rounded-md text-left whitespace-normal"
          >
            <span className="grid min-w-0 flex-1 gap-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusDot tone={summary.running ? "ok" : "off"} />
                <b className="truncate font-semibold">{summary.name}</b>
              </span>
              <span className="truncate text-muted-foreground">
                {summary.fiveHour === undefined
                  ? summary.running
                    ? t("sidebar.openInClaude")
                    : t("common.claudeClosed")
                  : t("sidebar.fiveHourSummary", {
                      percent: formatPercent(percentUsed(summary.fiveHour), language),
                      hasLeft: left ? "yes" : "no",
                      left: left ?? "",
                      running: summary.running ? "yes" : "no",
                    })}
              </span>
              {/* The same bar as every limit in Relay: the active account's five hours. */}
              {summary.fiveHour !== undefined && (
                <MiniMeter
                  usedPercent={summary.fiveHour}
                  label={t("sidebar.n5HourPeriod", { used: formatUsed(summary.fiveHour, language) })}
                />
              )}
            </span>
          </button>
        </div>
      )}
      <SidebarUpdate compact={compact} t={t} language={language} />
      <div className={cn("w-full", compact && "flex justify-center")}>
        <NavItem
          item={settings}
          active={page === "ayarlar"}
          compact={compact}
          go={goFrom("below")}
        />
      </div>
      {onResize && (
        <ResizeHandle width={width} collapsed={collapsed} onResize={onResize} t={t} />
      )}
    </aside>
  );
}
