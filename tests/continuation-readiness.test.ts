import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  continuationPolicyReason,
  type ContinuationRequest,
} from "../electron/core/continuation";
import { continuationTargetReadinessReason } from "../shared/continuation-readiness";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type RelaySettings,
} from "../shared/types";
import { ContinuationSettings } from "../src/ContinuationSettings";

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
function request(
  account: Account,
  usage: AccountUsage,
  policy = settings,
): ContinuationRequest {
  return {
    id: "readiness-test",
    source,
    target: account,
    settings: policy,
    usage: { [source.id]: quota(source, 100), [account.id]: usage },
    sessionId: "55555555-5555-4555-8555-555555555555",
    projectKey: "fixture-project",
    transcriptRevision: "fixture-transcript",
    permissionMode: "Auto",
    expectedContextRevision: 1,
    authorized: true,
  };
}

test("target preparation agrees with the runtime policy across quota freshness, reset and sharing boundaries", () => {
  const scenarios: ((
    account: Account,
    usage: AccountUsage,
    policy: RelaySettings,
  ) => void)[] = [
    () => {},
    (_a, usage) => {
      usage.checkedAt = new Date(NOW - 300_000).toISOString();
    },
    (_a, usage) => {
      usage.checkedAt = new Date(NOW - 300_001).toISOString();
    },
    (_a, usage) => {
      usage.checkedAt = new Date(NOW + 1).toISOString();
    },
    (_a, usage) => {
      usage.checkedAt = "invalid";
    },
    (_a, usage) => {
      usage.accountId = source.id;
    },
    (_a, usage) => {
      usage.status = "loading";
    },
    (_a, usage) => {
      usage.stale = true;
    },
    (_a, usage) => {
      usage.issue = "keychain-locked";
    },
    (_a, usage) => {
      delete usage.fiveHour;
    },
    (_a, usage) => {
      usage.fiveHour!.resetsAt = new Date(NOW).toISOString();
    },
    (_a, usage) => {
      usage.sevenDay!.resetsAt = "invalid";
    },
    (_a, usage) => {
      usage.fiveHour!.usedPercent = 89.999;
    },
    (_a, usage) => {
      usage.fiveHour!.usedPercent = 90;
    },
    (_a, usage) => {
      usage.sevenDay!.usedPercent = 90;
    },
    (_a, usage) => {
      usage.fiveHour!.usedPercent = NaN;
    },
    (_a, usage) => {
      usage.sevenDay!.usedPercent = -1;
    },
    (_a, usage) => {
      usage.fiveHour = { usedPercent: 0 };
    },
    (_a, usage) => {
      usage.fiveHour = { usedPercent: 1 };
    },
    (account) => {
      account.cooldownUntil = new Date(NOW + 1).toISOString();
    },
    (account) => {
      account.cooldownUntil = new Date(NOW).toISOString();
    },
    (account) => {
      account.cooldownUntil = "invalid";
    },
    (_a, _u, policy) => {
      policy.desktopHistoryTransfer = "off";
    },
    (_a, _u, policy) => {
      policy.desktopHistoryAccounts = [target.id];
    },
    (account, _u, policy) => {
      policy.desktopHistoryTransfer = "same-group";
      account.group = "other";
    },
    (account) => {
      account.auth!.orgId = source.auth!.orgId;
    },
    (account) => {
      account.auth!.loggedIn = false;
    },
    (account) => {
      delete account.desktop;
    },
    (account) => {
      account.desktop!.accountUuid = "not-a-uuid";
      account.auth!.accountUuid = "not-a-uuid";
    },
    (_a, usage) => {
      usage.connectionRenewalRequired = true;
    },
  ];
  for (const [index, mutate] of scenarios.entries()) {
    const account = structuredClone(target),
      usage = quota(account),
      policy = structuredClone(settings);
    mutate(account, usage, policy);
    const preparation = continuationTargetReadinessReason(
      source,
      account,
      usage,
      policy,
      NOW,
    );
    const runtime = continuationPolicyReason(
      request(account, usage, policy),
      NOW,
    );
    assert.equal(
      preparation === undefined,
      runtime === undefined,
      `scenario ${index}: ${preparation}/${runtime}`,
    );
  }
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
      t: (_tr, en) => en,
      usage: { [target.id]: usage },
      settings: { ...settings, usageRefreshMinutes: refreshMinutes },
      now: NOW,
    }),
  );
}
test("preparation distinguishes connected enrollment from fresh target capacity without authorizing a watch", () => {
  const teamSeat = render(false);
  assert.match(teamSeat, /1 connected accounts · checked at handoff/);
  assert.match(teamSeat, /1 accounts have verified target capacity/);
  assert.match(teamSeat, /5-hour quota is available; no weekly limit reported/);
  assert.match(render(), /1 accounts have verified target capacity/);
  assert.match(render(), /5-hour and weekly quota are available/);
  assert.match(render(true, false, 15), /Choose 5-minute refresh/);
});
test("a frozen watch does not show newly connected accounts as current authorized targets", () => {
  const html = render(true, true);
  assert.doesNotMatch(html, /have verified target capacity/);
  assert.match(html, /Turn off watching/);
  assert.match(html, /enable watching again to include accounts added later/);
});
