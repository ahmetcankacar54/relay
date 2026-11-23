import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type AutoSwitchStrategy,
  type DesktopState,
  type RelaySettings,
} from "../shared/types";
import {
  AUTO_SWITCH_STRATEGIES,
  rankContinuationTargets,
  switchAtPercent,
} from "../shared/continuation-target-ranking";
import { chooseTarget } from "../electron/core/fleet-continuation";
import { autoSwitchDecision } from "../electron/core/auto-switch";
import { suggestedAccount } from "../shared/usage";
import { overviewAccounts } from "../src/data/selectors";
import { accountSchema, settingsPatchSchema } from "../electron/core/store";

const NOW = Date.parse("2026-10-13T06:00:00Z");
const HOUR = 3_600_000,
  DAY = 86_400_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();

/** A Pro account the Claude app is signed in to, as every automatic switch requires. */
function account(name: string): Account {
  const accountUuid = randomUUID(),
    orgId = randomUUID();
  return {
    id: randomUUID(),
    name,
    kind: "personal",
    group: "personal",
    color: "olive",
    createdAt: at(-DAY),
    planning: { plan: "pro", capacityWeight: 1 },
    desktop: { accountUuid, orgId, savedAt: at(-DAY) },
    auth: { loggedIn: true, accountUuid, orgId, checkedAt: at(0) },
  };
}
function usage(
  account: Account,
  fiveHour: { used: number; resetsIn?: number },
  week: { used: number; resetsIn: number },
): AccountUsage {
  return {
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: at(0),
    fiveHour: {
      usedPercent: fiveHour.used,
      ...(fiveHour.resetsIn === undefined ? {} : { resetsAt: at(fiveHour.resetsIn) }),
    },
    sevenDay: { usedPercent: week.used, resetsAt: at(week.resetsIn) },
  };
}

/**
 * Three accounts that each lead under one strategy: Alto is the most used (30% left, its 5-hour
 * period resets in 4 h), Vertex's open 5-hour period resets soonest (1 h), and Cirrus has a closed
 * 5-hour period but its week resets first (1 day).
 */
function fleet() {
  const source = account("Source");
  const alto = account("Alto");
  const vertex = account("Vertex");
  const cirrus = account("Cirrus");
  const accounts = [source, alto, vertex, cirrus];
  const readings: Record<string, AccountUsage> = {
    [source.id]: usage(source, { used: 100, resetsIn: 2 * HOUR }, { used: 50, resetsIn: 4 * DAY }),
    [alto.id]: usage(alto, { used: 70, resetsIn: 4 * HOUR }, { used: 20, resetsIn: 6 * DAY }),
    [vertex.id]: usage(vertex, { used: 20, resetsIn: 1 * HOUR }, { used: 10, resetsIn: 5 * DAY }),
    [cirrus.id]: usage(cirrus, { used: 0 }, { used: 40, resetsIn: 1 * DAY }),
  };
  return { source, alto, vertex, cirrus, accounts, readings };
}
const EXPECTED: Record<AutoSwitchStrategy, string> = {
  best: "Vertex",
  "weekly-first": "Cirrus",
  "consume-first": "Alto",
};
const settingsFor = (strategy: AutoSwitchStrategy | undefined, f = fleet()): RelaySettings => ({
  ...DEFAULT_SETTINGS,
  autoSwitchStrategy: strategy,
  autoSwitchMode: "after-exit",
  autoSwitchAccounts: f.accounts.map((a) => a.id),
});

test("each strategy picks a different target from the same three accounts", () => {
  const f = fleet();
  const candidates = [f.alto, f.vertex, f.cirrus].map((account) => ({ account, usage: f.readings[account.id] }));
  for (const rate of [undefined, 60])
    for (const strategy of AUTO_SWITCH_STRATEGIES)
      assert.equal(
        rankContinuationTargets(candidates, { now: NOW, rate, strategy })[0].account.name,
        EXPECTED[strategy],
        `${strategy} at ${rate ?? "no"} tempo`,
      );
  // No strategy is "best", today's rule: the open 5-hour period that resets soonest.
  assert.equal(rankContinuationTargets(candidates, { now: NOW })[0].account.name, "Vertex");
  // Without a context there is no strategy: capacity × remaining, as before (Vertex has 80% left).
  assert.deepEqual(
    rankContinuationTargets(candidates).map((r) => r.account.name),
    ["Vertex", "Cirrus", "Alto"],
  );
});

test("automatic switching, the fleet, the suggestion and the panel agree on the strategy's target", () => {
  for (const strategy of [undefined, ...AUTO_SWITCH_STRATEGIES]) {
    const f = fleet();
    const settings = settingsFor(strategy, f);
    const expected = EXPECTED[strategy ?? "best"];
    assert.equal(chooseTarget(f.source, f.accounts, settings, f.readings, NOW)?.name, expected, `fleet ${strategy}`);
    assert.equal(
      suggestedAccount(f.source, f.accounts, f.readings, settings, NOW)?.name,
      expected,
      `suggestion ${strategy}`,
    );
    const panel = overviewAccounts(f.source, f.accounts, f.readings, NOW, undefined, new Set(), strategy);
    assert.equal(panel.find((row) => row.recommended)?.account.name, expected, `panel ${strategy}`);
    const desktop: DesktopState = {
      available: true,
      running: false,
      currentAccountUuid: f.source.desktop!.accountUuid,
      activeProfileId: f.source.id,
      organizations: [f.source.desktop!.orgId],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
    };
    const decision = autoSwitchDecision(settings, f.accounts, desktop, f.readings, NOW, false, true);
    assert.equal(
      f.accounts.find((a) => a.id === decision.state.targetId)?.name,
      expected,
      `prepare on quit ${strategy}`,
    );
  }
});

test("an account's own switch line: it is left earlier and never chosen past it", () => {
  const f = fleet();
  assert.equal(switchAtPercent(f.alto, 90), 90);
  f.alto.switchAtPercent = 60;
  assert.equal(switchAtPercent(f.alto, 90), 60);
  // Alto is 70% used, past its own 60%: consume-first drains Cirrus (60% left) next instead.
  const settings = settingsFor("consume-first", f);
  const candidates = [f.alto, f.vertex, f.cirrus].map((account) => ({ account, usage: f.readings[account.id] }));
  const ranked = rankContinuationTargets(candidates, { now: NOW, strategy: "consume-first" });
  assert.equal(ranked[0].account.name, "Cirrus");
  assert.equal(ranked.at(-1)?.account.name, "Alto");
  assert.notEqual(chooseTarget(f.source, f.accounts, settings, f.readings, NOW)?.name, "Alto");
  assert.notEqual(suggestedAccount(f.source, f.accounts, f.readings, settings, NOW)?.name, "Alto");
  // A source with its own line is suggested away from before the warning threshold (90%).
  const early = fleet();
  early.readings[early.source.id] = usage(early.source, { used: 75, resetsIn: 2 * HOUR }, { used: 10, resetsIn: 4 * DAY });
  const earlySettings = settingsFor(undefined, early);
  assert.equal(suggestedAccount(early.source, early.accounts, early.readings, earlySettings, NOW), undefined);
  early.source.switchAtPercent = 70;
  assert.equal(suggestedAccount(early.source, early.accounts, early.readings, earlySettings, NOW)?.name, "Vertex");
  // Preparing on quit leaves it at 70% too, not only at a full limit.
  const desktop: DesktopState = {
    available: true,
    running: false,
    currentAccountUuid: early.source.desktop!.accountUuid,
    activeProfileId: early.source.id,
    organizations: [early.source.desktop!.orgId],
    busy: false,
    recoveryRequired: false,
    errorRevision: 0,
  };
  const decide = () => autoSwitchDecision(earlySettings, early.accounts, desktop, early.readings, NOW, false, true).state;
  assert.equal(decide().reason, "quota-exhausted");
  assert.equal(decide().targetId, early.vertex.id);
  delete early.source.switchAtPercent;
  assert.equal(decide().reason, "quota-available");
});

test("the strategy and the line are saved only as whole known values", () => {
  for (const strategy of AUTO_SWITCH_STRATEGIES)
    assert.deepEqual(settingsPatchSchema.parse({ autoSwitchStrategy: strategy }), { autoSwitchStrategy: strategy });
  assert.throws(() => settingsPatchSchema.parse({ autoSwitchStrategy: "round-robin" }));
  const line = accountSchema.shape.switchAtPercent;
  assert.equal(line.parse(80), 80);
  assert.equal(line.parse(undefined), undefined);
  for (const bad of [49, 101, 85.5, "80"]) assert.throws(() => line.parse(bad), String(bad));
  // A saved line outside 50–100 (a hand-edited file) falls back to the rule's own.
  assert.equal(switchAtPercent({ switchAtPercent: 20 }, 90), 90);
  assert.equal(DEFAULT_SETTINGS.autoSwitchStrategy, "best");
});
