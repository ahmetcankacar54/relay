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
import {
  accountPlan,
  accountProvider,
  detectedClaudePlan,
  type AccountPlanInfo,
} from "../pages/accounts/accountLabels";
type T = (tr: string, en: string) => string;

/** A plan Relay read from the account: shown, never asked. */
function ReadPlan({ plan, t }: { plan?: AccountPlanInfo; t: T }) {
  if (!plan)
    return (
      <p data-slot="plan" className="text-sm text-muted-foreground">
        {t("Plan henüz okunmadı", "Plan not read yet")}
      </p>
    );
  return (
    <div data-slot="plan" className="flex items-center justify-between gap-2 text-sm">
      <span className="min-w-0 truncate">
        Plan: <span className="font-medium">{plan.label}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {t("algılandı", "detected")}
      </span>
    </div>
  );
}

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
  // Codex and Antigravity name their own plan (ChatGPT Plus, Google AI Pro); Claude's plans and
  // its relative capacity do not apply to them.
  if (accountProvider(account) !== "claude")
    return <ReadPlan plan={accountPlan(account)} t={t} />;
  const plans: { value: AccountPlanning["plan"]; label: string }[] = [
    { value: "unknown", label: t("Plan seç", "Select plan") },
    { value: "pro", label: "Pro · 1×" },
    { value: "max5", label: "Max · 5×" },
    { value: "max20", label: "Max · 20×" },
    { value: "team", label: "Team / Enterprise" },
  ];
  const capacityId = `capacity-${account.id}`;
  // A plan read from the sign-in is not a choice: it is shown, and follows the account.
  const detected = detectedClaudePlan(account);
  return (
    <div className="grid min-w-0 gap-1.5">
      {detected ? (
        <ReadPlan plan={accountPlan(account)} t={t} />
      ) : (
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
      )}
      {((detected ?? current.plan) === "unknown" || (detected ?? current.plan) === "team") && (
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
