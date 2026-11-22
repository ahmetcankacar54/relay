import type { Account, TempoChoice } from "../../../shared/types";
import type { Tempo } from "../../../shared/tempo";
import { planCapacity } from "../../../shared/planning";
import { formatDuration, windowMinutes } from "@/lib/window-duration";
import { planLabel } from "../accounts/accountLabels";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MessageId, T } from "../../../shared/i18n/translate";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";
import { useI18n } from "@/data/i18n";


const noteClass = "text-xs text-muted-foreground";
const CHOICES: { value: TempoChoice; label: MessageId }[] = [
  { value: "auto", label: "tempoRow.automatic" },
  { value: "light", label: "tempoRow.light" },
  { value: "medium", label: "tempoRow.medium" },
  { value: "heavy", label: "tempoRow.heavy" },
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
  const { language } = useI18n();
  const n = new Intl.NumberFormat(FORMAT_LOCALE[language], {
    maximumFractionDigits: 0,
  }).format(rate);
  const days = tempo.days.weekday + tempo.days.weekend;
  const weekendRate = weekend && tempo.rate.weekend !== tempo.rate.weekday;
  // The words show; the rate in Pro units, which means little at a glance, is in the title.
  const [summary, detail] =
    tempo.source === "learned"
      ? weekendRate
        ? [
            t("tempoRow.busyWeekendDayFromWorkDays", { days }),
            t("tempoRow.busyWeekendDayProUnitsH", { n, days }),
          ]
        : [
            t("tempoRow.busyDayFromWorkDaysIn", { days }),
            t("tempoRow.busyDayProUnitsHFrom", { n, days }),
          ]
      : tempo.source === "preset"
        ? [
            t("tempoRow.fixedTempo"),
            t("tempoRow.fixedTempoProUnitsH", { n }),
          ]
        : [
            t("tempoRow.mediumTempoUntilThereIsEnough"),
            t("tempoRow.mediumTempo50ProUnitsH"),
          ];
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
        <strong className="text-sm font-semibold">{t("tempoRow.tempo")}</strong>
        <small className={noteClass}>
          {t("tempoRow.howFastYouUseQuota")}
        </small>
      </span>
      <div className="col-span-full grid min-w-0 justify-items-start gap-1.5 @xl:col-span-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label={t("tempoRow.tempo")}
          value={choice}
          disabled={disabled}
          onValueChange={(v) => v && onChange(v as TempoChoice)}
        >
          {CHOICES.map((c) => (
            <ToggleGroupItem key={c.value} value={c.value}>
              {t(c.label)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-sm" title={detail}>
          {summary}
        </p>
        {parts.length > 0 && (
          <p className={noteClass}>
            {t("tempoRow.atThisTempoOnePeriodLasts", { parts: parts.join(", ") })}
          </p>
        )}
      </div>
    </div>
  );
}
