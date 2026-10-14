import { cn } from "@/lib/utils";
import { meterClass, meterTone } from "@/lib/meter";
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
          {value === undefined ? "—" : `%${Math.round(value)}`}
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
