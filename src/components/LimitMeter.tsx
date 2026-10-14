import { useContext } from "react";
import { cn } from "@/lib/utils";
import { formatPercent, meterClass, meterTone } from "@/lib/meter";
import { I18nContext } from "@/data/i18n";
export function LimitMeter({
  label,
  percent,
  detail,
  size = "md",
}: {
  label: string;
  percent?: number;
  detail?: string;
  size?: "sm" | "md";
}) {
  // Read the context directly: the sidebar renders this without a provider in tests.
  const language = useContext(I18nContext)?.language ?? "tr";
  const value =
    percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <b
          className={cn(
            "tabular-nums text-foreground",
            size === "md" ? "text-sm" : "text-xs",
          )}
        >
          {formatPercent(value, language)}
        </b>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className={cn(
          "mt-1 overflow-hidden rounded-full bg-track",
          size === "md" ? "h-1.5" : "h-1",
        )}
      >
        <div
          className={cn("h-full rounded-full", meterClass[meterTone(value)])}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      {detail && (
        <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}
