import type { Account } from "../../../shared/types";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import { OptionSelect } from "@/components/SettingRow";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useI18n } from "@/data/i18n";

const RANGES: StatisticsRange[] = [7, 30, 90];
const ALL = "all";

/** Period (7/30/90 days) and account filter for the statistics. */
export function StatisticsHeader({
  range,
  onRange,
  accountId,
  onAccount,
  accounts,
}: {
  range: StatisticsRange;
  onRange: (range: StatisticsRange) => void;
  accountId?: string;
  onAccount: (accountId: string | undefined) => void;
  accounts: Account[];
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        aria-label={t("Dönem", "Period")}
        value={String(range)}
        onValueChange={(v) => v && onRange(Number(v) as StatisticsRange)}
      >
        {RANGES.map((n) => (
          <ToggleGroupItem key={n} value={String(n)}>
            {t(`${n} gün`, `${n} days`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <label htmlFor="usage-account" className="sr-only">
        {t("Hesap", "Account")}
      </label>
      <OptionSelect
        id="usage-account"
        value={accountId ?? ALL}
        options={[
          { value: ALL, label: t("Tüm hesaplar", "All accounts") },
          ...accounts.map((a) => ({ value: a.id, label: a.name })),
        ]}
        onChange={(v) => onAccount(v === ALL ? undefined : v)}
        className="max-w-56"
      />
    </div>
  );
}
