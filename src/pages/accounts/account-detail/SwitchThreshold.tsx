import type { Account } from "../../../../shared/types";
import { Card } from "@/components/ui/card";
import { OptionSelect, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "../../../../shared/percent";

/** The lines an account may have; "default" keeps the global one of each rule. */
const LINES = [50, 60, 70, 80, 90, 95, 100] as const;

/**
 * An account's own switch line: automatic switching leaves the account at it, and neither picks
 * nor suggests it past it. "Default" follows the warning threshold for the suggestion, 90% for a
 * target and a full limit for preparing on quit.
 */
export function SwitchThresholdCard({ account }: { account: Account }) {
  const { api, busy, desktop, action } = useRelay();
  const { t, language } = useI18n();
  const id = `switch-at-${account.id}`;
  return (
    <Card padded>
      <SettingRow label={t("switchThreshold.switchAwayAt")} htmlFor={id} description={t("switchThreshold.description")}>
        <OptionSelect<string>
          id={id}
          className="min-w-32"
          value={account.switchAtPercent === undefined ? "default" : String(account.switchAtPercent)}
          disabled={!!busy || !!desktop?.busy}
          onChange={(value) =>
            void action("switch-at", () =>
              api.setAccountSwitchAt(account.id, value === "default" ? undefined : Number(value)),
            )
          }
          options={[
            { value: "default", label: t("switchThreshold.default") },
            ...LINES.map((line) => ({ value: String(line), label: formatPercent(line, language) })),
          ]}
        />
      </SettingRow>
    </Card>
  );
}
