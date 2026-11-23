import { Switch } from "@/components/ui/switch";
import { Note, OptionSelect, SettingGroup, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { notificationSettings } from "../../../shared/notifications";
import type { LimitResetNotice, NotificationSettings } from "../../../shared/types";
import { RemoteNotifyRows } from "./RemoteNotifySettings";

/** The two limit windows, each with its warning and its "ready again". */
const LIMITS = [
  ["limitFiveHour", "notification-five-hour", "notificationSettings.fiveHourLimit"],
  ["limitWeekly", "notification-weekly", "notificationSettings.weeklyLimit"],
] as const;
/** The notification types with a plain switch, in the group's order after the limits. */
const TOGGLES = [
  ["switches", "notificationSettings.switches", "notificationSettings.switchesDescription"],
  ["signIns", "notificationSettings.signIns", "notificationSettings.signInsDescription"],
  ["earlyStart", "notificationSettings.earlyStart", "notificationSettings.earlyStartDescription"],
  ["updates", "notificationSettings.updates", "notificationSettings.updatesDescription"],
] as const;

/**
 * Settings → General → Notifications: every notification Relay shows, one switch per type. The
 * limit warnings keep the threshold of "Mark accounts near their limit" on the Switching page,
 * and need it on; "ready again" uses the same threshold but not the marks. A change saves the
 * whole group, so the stored object always holds every choice.
 */
export function NotificationGroup() {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  const current = notificationSettings(settings);
  const update = (patch: NotificationSettings) =>
    void action("settings", () => api.updateSettings({ notifications: { ...current, ...patch } }));
  return (
    <SettingGroup id="settings-notifications" title={t("notificationSettings.notifications")}>
      {LIMITS.map(([key, id, label]) => (
        <SettingRow key={key} label={t(label)} htmlFor={id} description={t("notificationSettings.limitDescription")}>
          <Switch
            id={id}
            checked={current[key]}
            disabled={disabled}
            onCheckedChange={(on) => update({ [key]: on })}
          />
        </SettingRow>
      ))}
      {!settings.usageWarnings && (
        <Note className="py-2">{t("notificationSettings.warningsNeedMarks")}</Note>
      )}
      <SettingRow
        label={t("notificationSettings.readyAgain")}
        htmlFor="notification-ready"
        description={t("notificationSettings.readyAgainDescription")}
      >
        <OptionSelect<LimitResetNotice>
          id="notification-ready"
          value={current.limitReset}
          disabled={disabled}
          onChange={(limitReset) => update({ limitReset })}
          options={[
            { value: "in-use", label: t("notificationSettings.accountInUse") },
            { value: "all", label: t("notificationSettings.everyAccount") },
            { value: "off", label: t("common.off") },
          ]}
        />
      </SettingRow>
      {TOGGLES.map(([key, label, description]) => (
        <SettingRow key={key} label={t(label)} htmlFor={`notification-${key}`} description={t(description)}>
          <Switch
            id={`notification-${key}`}
            checked={current[key]}
            disabled={disabled}
            onCheckedChange={(on) => update({ [key]: on })}
          />
        </SettingRow>
      ))}
      <RemoteNotifyRows />
    </SettingGroup>
  );
}
