import { Card } from "@/components/ui/card";
import { PageSection } from "@/components/PageSection";
import { Switch } from "@/components/ui/switch";
import { Note, SettingRow } from "@/components/SettingRow";
import type { MessageId, T } from "@/data/i18n";
import {
  DEFAULT_CONFIG_SYNC,
  type ConfigSyncSettings,
  type RelaySettings,
} from "../../shared/types";

/** The rows, in order: each choice with its label and its one-line note. */
const ROWS: {
  key: keyof ConfigSyncSettings;
  label: MessageId;
  hint?: MessageId;
}[] = [
  {
    key: "mcpServers",
    label: "configSync.mcpServers",
    hint: "configSync.mcpServersHint",
  },
  { key: "skills", label: "configSync.skills", hint: "configSync.skillsHint" },
  {
    key: "settings",
    label: "configSync.settings",
    hint: "configSync.settingsHint",
  },
  { key: "claudeMd", label: "configSync.claudeMd" },
];

/**
 * Settings → Switching: what a switch carries from the account being left into the Claude Code
 * profile of the one switched to (electron/core/config-sync.ts). All off until the user opts in.
 */
export function ConfigSyncPreference({
  settings,
  update,
  disabled,
  t,
}: {
  settings: RelaySettings;
  update: (patch: Partial<RelaySettings>) => void;
  disabled: boolean;
  t: T;
}) {
  const value = settings.configSync ?? DEFAULT_CONFIG_SYNC;
  return (
    <PageSection title={t("configSync.title")} info={t("configSync.info")}>
      <Card id="gecis-kurulum" padded>
        {ROWS.map(({ key, label, hint }) => (
          <SettingRow
            key={key}
            label={t(label)}
            htmlFor={`config-sync-${key}`}
            description={hint ? t(hint) : undefined}
          >
            <Switch
              id={`config-sync-${key}`}
              checked={value[key]}
              disabled={disabled}
              onCheckedChange={(on) =>
                update({ configSync: { ...value, [key]: on } })
              }
            />
          </SettingRow>
        ))}
        <Note className="pt-2">{t("configSync.alreadyShared")}</Note>
      </Card>
    </PageSection>
  );
}
