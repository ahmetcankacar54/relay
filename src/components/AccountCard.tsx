import type { MouseEvent, ReactNode } from "react";
import { AccountDot } from "@/components/AccountDot";
import { LimitLine, NoLimitLine } from "@/components/LimitLine";
import { ListOpen } from "@/components/ListCard";
import { cn } from "@/lib/utils";
import type { T } from "@/data/i18n";

/*
 * An account as a card, the way usage trackers show one: its name and plan on top with its status (or
 * "in use", an email) under them and the actions in the corner; below, each limit at the card's full
 * width, labelled, with its figure and reset. Nothing shares a narrow column, so nothing is cut in half.
 * Cards sit in a `ListCard layout="cards"` grid: one a line in a narrow window, two from 42rem, three
 * from 64rem. The Accounts page, the Overview's board and the gateway's pool use it.
 */

const stop = (e: MouseEvent) => e.stopPropagation();

export function AccountCard({
  color,
  name,
  onOpen,
  tags,
  meta,
  limits,
  action,
  menu,
  selected,
  quiet,
  title,
  data,
}: {
  color?: string;
  name: string;
  /** Opens the account's page: a click anywhere on the card, or its name with the keyboard. */
  onOpen?: () => void;
  /** Beside the name: its plan, a provider mark, a separate-window badge. */
  tags?: ReactNode;
  /** Under the name: the status, "in use", an email. */
  meta?: ReactNode;
  /** The two limits (`AccountLimits`), or a note when there are none. */
  limits?: ReactNode;
  /** Beside the status: the one step to take (Switch, Save, Refresh; the pool's order). */
  action?: ReactNode;
  /** The top corner, small: the ⋯ menu, the pool's switch. */
  menu?: ReactNode;
  selected?: boolean;
  /** Out of play (out of the pool): faded, still readable. */
  quiet?: boolean;
  title?: string;
  data?: Record<`data-${string}`, string>;
}) {
  return (
    <div
      data-slot="list-row"
      data-selected={selected || undefined}
      {...data}
      onClick={onOpen}
      className={cn(
        "grid min-w-0 content-start gap-3 rounded-lg border bg-card p-3.5",
        onOpen &&
          "cursor-pointer transition-colors hover:bg-foreground/3 has-[[data-list-nav]:focus-visible]:ring-[3px] has-[[data-list-nav]:focus-visible]:ring-ring/50 data-[selected=true]:border-ring",
      )}
    >
      {/*
       * Line one is the name and its tags with only the small menu beside it; the step to take sits on
       * line two beside the status, so a button never squeezes the name.
       */}
      <div className="grid min-w-0 gap-1">
        <div className="flex min-h-7 min-w-0 items-center gap-2">
          {/* The name gives way last: a work-group tag beside it narrows first. */}
          <div className={cn("flex min-w-0 flex-1 items-center gap-2 [&>[data-list-nav]]:shrink-[0.001]", quiet && "opacity-60")} title={title}>
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
          {menu && (
            <div className="-me-1.5 flex shrink-0 items-center gap-1" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
              {menu}
            </div>
          )}
        </div>
        {(meta || action) && (
          <div className="flex min-h-6 min-w-0 items-center gap-2 ps-4">
            <div className={cn("flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground", quiet && "opacity-60")}>{meta}</div>
            {action && (
              <div className="flex shrink-0 items-center gap-1" onClick={stop} onKeyDown={(e) => e.stopPropagation()}>
                {action}
              </div>
            )}
          </div>
        )}
      </div>
      <div data-slot="row-limits" className={cn("grid gap-2.5", quiet && "opacity-60")}>
        {limits}
      </div>
    </div>
  );
}

/** A small tag beside an account's name: its plan ("Max 5×", "Team"). */
export function AccountTag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="shrink-0 rounded-sm bg-secondary px-1.5 py-px text-2xs font-medium text-muted-foreground" title={title}>
      {children}
    </span>
  );
}

type Window = { usedPercent: number; resetsAt?: string; label?: string } | undefined;

/**
 * The card's two limits, labelled "5 hours" and "Week". A pooled provider (Antigravity) names its pool
 * in the tooltip, not the label, so the figures keep their room.
 */
export function AccountLimits({
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
