import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Account, AccountPlanning } from "../../shared/types";
type T = (tr: string, en: string) => string;
export function PlanEditor({
  account,
  disabled,
  update,
  t,
}: {
  account: Account;
  disabled: boolean;
  update: (input: AccountPlanning) => void;
  t: T;
}) {
  const current = account.planning ?? { plan: "unknown", capacityWeight: 1 };
  const [weight, setWeight] = useState(String(current.capacityWeight));
  useEffect(
    () => setWeight(String(current.capacityWeight)),
    [current.capacityWeight],
  );
  const plans: { value: AccountPlanning["plan"]; label: string }[] = [
    { value: "unknown", label: t("Plan seç", "Select plan") },
    { value: "pro", label: "Pro · 1×" },
    { value: "max5", label: "Max · 5×" },
    { value: "max20", label: "Max · 20×" },
    { value: "team", label: "Team / Enterprise" },
  ];
  const capacityId = `capacity-${account.id}`;
  return (
    <div className="grid min-w-0 gap-1.5">
      <Select
        value={current.plan}
        disabled={disabled}
        onValueChange={(plan) =>
          update({ ...current, plan: plan as AccountPlanning["plan"] })
        }
      >
        <SelectTrigger
          aria-label={t(`${account.name} planı`, `${account.name} plan`)}
          className="w-full"
        >
          {/* Children keep the label in static markup, before Radix measures items. */}
          <SelectValue>
            {plans.find((p) => p.value === current.plan)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {plans.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(current.plan === "unknown" || current.plan === "team") && (
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={capacityId}
            className="block text-xs text-muted-foreground"
          >
            {t("Göreli kapasite", "Relative capacity")}
          </label>
          <Input
            id={capacityId}
            aria-label={t(
              `${account.name} göreli kapasitesi`,
              `${account.name} relative capacity`,
            )}
            className="h-8 w-16 px-2 tabular-nums"
            type="number"
            min={1}
            max={100}
            step={1}
            value={weight}
            disabled={disabled}
            onChange={(e) => setWeight(e.target.value)}
            onBlur={() => {
              const n = Number(weight);
              if (Number.isFinite(n) && n >= 1 && n <= 100) {
                if (n !== current.capacityWeight)
                  update({ ...current, capacityWeight: n });
              } else setWeight(String(current.capacityWeight));
            }}
          />
        </div>
      )}
    </div>
  );
}
