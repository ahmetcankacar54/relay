import type { MouseEvent } from "react";
import { LoaderCircle } from "lucide-react";
import { UsageRing } from "@/components/UsageRing";
import { useI18n } from "@/data/i18n";
import type { OverviewRow } from "@/data/selectors";
import { formatPercent, formatUsed, percentUsed } from "@/lib/meter";
import { cn } from "@/lib/utils";

/**
 * Accounts as tiles: each a two-ring gauge (five hours outside, the week inside) with the
 * five-hour percent in the middle, the name and one short line. The whole tile is the switch, so
 * there is no button standing apart from what it acts on; the suggested account is outlined and
 * marked. Used by the menu bar panel (three across) and Overview (as many as fit).
 */
export function AccountTiles({
  rows,
  line,
  title,
  selected,
  switching,
  blocked,
  pick,
  variant = "app",
}: {
  rows: OverviewRow[];
  /** The short line under the name. */
  line: (row: OverviewRow) => string;
  /** The full line, for the tile's tooltip. */
  title?: (row: OverviewRow) => string;
  /** The tile whose switch is being confirmed. */
  selected?: string;
  /** The tile whose switch is running. */
  switching?: string;
  /** Why a tile cannot be picked now; undefined when it can. */
  blocked?: (row: OverviewRow) => string | undefined;
  pick: (row: OverviewRow, event: MouseEvent<HTMLButtonElement>) => void;
  variant?: "panel" | "app";
}) {
  const { t, language } = useI18n();
  const panel = variant === "panel";
  return (
    <div
      data-slot="account-tiles"
      className={cn(
        "grid gap-2 pt-2",
        panel ? "grid-cols-3" : "grid-cols-[repeat(auto-fill,minmax(136px,1fr))]",
      )}
    >
      {rows.map((row) => {
        const { account, usage } = row;
        const five = usage?.fiveHour?.usedPercent;
        const week = usage?.sevenDay?.usedPercent;
        const why = blocked?.(row);
        const busy = switching === account.id;
        const text = line(row);
        const said = [
          account.name,
          five === undefined ? undefined : t(`5 saat ${formatUsed(five, language)}`, `5 hours ${formatUsed(five, language)}`),
          week === undefined ? undefined : t(`hafta ${formatUsed(week, language)}`, `week ${formatUsed(week, language)}`),
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={account.id}
            type="button"
            data-slot="account-tile"
            aria-pressed={selected === account.id}
            aria-label={
              why
                ? `${said} · ${why}`
                : t(`${account.name} hesabına geç · ${said}`, `Switch to ${account.name} · ${said}`)
            }
            title={[title?.(row) ?? text, why].filter(Boolean).join(" · ")}
            disabled={!!switching}
            onClick={(e) => pick(row, e)}
            className={cn(
              "group relative grid min-w-0 justify-items-center gap-1 rounded-xl border bg-card text-center outline-none transition-colors",
              "hover:border-foreground/20 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none",
              panel ? "px-1.5 pt-2.5 pb-2" : "px-2 pt-3.5 pb-3",
              row.recommended && "border-brand/50 bg-brand/5",
              selected === account.id && "border-brand ring-2 ring-brand/25",
              why && "opacity-60",
            )}
          >
            {row.recommended && (
              <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-brand px-1.5 py-px text-[11px] leading-tight font-semibold whitespace-nowrap text-brand-foreground shadow-sm">
                {t("önerilen", "pick")}
              </span>
            )}
            <UsageRing outer={five} inner={week ?? null} size={panel ? 50 : 60} label={said}>
              {busy ? (
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <span className={cn("font-bold tabular-nums", panel ? "text-[12.5px]" : "text-sm")}>
                  {five === undefined ? "—" : formatPercent(percentUsed(five), language)}
                </span>
              )}
            </UsageRing>
            <span
              className={cn(
                "mt-0.5 w-full truncate font-semibold",
                panel ? "text-[12.5px]" : "text-sm",
              )}
            >
              {account.name}
            </span>
            <span className="w-full truncate text-[11.5px] text-muted-foreground">
              {busy ? t("Geçiliyor…", "Switching…") : text}
            </span>
          </button>
        );
      })}
    </div>
  );
}
