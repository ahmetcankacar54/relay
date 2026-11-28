import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotificationGroup } from "../src/pages/settings/NotificationSettings";
import { Settings } from "../src/pages/Settings";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue } from "./i18n";
import {
  DEFAULT_NOTIFICATIONS,
  notificationSettings,
} from "../shared/notifications";
import {
  DEFAULT_SETTINGS,
  type RelaySettings,
  type Snapshot,
} from "../shared/types";

function relayFor(settings: RelaySettings): Relay {
  return {
    api: { claudeLaunch: async () => ({ quicOff: false }) },
    settings,
    busy: "",
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
    },
    data: {
      settings,
      usage: {},
      accounts: [],
      authFlows: [],
      diagnostics: { platform: "linux", version: "2.1.0" },
    } as unknown as Snapshot,
    accounts: [],
    action: async () => true,
  } as unknown as Relay;
}

const render = (node: ReactElement, settings: Partial<RelaySettings> = {}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(
        I18nContext.Provider,
        { value: i18nValue("en") },
        createElement(
          RelayContext.Provider,
          { value: relayFor({ ...DEFAULT_SETTINGS, ...settings }) },
          node,
        ),
      ),
    ),
  );

test("a registry without the group reads every notification as on, ready again for the account in use", () => {
  assert.deepEqual(
    notificationSettings(DEFAULT_SETTINGS),
    DEFAULT_NOTIFICATIONS,
  );
  assert.deepEqual(
    notificationSettings({ notifications: { limitWeekly: false } }),
    { ...DEFAULT_NOTIFICATIONS, limitWeekly: false },
  );
  assert.equal(DEFAULT_NOTIFICATIONS.limitReset, "in-use");
});

test("every notification type sits in one Notifications group in Settings → General", () => {
  const page = render(createElement(Settings, { tab: "genel" }));
  const start = page.indexOf('id="settings-notifications"');
  assert.ok(start > 0);
  const group = page.slice(start);
  for (const label of [
    "5-hour limit",
    "Weekly limit",
    "Ready again",
    "Switches",
    "Sign-ins",
    "Early start",
    "Updates",
  ])
    assert.match(group, new RegExp(`>${label}<`));
  assert.match(group, /Account in use/);
});

test("the limit warnings say they need the marks only while the marks are off", () => {
  const need = /Limit warnings also need “Mark accounts near their limit”/;
  assert.doesNotMatch(render(createElement(NotificationGroup)), need);
  assert.match(
    render(createElement(NotificationGroup), { usageWarnings: false }),
    need,
  );
  // A switch turned off shows off.
  const off = render(createElement(NotificationGroup), {
    notifications: { updates: false },
  });
  assert.match(
    off,
    /id="notification-updates"[^>]*aria-checked="false"|aria-checked="false"[^>]*id="notification-updates"/,
  );
});
