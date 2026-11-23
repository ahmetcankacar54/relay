import type { NotificationSettings, RelaySettings } from "./types";

/**
 * Every notification type on, and "ready again" for the account in use: what Relay showed before
 * the Notifications group existed, plus the reset notice, which tells at most once per window reset.
 */
export const DEFAULT_NOTIFICATIONS: Required<NotificationSettings> = {
  limitFiveHour: true,
  limitWeekly: true,
  limitReset: "in-use",
  switches: true,
  signIns: true,
  earlyStart: true,
  updates: true,
};

/** The saved choices over the defaults: a registry from before the group, or a missing key, reads as the default. */
export function notificationSettings(
  settings: Pick<RelaySettings, "notifications">,
): Required<NotificationSettings> {
  return { ...DEFAULT_NOTIFICATIONS, ...settings.notifications };
}
