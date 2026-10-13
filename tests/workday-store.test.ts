import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Store,
  settingsPatchSchema,
  workdaySchema,
  accountPlanningSchema,
} from "../electron/core/store";
import { DEFAULT_WORKDAY } from "../shared/types";

test("0.4 registry migration preserves existing account and switch choices with routines off", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "relay-workday-migrate-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = new Store(root);
  const a = initial.create({ name: "Existing Max", kind: "personal" });
  initial.update((s) => {
    s.settings.desktopHistoryTransfer = "selected";
    s.settings.desktopHistoryAccounts = [a.id];
    s.settings.autoSwitchAccounts = [a.id];
  });
  const old = JSON.parse(await fs.readFile(initial.file, "utf8"));
  delete old.settings.workday;
  await fs.writeFile(initial.file, JSON.stringify(old));
  const migrated = new Store(root);
  assert.deepEqual(migrated.state.settings.workday, DEFAULT_WORKDAY);
  assert.equal(migrated.state.settings.workday.routineEnabled, false);
  assert.deepEqual(migrated.state.accounts, old.accounts);
  assert.deepEqual(migrated.state.settings.desktopHistoryAccounts, [a.id]);
  assert.deepEqual(migrated.state.settings.autoSwitchAccounts, [a.id]);
  const customized = {
    ...DEFAULT_WORKDAY,
    start: "22:00",
    end: "06:00",
    accountIds: [a.id],
  };
  migrated.update((s) => {
    s.settings.workday = customized;
  });
  const patch = settingsPatchSchema.parse({ usageWarnings: false });
  assert.equal("workday" in patch, false);
  migrated.update((s) => Object.assign(s.settings, patch));
  assert.deepEqual(new Store(root).state.settings.workday, customized);
});

test("workday schema supports full-day and overnight spans and refuses invalid dispatch settings", () => {
  assert.equal(workdaySchema.parse(DEFAULT_WORKDAY).start, "00:00");
  assert.equal(
    workdaySchema.parse({ ...DEFAULT_WORKDAY, start: "23:30", end: "06:30" })
      .end,
    "06:30",
  );
  for (const patch of [
    { timeZone: "invalid" },
    { start: "24:00" },
    { weekdays: [] },
    { weekdays: [1, 1] },
    { reservePercent: 101 },
    { warmupLeadMinutes: -1 },
    { routineEnabled: true },
    { accountIds: ["not-uuid"] },
  ]) {
    assert.equal(
      workdaySchema.safeParse({ ...DEFAULT_WORKDAY, ...patch }).success,
      false,
    );
  }
  assert.equal(
    accountPlanningSchema.safeParse({ plan: "max5", capacityWeight: 5 })
      .success,
    true,
  );
  assert.equal(
    accountPlanningSchema.safeParse({ plan: "unknown", capacityWeight: 0 })
      .success,
    false,
  );
  assert.equal(
    accountPlanningSchema.safeParse({ plan: "max", capacityWeight: 5 }).success,
    false,
  );
});
