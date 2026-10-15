import type { PlanningSettings } from "../../../shared/types";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type T = (tr: string, en: string) => string;

// The page has one adapt row.
const NOTE_ID = "planning-adaptive-note";

/**
 * The hours card's adapt row, under the tempo: re-plan the rest of the day
 * at today's pace. It works through automatic start, so it rests while that
 * is off.
 */
export function AdaptiveRow({
  settings,
  disabled,
  update,
  t,
}: {
  settings: PlanningSettings;
  disabled: boolean;
  update: (patch: Partial<PlanningSettings>) => void;
  t: T;
}) {
  const label = t("Uyarla", "Adapt");
  const on = settings.adaptive !== false;
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 border-t py-2.5 first:border-t-0">
      <Switch
        checked={on}
        disabled={disabled || !settings.autoStart}
        aria-label={label}
        aria-describedby={NOTE_ID}
        onCheckedChange={(adaptive) => update({ adaptive })}
      />
      <span className="grid min-w-0">
        <strong
          className={cn(
            "text-sm font-semibold",
            !on && "text-muted-foreground",
          )}
        >
          {label}
        </strong>
        <small id={NOTE_ID} className="text-xs text-muted-foreground">
          {t(
            "Gün içinde hızına göre planı güncelle",
            "Update the plan for today’s pace",
          )}
        </small>
      </span>
    </div>
  );
}
