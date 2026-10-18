import type { ComponentType } from "react";
import {
  ArrowLeftRight,
  BarChart3,
  CalendarClock,
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
import { LimitMeter } from "@/components/LimitMeter";
import type { T } from "@/data/i18n";
import type { sidebarStatus } from "@/data/selectors";
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
  /** App icon URL; injected by the shell so this module stays importable under Node. */
  icon?: string;
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
        "relative flex w-full items-center justify-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] font-medium whitespace-nowrap text-muted-foreground hover:bg-card/60 [-webkit-app-region:no-drag]",
        compact && "justify-center px-2",
        active &&
          "bg-card font-semibold text-accent-foreground shadow-xs hover:bg-card",
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      {!compact && <span className="truncate">{item.label}</span>}
      {!compact && item.tail !== undefined && (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
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

export function Sidebar({
  page,
  go,
  t,
  compact,
  status,
  summary,
  icon,
}: SidebarProps) {
  const items: Item[] = [
    { id: "genel", icon: LayoutDashboard, label: t("Genel bakış", "Overview") },
    {
      id: "hesaplar",
      icon: Users,
      label: t("Hesaplar", "Accounts"),
      tail: status.accounts,
    },
    { id: "kullanim", icon: BarChart3, label: t("Kullanım", "Usage") },
    {
      id: "planlama",
      icon: CalendarClock,
      label: t("Planlama", "Planning"),
      on: status.planning,
      onLabel: t("Otomatik planlama açık", "Automatic planning on"),
    },
    {
      id: "gecis",
      icon: ArrowLeftRight,
      label: t("Geçiş", "Switching"),
      on: status.switching,
      onLabel: t("Otomatik geçiş açık", "Automatic switching on"),
    },
  ];
  const settings: Item = {
    id: "ayarlar",
    icon: Settings2,
    label: t("Ayarlar", "Settings"),
  };
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r bg-sidebar pb-3 text-sidebar-foreground",
        compact ? "w-14 items-center px-1.5" : "w-[200px] px-2.5",
      )}
    >
      <div className="h-10 w-full shrink-0 [-webkit-app-region:drag]" />
      <div
        className={cn(
          "mb-4 flex items-center gap-2 font-display text-[15px] font-bold",
          compact ? "justify-center" : "px-1.5",
        )}
      >
        {icon ? (
          <img src={icon} alt="" className="size-6 rounded-md" />
        ) : (
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center rounded-md bg-brand text-xs text-white"
          >
            R
          </span>
        )}
        {!compact && "Relay"}
      </div>
      <nav
        aria-label={t("Sayfalar", "Pages")}
        className="flex w-full flex-col gap-0.5"
      >
        {items.map((item) => (
          <NavItem
            key={item.id}
            item={item}
            active={page === item.id}
            compact={compact}
            go={go}
          />
        ))}
      </nav>
      <div className="flex-1" />
      {summary && !compact && (
        <div className="mb-2 w-full rounded-lg border bg-card p-2.5 text-xs [-webkit-app-region:no-drag]">
          <button
            type="button"
            onClick={() => go("genel")}
            className="flex w-full flex-col items-start justify-start gap-0.5 rounded-md text-left whitespace-normal"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <StatusDot tone={summary.running ? "ok" : "off"} />
              <b className="truncate font-semibold">{summary.name}</b>
            </span>
            <span className="text-muted-foreground">
              {summary.running
                ? t("Claude uygulamasında açık", "Open in the Claude app")
                : t("Claude uygulaması kapalı", "Claude app closed")}
            </span>
          </button>
          <div className="mt-1.5">
            <LimitMeter
              label={t("5 saatlik dönem", "5-hour period")}
              percent={summary.fiveHour}
              size="sm"
            />
          </div>
        </div>
      )}
      <div className="w-full">
        <NavItem
          item={settings}
          active={page === "ayarlar"}
          compact={compact}
          go={go}
        />
      </div>
    </aside>
  );
}
