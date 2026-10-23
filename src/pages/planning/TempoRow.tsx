import type { Account, TempoChoice } from "../../../shared/types";
import type { Tempo } from "../../../shared/tempo";
import { planCapacity } from "../../../shared/planning";
import { formatDuration, windowMinutes } from "@/lib/window-duration";
import { planLabel } from "../accounts/accountLabels";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type T = (tr: string, en: string) => string;

const noteClass = "text-xs text-muted-foreground";
const CHOICES: { value: TempoChoice; tr: string; en: string }[] = [
  { value: "auto", tr: "Otomatik", en: "Automatic" },
  { value: "light", tr: "Hafif", en: "Light" },
  { value: "medium", tr: "Orta", en: "Medium" },
  { value: "heavy", tr: "Yoğun", en: "Heavy" },
];

/** Plan name in the window line: "Team · 2" for Team, "3×" for an unchosen plan. */
function windowLabel(account: Account) {
  const capacity = planCapacity(account);
  return account.planning?.plan === "team"
    ? `Team · ${capacity}`
    : (planLabel(account) ?? `${capacity}×`);
}

/**
 * The hours card's tempo row: learned automatically or fixed, what the plan
 * assumes, and how long one window of each planned kind lasts at that pace.
 */
export function TempoRow({
  tempo,
  choice,
  rate,
  weekend,
  accounts,
  disabled,
  onChange,
  t,
}: {
  tempo: Tempo;
  choice: TempoChoice;
  /** The busy-day rate of the next work day, which measures the windows. */
  rate: number;
  /** Whether that day is a weekend day. */
  weekend: boolean;
  /** The planned accounts. */
  accounts: Account[];
  disabled: boolean;
  onChange: (choice: TempoChoice) => void;
  t: T;
}) {
  const n = new Intl.NumberFormat(t("tr-TR", "en-GB"), {
    maximumFractionDigits: 0,
  }).format(rate);
  const days = tempo.days.weekday + tempo.days.weekend;
  const summary =
    tempo.source === "learned"
      ? weekend && tempo.rate.weekend !== tempo.rate.weekday
        ? t(
            `Hafta sonu yoğun gün ≈ ${n} Pro birimi/sa · son 4 haftada ${days} iş günü`,
            `Busy weekend day ≈ ${n} Pro units/h · ${days} work ${days === 1 ? "day" : "days"} in the last 4 weeks`,
          )
        : t(
            `Yoğun gün ≈ ${n} Pro birimi/sa · son 4 haftada ${days} iş günü`,
            `Busy day ≈ ${n} Pro units/h · ${days} work ${days === 1 ? "day" : "days"} in the last 4 weeks`,
          )
      : tempo.source === "preset"
        ? t(
            `Sabit tempo ≈ ${n} Pro birimi/sa`,
            `Fixed tempo ≈ ${n} Pro units/h`,
          )
        : t(
            "Orta (varsayılan) ≈ 50 Pro birimi/sa · veri birikiyor",
            "Medium (default) ≈ 50 Pro units/h · collecting data",
          );
  // Each kind of plan once, largest first.
  const kinds = new Map<string, number>();
  for (const account of accounts) {
    const label = windowLabel(account);
    if (!kinds.has(label)) kinds.set(label, planCapacity(account));
  }
  const parts = [...kinds]
    .sort((x, y) => y[1] - x[1])
    .flatMap(([label, capacity]) => {
      const minutes = windowMinutes(capacity, rate);
      return minutes === undefined
        ? []
        : [`${label} ${formatDuration(minutes, t)}`];
    });
  return (
    <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-t py-2.5 first:border-t-0 @xl:grid-cols-[2rem_120px_minmax(0,1fr)]">
      {/* Keeps the label in line with the hour rows' labels after their switch. */}
      <span aria-hidden="true" />
      <span className="grid min-w-0">
        <strong className="text-sm font-semibold">{t("Tempo", "Tempo")}</strong>
        <small className={noteClass}>
          {t("ne hızla tüketiyorsun", "how fast you use quota")}
        </small>
      </span>
      <div className="col-span-full grid min-w-0 justify-items-start gap-1.5 @xl:col-span-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={t("Tempo", "Tempo")}
          value={choice}
          disabled={disabled}
          onValueChange={(v) => v && onChange(v as TempoChoice)}
        >
          {CHOICES.map((c) => (
            <ToggleGroupItem key={c.value} value={c.value}>
              {t(c.tr, c.en)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[13px]">{summary}</p>
        {parts.length > 0 && (
          <p className={noteClass}>
            {t("Bu tempoyla bir dönem: ", "At this tempo one period lasts: ") +
              parts.join(" · ") +
              t(" yeter.", ".")}
          </p>
        )}
      </div>
    </div>
  );
}
