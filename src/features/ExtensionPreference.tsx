import { useCallback, useEffect, useState } from "react";
import { DEFAULT_EXTENSION } from "../../shared/browser-extension";
import type { ExtensionMode, ExtensionStatus } from "../../shared/types";
import { extensionLine } from "../../shared/extension-text";
import { Button } from "@/components/ui/button";
import { Note, OptionSelect, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  instanceFromValue,
  instanceLabel,
  instanceLine,
  instanceValue,
  modeOptions,
  modeSentence,
  startupLine,
} from "@/lib/extension-ui";

/**
 * What Relay does with the Claude browser extension's sign-in at a switch: the mode, the browser
 * profile when several have the extension, and "Sync now". Hidden where the step does not run.
 */
export function ExtensionPreference({
  initialStatus,
}: {
  /** For static rendering; otherwise read on mount. */
  initialStatus?: ExtensionStatus;
}) {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  // undefined: not read yet. null: this Mac does not run the step.
  const [status, setStatus] = useState<ExtensionStatus | null | undefined>(initialStatus);
  const [result, setResult] = useState<string>();
  const load = useCallback(() => {
    api.extensionStatus().then((s) => setStatus(s ?? null), () => {});
  }, [api]);
  useEffect(load, [load, settings.claudeExtension]);
  if (!status) return null;
  const setting = settings.claudeExtension ?? DEFAULT_EXTENSION;
  const disabled = !!busy || !!desktop?.busy;
  const update = (next: typeof setting) =>
    void action("settings", () => api.updateSettings({ claudeExtension: next }));
  const startup = startupLine(status, t);
  return (
    <div className="grid gap-1">
      <SectionHeading
        title={t("Claude tarayıcı eklentisi", "Claude browser extension")}
        description={t(
          "Eklentinin girişi her geçişte hesapla birlikte değişir; tarayıcı profili açman gerekmez.",
          "The extension's sign-in follows the account at every switch; no browser profile to open.",
        )}
      />
      <SettingRow
        label={t("Geçişte eklenti girişi", "Extension sign-in at a switch")}
        htmlFor="extension-mode"
        description={modeSentence(setting.mode, t)}
      >
        <OptionSelect<ExtensionMode>
          id="extension-mode"
          value={setting.mode}
          options={modeOptions(t)}
          className="w-64"
          disabled={disabled}
          onChange={(mode) => update({ ...setting, mode })}
        />
      </SettingRow>
      {status.instances.length > 1 && (
        <SettingRow
          label={t("Eklentinin tarayıcı profili", "The extension's browser profile")}
          htmlFor="extension-instance"
          description={t(
            "Relay yalnızca bunun girişini yönetir.",
            "Relay manages the sign-in of this one only.",
          )}
        >
          <OptionSelect
            id="extension-instance"
            // A select item's value is never "": "none" stands for nothing chosen yet.
            value={status.target ? instanceValue(status.target) : "none"}
            options={[
              ...(status.target ? [] : [{ value: "none", label: t("Profil seç", "Choose a profile") }]),
              ...status.instances.map((i) => ({
                value: instanceValue(i),
                label: instanceLabel(i),
              })),
            ]}
            disabled={disabled}
            onChange={(value) => {
              const picked = instanceFromValue(status.instances, value);
              if (picked)
                update({ ...setting, browser: { app: picked.app, profile: picked.profile } });
            }}
          />
        </SettingRow>
      )}
      <SettingRow
        label={instanceLine(status, t)}
        description={startup}
      >
        <Button
          variant="outline"
          disabled={disabled || setting.mode === "off" || !status.target}
          onClick={() =>
            void action("extension-sync", async () => {
              const outcome = await api.syncExtension();
              setResult(
                extensionLine(outcome, t) ??
                  t("Eklentide değiştirilecek bir şey yok.", "Nothing to change in the extension."),
              );
              load();
            })
          }
        >
          {t("Şimdi eşitle", "Sync now")}
        </Button>
      </SettingRow>
      {result && (
        <p role="status" className="text-[13px]">
          {result}
        </p>
      )}
      {status.last && !result && (
        <Note>{extensionLine(status.last, t) ?? ""}</Note>
      )}
    </div>
  );
}
