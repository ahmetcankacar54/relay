import { ExternalLink } from "@/components/ExternalLink";
import { MeterLogo } from "@/components/MeterLogo";
import { useRiskConsent } from "@/components/RiskConsent";
import { Note, SettingGroup, SettingRow } from "@/components/SettingRow";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  FEATURE_RISKS,
  POLICY_LINKS,
  meterRisk,
} from "../../../shared/feature-risk";
import {
  METER_NAMES,
  METER_PROVIDERS,
  enabledMeters,
  type MeterProvider,
} from "../../../shared/meters";

const DESCRIPTION = {
  copilot: "meters.settingsCopilot",
  cursor: "meters.settingsCursor",
  "gemini-cli": "meters.settingsGeminiCli",
} as const satisfies Record<MeterProvider, string>;

/**
 * Settings → General → Other tools: the read-only usage meters, each off until turned on here. Each
 * reads an endpoint the tool's maker has not published, so turning one on asks about its risk first
 * (main refuses without the answer); the row links the maker's terms.
 */
export function MeterGroup() {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const consent = useRiskConsent();
  const disabled = !!busy || !!desktop?.busy;
  const on = enabledMeters(settings);
  const toggle = async (provider: MeterProvider, checked: boolean) => {
    if (checked && !(await consent.ask([meterRisk(provider)]))) return;
    const meters = checked
      ? [...on, provider]
      : on.filter((p) => p !== provider);
    void action("settings", () => api.updateSettings({ meters }));
  };
  return (
    <SettingGroup id="settings-meters" title={t("meters.otherTools")}>
      <Note className="pt-2.5">{t("meters.settingsIntro")}</Note>
      {METER_PROVIDERS.map((provider) => {
        const id = `meter-${provider}`;
        const link = POLICY_LINKS[FEATURE_RISKS[meterRisk(provider)].links[0]];
        return (
          <SettingRow
            key={provider}
            label={
              <span className="flex items-center gap-1.5">
                <MeterLogo provider={provider} />
                {METER_NAMES[provider]}
              </span>
            }
            htmlFor={id}
            description={
              <>
                {t(DESCRIPTION[provider])}{" "}
                <ExternalLink href={link.href}>{t(link.label)}</ExternalLink>
              </>
            }
          >
            <Switch
              id={id}
              checked={on.includes(provider)}
              disabled={disabled}
              onCheckedChange={(checked) => void toggle(provider, checked)}
            />
          </SettingRow>
        );
      })}
      {consent.dialog}
    </SettingGroup>
  );
}
