import { useEffect, useState } from "react";
import type { Account, AccountPlanning } from "../shared/types";
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
  return (
    <div className="plan-editor">
      <select
        aria-label={t(`${account.name} planı`, `${account.name} plan`)}
        value={current.plan}
        disabled={disabled}
        onChange={(e) =>
          update({
            ...current,
            plan: e.target.value as AccountPlanning["plan"],
          })
        }
      >
        <option value="unknown">{t("Plan seç", "Choose plan")}</option>
        <option value="pro">Pro · 1×</option>
        <option value="max5">Max · 5×</option>
        <option value="max20">Max · 20×</option>
        <option value="team">Team / Enterprise</option>
      </select>
      {(current.plan === "unknown" || current.plan === "team") && (
        <label className="capacity-input">
          {t("Göreli kapasite", "Relative capacity")}
          <input
            aria-label={t(
              `${account.name} göreli kapasitesi`,
              `${account.name} relative capacity`,
            )}
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
        </label>
      )}
    </div>
  );
}
