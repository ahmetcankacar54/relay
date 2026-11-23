import { useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { SettingGroup, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { usePlatform } from "@/data/platform";
import {
  SHORTCUT_ACTIONS,
  acceleratorFromKeys,
  formatAccelerator,
  shortcutFor,
} from "../../../shared/shortcuts";
import type { ShortcutAction } from "../../../shared/types";

const TEXT = {
  openPanel: ["shortcutSettings.openRelay", "shortcutSettings.openRelayDescription"],
  switchToSuggested: ["shortcutSettings.switchToSuggested", "shortcutSettings.switchToSuggestedDescription"],
} as const;

/** Keys that only modify: while just these are down, the recorder keeps waiting. */
const MODIFIER_KEYS: Record<string, true> = {
  Meta: true,
  Control: true,
  Alt: true,
  Shift: true,
  AltGraph: true,
  CapsLock: true,
  Fn: true,
  OS: true,
};

/**
 * Settings → General → Keyboard shortcuts: Relay's global shortcuts, each recorded by pressing
 * it (Escape cancels) and turned off with Clear. A key another app holds is said under its field;
 * main reports that (Snapshot.shortcuts), since only registering tells.
 */
export function ShortcutGroup() {
  const { api, data, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const platform = usePlatform() ?? "darwin";
  const disabled = !!busy || !!desktop?.busy;
  const [recording, setRecording] = useState<ShortcutAction>();
  const [rejected, setRejected] = useState<ShortcutAction>();
  // While a field records, main lets the registered keys go, so pressing the current one is
  // recorded instead of opening the panel; any end of recording (a key, Escape, leaving the
  // field, closing Settings) registers them again.
  useEffect(() => {
    if (!recording) return;
    void api.pauseShortcuts(true).catch(() => {});
    return () => void api.pauseShortcuts(false).catch(() => {});
  }, [recording, api]);
  const save = (which: ShortcutAction, accelerator: string) =>
    void action("settings", () =>
      api.updateSettings({
        shortcuts: {
          ...Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a, shortcutFor(settings.shortcuts, a)])),
          [which]: accelerator,
        },
      }),
    );
  const record = (which: ShortcutAction, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      setRecording(undefined);
      return;
    }
    if (MODIFIER_KEYS[event.key]) return;
    const accelerator = acceleratorFromKeys(event, platform);
    if (!accelerator) {
      setRejected(which);
      return;
    }
    setRecording(undefined);
    setRejected(undefined);
    save(which, accelerator);
  };
  return (
    <SettingGroup id="settings-shortcuts" title={t("shortcutSettings.keyboardShortcuts")}>
      {SHORTCUT_ACTIONS.map((which) => {
        const accelerator = shortcutFor(settings.shortcuts, which);
        const id = `shortcut-${which}`;
        const taken = !!accelerator && data?.shortcuts?.[which] === "taken";
        const listening = recording === which;
        const [label, description] = TEXT[which];
        return (
          <SettingRow
            key={which}
            label={t(label)}
            htmlFor={id}
            description={
              <>
                {t(description)}
                {listening && rejected === which && (
                  <span role="alert" className="block text-destructive">
                    {t("shortcutSettings.needsModifier")}
                  </span>
                )}
                {!listening && taken && (
                  <span role="alert" className="block text-destructive">
                    {t("shortcutSettings.taken")}
                  </span>
                )}
              </>
            }
          >
            <span className="flex items-center gap-2">
              <Button
                id={id}
                variant="outline"
                size="sm"
                className="min-w-28 font-mono"
                disabled={disabled}
                aria-label={`${t(label)}: ${t("shortcutSettings.change")}`}
                aria-pressed={listening}
                onClick={() => {
                  setRejected(undefined);
                  setRecording(listening ? undefined : which);
                }}
                onKeyDown={listening ? (event) => record(which, event) : undefined}
                onBlur={() => listening && setRecording(undefined)}
              >
                {listening
                  ? t("shortcutSettings.pressKeys")
                  : accelerator
                    ? formatAccelerator(accelerator, platform)
                    : t("common.off")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || !accelerator}
                onClick={() => {
                  setRecording(undefined);
                  save(which, "");
                }}
              >
                {t("shortcutSettings.clear")}
              </Button>
            </span>
          </SettingRow>
        );
      })}
    </SettingGroup>
  );
}
