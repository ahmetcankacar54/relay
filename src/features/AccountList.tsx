import type { MouseEvent, ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { UsageRing } from "@/components/UsageRing";
import { useI18n } from "@/data/i18n";
import { ringState } from "@/lib/account-row";
import type { OverviewRow } from "@/data/selectors";
import { formatPercent, formatUsed, percentUsed } from "@/lib/meter";
import { cn } from "@/lib/utils";

/**
 * Other accounts as a grouped list (direction A): each row a small two-ring gauge (five hours
 * thick, the week thin), the name with a "suggested" tag, one status line and, in the app, the two
 * percents. A ring whose reading is old is faded on a dashed track, and without a reading only the
 * dashed track is drawn (`ringState`). In the menu bar panel the whole row is the switch (`pick`)
 * and the suggested row shows "Switch"; in the app the row opens the account (`href`) and every
 * account that can be switched to now has its own "Switch" button, filled for the suggested one and
 * quiet for the rest. An account whose limit is full can still be switched to: its "Switch" is
 * tinted amber and says when it opens (`warn`). A row that cannot be switched to ends in a chevron.
 */
export function AccountList({
  rows,
  now,
  line,
  title,
  selected,
  switching,
  blocked,
  warn,
  pick,
  href,
  variant = "app",
  footer,
  canSwitch,
}: {
  rows: OverviewRow[];
  now: number;
  /** The status line under the name. */
  line: (row: OverviewRow) => string;
  /** The full status, for the row's tooltip. */
  title?: (row: OverviewRow) => string;
  /** The row whose switch is being confirmed. */
  selected?: string;
  /** The row whose switch is running. */
  switching?: string;
  /** Why a row cannot be switched to now; undefined when it can. */
  blocked?: (row: OverviewRow) => string | undefined;
  /** What to know before switching to a row that can be switched to (its limit is full). */
  warn?: (row: OverviewRow) => string | undefined;
  /** The switch (or, for an account without a Claude app sign-in, its setup). */
  pick: (row: OverviewRow, event: MouseEvent<HTMLElement>) => void;
  /** In the app: where the row leads (the account's page). */
  href?: (row: OverviewRow) => string;
  variant?: "panel" | "app";
  /** A last row, such as "Add account". */
  footer?: ReactNode;
  /** In the app: whether a row's action is a switch (false for an account without a Claude app sign-in). */
  canSwitch?: (row: OverviewRow) => boolean;
}) {
  const { t, language } = useI18n();
  const panel = variant === "panel";
  return (
    <div
      data-slot="account-list"
      className="overflow-hidden rounded-xl border bg-card"
    >
      {rows.map((row, i) => {
        const { account, usage } = row;
        const five = usage?.fiveHour?.usedPercent;
        const week = usage?.sevenDay?.usedPercent;
        const why = blocked?.(row);
        const busy = switching === account.id;
        const caution = why ? undefined : warn?.(row);
        const ring = ringState(usage, now);
        const said = [
          account.name,
          five === undefined ? undefined : t(`5 saat ${formatUsed(five, language)}`, `5 hours ${formatUsed(five, language)}`),
          week === undefined ? undefined : t(`hafta ${formatUsed(week, language)}`, `week ${formatUsed(week, language)}`),
          ring === "stale" ? t("limit verisi eski", "usage data is out of date") : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        const offer = (row.recommended || !!caution) && !why && !busy;
        // The app offers a switch on every account that can take one now; the panel row is the switch itself.
        const switchable = !why && !busy && (canSwitch?.(row) ?? true);
        const tooltip = [title?.(row) ?? line(row), why ?? caution].filter(Boolean).join(" · ");
        // Amber, never the suggested blue: switching there works, but the limit is used up.
        const tinted = "border border-warn/40 bg-warn/10 text-warn-foreground";
        const body = (
          <>
            <UsageRing outer={five} inner={week ?? null} size={panel ? 32 : 38} label={said} state={ring} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate font-semibold", panel ? "text-[13px]" : "text-[13.5px]")}>
                  {account.name}
                </span>
                {row.recommended && (
                  <span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[11px] font-semibold text-accent-foreground">
                    {t("önerilen", "suggested")}
                  </span>
                )}
              </span>
              <span className={cn("block truncate text-muted-foreground", panel ? "text-[11.5px]" : "text-xs")}>
                {busy ? t("Geçiliyor…", "Switching…") : line(row)}
              </span>
            </span>
            {!panel && (
              <span className="shrink-0 text-[12.5px] tabular-nums">
                <b className="font-semibold">{five === undefined ? "—" : formatPercent(percentUsed(five), language)}</b>
                <span className="text-muted-foreground">
                  {" / "}
                  {week === undefined ? "—" : formatPercent(percentUsed(week), language)}
                </span>
              </span>
            )}
          </>
        );
        const trailing = busy ? (
          <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : offer ? undefined : (
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
        );
        const rowClass = cn(
          "flex min-w-0 items-center gap-3 text-left outline-none",
          panel ? "px-3 py-2" : "px-4 py-3",
          row.recommended && "bg-accent/40",
          selected === account.id && "bg-accent/60",
          why && "opacity-60",
        );
        return (
          <div
            key={account.id}
            data-slot="account-row"
            className={cn("relative", i > 0 && "border-t")}
          >
            {href ? (
              <div className={rowClass}>
                <a
                  href={href(row)}
                  title={tooltip}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-inherit no-underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {body}
                </a>
                {switchable ? (
                  <button
                    type="button"
                    disabled={!!switching}
                    aria-label={
                      caution
                        ? t(`${account.name} hesabına geç · ${caution}`, `Switch to ${account.name} · ${caution}`)
                        : t(`${account.name} hesabına geç`, `Switch to ${account.name}`)
                    }
                    title={caution}
                    onClick={(e) => pick(row, e)}
                    className={cn(
                      "h-7 shrink-0 rounded-md px-3 text-xs font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
                      caution
                        ? `${tinted} hover:bg-warn/20`
                        : row.recommended
                          ? "bg-primary text-primary-foreground hover:bg-primary/90"
                          : "border bg-card text-foreground hover:bg-muted",
                    )}
                  >
                    {t("Geç", "Switch")}
                  </button>
                ) : (
                  trailing
                )}
              </div>
            ) : (
              <button
                type="button"
                aria-pressed={selected === account.id}
                aria-label={
                  why
                    ? `${said} · ${why}`
                    : t(`${account.name} hesabına geç · ${said}`, `Switch to ${account.name} · ${said}`) +
                      (caution ? ` · ${caution}` : "")
                }
                title={tooltip}
                disabled={!!switching}
                onClick={(e) => pick(row, e)}
                className={cn(rowClass, "w-full hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50 disabled:pointer-events-none")}
              >
                {body}
                {offer ? (
                  <span
                    className={cn(
                      "shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold",
                      caution ? tinted : "bg-primary text-primary-foreground",
                    )}
                  >
                    {t("Geç", "Switch")}
                  </span>
                ) : (
                  trailing
                )}
              </button>
            )}
          </div>
        );
      })}
      {footer && <div className="border-t">{footer}</div>}
    </div>
  );
}
