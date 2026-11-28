import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { continuationTargetReadinessReason } from "../shared/continuation-readiness";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type RelaySettings,
} from "../shared/types";
import { ContinuationSettings } from "../src/features/ContinuationSettings";
import { testT } from "./i18n";

const NOW = Date.parse("2026-10-13T14:00:00Z");
const source: Account = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Max",
  kind: "personal",
  group: "fixture",
  color: "olive",
  createdAt: new Date(NOW).toISOString(),
  desktop: {
    accountUuid: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    savedAt: new Date(NOW).toISOString(),
  },
  auth: {
    loggedIn: true,
    accountUuid: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    checkedAt: new Date(NOW).toISOString(),
  },
};
const target: Account = {
  ...structuredClone(source),
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Team",
  desktop: {
    accountUuid: "33333333-3333-4333-8333-333333333333",
    orgId: "44444444-4444-4444-8444-444444444444",
    savedAt: new Date(NOW).toISOString(),
  },
  auth: {
    loggedIn: true,
    accountUuid: "33333333-3333-4333-8333-333333333333",
    orgId: "44444444-4444-4444-8444-444444444444",
    checkedAt: new Date(NOW).toISOString(),
  },
};
const settings: RelaySettings = {
  ...DEFAULT_SETTINGS,
  desktopHistoryTransfer: "selected",
  desktopHistoryAccounts: [source.id, target.id],
};
const quota = (account: Account, used = 20): AccountUsage => ({
  accountId: account.id,
  status: "ready",
  stale: false,
  checkedAt: new Date(NOW).toISOString(),
  fiveHour: {
    usedPercent: used,
    resetsAt: new Date(NOW + 3_600_000).toISOString(),
  },
  sevenDay: {
    usedPercent: 40,
    resetsAt: new Date(NOW + 86_400_000).toISOString(),
  },
});
test("a seat without a reported weekly window is judged by its five-hour window; historical resets never count", () => {
  const usage = quota(target);
  delete usage.sevenDay;
  usage.lastKnownResets = {
    sevenDay: {
      resetsAt: new Date(NOW + 86_400_000).toISOString(),
      checkedAt: new Date(NOW).toISOString(),
    },
  };
  assert.equal(
    continuationTargetReadinessReason(source, target, usage, settings, NOW),
    undefined,
  );
  usage.fiveHour = { ...usage.fiveHour!, usedPercent: 95 };
  assert.equal(
    continuationTargetReadinessReason(source, target, usage, settings, NOW),
    "target-quota-unavailable",
  );
  usage.fiveHour = undefined;
  assert.equal(
    continuationTargetReadinessReason(source, target, usage, settings, NOW),
    "five-hour-unavailable",
  );
});

test("source enrollment and duplicate identities cannot imply an alternative account", () => {
  assert.equal(
    continuationTargetReadinessReason(
      undefined,
      target,
      quota(target),
      settings,
      NOW,
    ),
    "source-not-enrolled",
  );
  const duplicate = {
    ...target,
    desktop: structuredClone(source.desktop),
    auth: structuredClone(source.auth),
  };
  assert.equal(
    continuationTargetReadinessReason(
      source,
      duplicate,
      quota(duplicate),
      settings,
      NOW,
    ),
    "duplicate-identity",
  );
});

function render(
  weekly = true,
  enabled = false,
  refreshMinutes: RelaySettings["usageRefreshMinutes"] = 5,
) {
  const usage = quota(target);
  if (!weekly) delete usage.sevenDay;
  return renderToStaticMarkup(
    createElement(ContinuationSettings, {
      accounts: [source, target],
      active: source,
      value: {
        status: enabled ? "armed" : "off",
        reason: enabled ? "awaiting-quota-stop" : "disabled",
        enabled,
        executable: true,
        sourceId: source.id,
        targetSelection: "automatic",
        allowedTargetCount: 1,
      },
      busy: false,
      canArm: true,
      onRefresh: () => {},
      onArm: () => {},
      onDisable: () => {},
      t: testT("en"),
      usage: { [target.id]: usage },
      settings: { ...settings, usageRefreshMinutes: refreshMinutes },
      now: NOW,
    }),
  );
}
test("preparation distinguishes connected enrollment from fresh target capacity without authorizing a watch", () => {
  const teamSeat = render(false);
  assert.match(teamSeat, /1 connected account · checked at handoff/);
  assert.match(teamSeat, /Enough limit verified on 1 account</);
  assert.match(teamSeat, /5-hour limit is available\. No weekly limit reported/);
  assert.match(render(), /Enough limit verified on 1 account</);
  assert.match(render(), /5-hour and weekly limits are available/);
  assert.match(render(true, false, 15), /In Settings, set “Refresh limits automatically” to “Every 5 min”/);
});
test("a frozen watch does not show newly connected accounts as current authorized targets", () => {
  const html = render(true, true);
  assert.doesNotMatch(html, /have verified target capacity/);
  assert.match(html, /Turn off watching/);
  assert.match(html, /To include accounts that you add later, turn watching on again/);
});
