import { useContext, type MouseEvent, type ReactNode } from "react";
import { AccountDot } from "@/components/AccountDot";
import { LimitLine, NoLimitLine } from "@/components/LimitLine";
import { ListIndentContext, ListOpen } from "@/components/ListCard";
import { cn } from "@/lib/utils";
import type { T } from "@/data/i18n";

/*
 * An account in a list, in two lines, the way usage trackers lay a limit out: the account's name and
 * plan have line one to themselves with the actions at its end; line two is a quiet note on the left
 * (its status, "in use", an email) and its two limits on the right, each labelled, with its figure and
 * reset. Nothing shares a narrow column, so nothing is cut in half. Below 42rem the limits take a line
 * of their own, full width. The Accounts page, the Overview's board and the gateway's pool use it.
 */

const INDENT = ["ps-4", "ps-9", "ps-14"] as const;
const stop = (e: MouseEvent) => e.stopPropagation();

export function AccountRow({
  color,
  name,
  onOpen,
  tags,
  meta,
  limits,
  actions,
  lead,
  selected,
  quiet,
  title,
  data,
}: {
  color?: string;
  name: string;
  /** Opens the account's page: a click anywhere on the row, or its name with the keyboard. */
  onOpen?: () => void;
  /** Beside the name: its plan, a provider mark, a separate-window badge. */
  tags?: ReactNode;
  /** Line two, left: the status, "in use", an email. */
  meta?: ReactNode;
  /** Line two, right: the two limits (`RowLimits`). */
  limits?: ReactNode;
  /** Line one, right: a step to take and the menu. */
  actions?: ReactNode;
  /** A column before everything (the pool's order arrows). */
  lead?: ReactNode;
  selected?: boolean;
  /** Out of play (out of the pool): faded, still readable. */
  quiet?: boolean;
  title?: string;
  data?: Record<`data-${string}`, string>;
}) {
  const level = useContext(ListIndentContext);
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      {...data}
      onClick={onOpen}
      className={cn(
        "grid items-center gap-x-6 gap-y-1.5 border-b py-2.5 pe-4 last:border-b-0",
        lead ? "grid-cols-[auto_minmax(0,1fr)_auto]" : "grid-cols-[minmax(0,1fr)_auto]",
        INDENT[Math.min(level, 2)],
        onOpen &&
          "cursor-pointer transition-colors hover:bg-foreground/3 has-[[data-list-nav]:focus-visible]:bg-foreground/5 data-[selected=true]:bg-foreground/5",
      )}
    >
      {lead && (
        <div className="row-span-2 -ms-1 self-center @max-2xl:row-span-3" onClick={stop}>
          {lead}
        </div>
      )}
      <div className={cn("flex min-w-0 items-center gap-2", quiet && "opacity-60")} title={title}>
        <AccountDot color={color} />
        {onOpen ? (
          <ListOpen onOpen={onOpen} title={name}>
            {name}
          </ListOpen>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold" title={name}>
            {name}
          </span>
        )}
        {tags}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
        {actions}
      </div>
      <div className={cn("flex min-w-0 items-center gap-1.5 ps-4 text-xs text-muted-foreground @max-2xl:col-span-2", quiet && "opacity-60")}>
        {meta}
      </div>
      <div
        data-slot="row-limits"
        className={cn(
          "grid w-[clamp(15rem,44cqw,26rem)] grid-cols-2 gap-x-4 @max-2xl:col-span-2 @max-2xl:w-auto @max-2xl:ps-4",
          quiet && "opacity-60",
        )}
      >
        {limits}
      </div>
    </div>
  );
}

/** A small tag beside an account's name: its plan ("Max 5×", "Team"). */
export function RowTag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-medium text-muted-foreground" title={title}>
      {children}
    </span>
  );
}

type Window = { usedPercent: number; resetsAt?: string; label?: string } | undefined;

/**
 * The row's two limits, labelled "5 hours" and "Week". A pooled provider (Antigravity) names its pool
 * in the tooltip, not the label, so the figures keep their room.
 */
export function RowLimits({
  five,
  week,
  pooled,
  faded,
  now,
  t,
}: {
  five: Window;
  week: Window;
  pooled?: boolean;
  faded?: boolean;
  now: number;
  t: T;
}) {
  const one = (window: Window, label: string, period: "five_hour" | "seven_day") =>
    window ? (
      <LimitLine
        label={label}
        hint={pooled ? window.label : undefined}
        ariaLabel={pooled && window.label ? `${label} · ${window.label}` : label}
        usedPercent={window.usedPercent}
        resetsAt={window.resetsAt}
        period={pooled ? undefined : period}
        now={now}
        t={t}
        faded={faded}
      />
    ) : (
      <NoLimitLine label={label} />
    );
  return (
    <>
      {one(five, t("common.n5Hours"), "five_hour")}
      {one(week, t("common.week"), "seven_day")}
    </>
  );
}
