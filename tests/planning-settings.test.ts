import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  Store,
  planningFromWorkday,
  planningPatchSchema,
  planningSchema,
} from "../electron/core/store";
import { DEFAULT_PLANNING, DEFAULT_SETTINGS } from "../shared/types";

test("a legacy workday becomes weekday/weekend hours with its accounts and routine choice", () => {
  const a = randomUUID(),
    b = randomUUID();
  const planning = planningFromWorkday({
    timeZone: "Europe/Istanbul",
    start: "09:00",
    end: "21:00",
    weekdays: [1, 2, 3, 4, 5],
    accountIds: [a, "not-a-uuid", b, a],
    routineEnabled: true,
  });
  assert.deepEqual(planning, {
    autoStart: true,
    timeZone: "Europe/Istanbul",
    weekday: { enabled: true, start: "09:00", end: "21:00" },
    weekend: { enabled: false, start: "09:00", end: "21:00" },
    accounts: [{ id: a }, { id: b }],
  });
  assert.deepEqual(planningFromWorkday(undefined), DEFAULT_PLANNING);
});

test("a registry without planning settings is migrated on load", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-planning-"));
  try {
    const id = randomUUID();
    const { planning, ...settings } = DEFAULT_SETTINGS;
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        version: 1,
        settings: {
          ...settings,
          workday: {
            timeZone: "Europe/Istanbul",
            reservePercent: 10,
            staggerMinutes: 60,
            warmupLeadMinutes: 0,
            routineEnabled: false,
            start: "00:00",
            end: "00:00",
            weekdays: [0, 1, 2, 3, 4, 5, 6],
            accountIds: [id],
          },
        },
        accounts: [],
        pinned: [],
        importEnabled: false,
        lineage: {},
      }),
    );
    const store = new Store(root);
    assert.equal(store.state.settings.planning.weekday.enabled, true);
    assert.equal(store.state.settings.planning.weekend.enabled, true);
    assert.equal(store.state.settings.planning.weekday.start, "00:00");
    assert.deepEqual(store.state.settings.planning.accounts, [{ id }]);
    assert.equal(store.state.settings.planning.autoStart, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("planning settings reject duplicates, bad clocks, bad zones and unknown keys", () => {
  const id = randomUUID();
  assert.equal(planningSchema.safeParse(DEFAULT_PLANNING).success, true);
  for (const bad of [
    { ...DEFAULT_PLANNING, accounts: [{ id }, { id }] },
    {
      ...DEFAULT_PLANNING,
      weekday: { enabled: true, start: "9:00", end: "18:00" },
    },
    { ...DEFAULT_PLANNING, timeZone: "Mars/Olympus" },
    { ...DEFAULT_PLANNING, accounts: [{ id, firstStart: "24:00" }] },
    { ...DEFAULT_PLANNING, extra: true },
  ])
    assert.equal(planningSchema.safeParse(bad).success, false);
});

test("a registry that has both planning and a legacy workday keeps planning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-planning-"));
  try {
    const id = randomUUID();
    const planning = {
      ...DEFAULT_PLANNING,
      accounts: [{ id, firstStart: "07:00" }],
    };
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({
        version: 1,
        settings: {
          ...DEFAULT_SETTINGS,
          planning,
          workday: { start: "09:00" },
        },
        accounts: [],
        pinned: [],
        importEnabled: false,
        lineage: {},
      }),
    );
    const store = new Store(root);
    assert.deepEqual(store.state.settings.planning, planning);
    assert.equal("workday" in store.state.settings, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an untouched legacy workday becomes the new default hours, not a 24-hour day", () => {
  const planning = planningFromWorkday({
    timeZone: "Europe/Berlin",
    start: "00:00",
    end: "00:00",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    accountIds: [],
    reservePercent: 10,
    staggerMinutes: 60,
    warmupLeadMinutes: 0,
    routineEnabled: false,
  });
  assert.deepEqual(planning, {
    ...DEFAULT_PLANNING,
    timeZone: "Europe/Berlin",
  });
});

test("the tempo choice is optional, validated, and kept by a patch that omits it", () => {
  const { tempo: _default, ...valid } = DEFAULT_PLANNING;
  assert.equal(
    planningSchema.parse({ ...valid, tempo: "medium" }).tempo,
    "medium",
  );
  const without = planningSchema.parse(valid);
  assert.equal("tempo" in without, false);
  assert.throws(() => planningSchema.parse({ ...valid, tempo: "fast" }));
  const patch = planningPatchSchema.parse({ autoStart: true });
  assert.equal("tempo" in patch, false);
  const stored = planningSchema.parse({ ...valid, tempo: "heavy" });
  assert.equal({ ...stored, ...patch }.tempo, "heavy");
  assert.equal(DEFAULT_PLANNING.tempo, "auto");
});

test("adaptation is optional, validated, and kept by a patch that omits it", () => {
  const { tempo: _tempo, ...valid } = DEFAULT_PLANNING;
  assert.equal(
    planningSchema.parse({ ...valid, adaptive: false }).adaptive,
    false,
  );
  // A registry without the field parses without it: missing means on.
  assert.equal("adaptive" in planningSchema.parse(valid), false);
  assert.throws(() => planningSchema.parse({ ...valid, adaptive: "off" }));
  const patch = planningPatchSchema.parse({ autoStart: true });
  assert.equal("adaptive" in patch, false);
  const stored = planningSchema.parse({ ...valid, adaptive: false });
  assert.equal({ ...stored, ...patch }.adaptive, false);
});
