import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DEFAULT_SETTINGS, type Account } from "../shared/types";
import { historySources, allowedHistoryPair } from "../shared/history-policy";
import { settingsSchema, settingsPatchSchema } from "../electron/core/store";

const account = (group: string): Account => ({
  id: randomUUID(),
  name: group,
  group,
  kind: "work",
  color: "blue",
  createdAt: new Date().toISOString(),
  desktop: {
    accountUuid: randomUUID(),
    orgId: randomUUID(),
    savedAt: new Date().toISOString(),
  },
});

test("history defaults preserve group boundaries and automation stays off for legacy settings", () => {
  const {
    desktopHistoryAccounts,
    autoSwitchMode,
    autoSwitchAccounts,
    ...legacy
  } = DEFAULT_SETTINGS;
  const settings = settingsSchema.parse(legacy);
  assert.equal(settings.autoSwitchMode, "off");
  assert.deepEqual(settings.autoSwitchAccounts, []);
  const a = account("personal"),
    b = account("personal"),
    c = account("work:client");
  assert.deepEqual(historySources(a, [a, b, c], settings), [b]);
  assert.deepEqual(
    historySources(a, [a, b, c], {
      ...settings,
      desktopHistoryTransfer: "off",
    }),
    [],
  );
  // Defaults apply on loading only, never to unrelated fields in an IPC patch.
  assert.deepEqual(settingsPatchSchema.parse({ usageWarnings: false }), {
    usageWarnings: false,
  });
});

test("selected history requires both endpoints and excludes every unselected or unbound account", () => {
  const a = account("personal"),
    b = account("work:first"),
    c = account("work:second"),
    unbound = account("personal");
  delete unbound.desktop;
  const settings = {
    ...DEFAULT_SETTINGS,
    desktopHistoryTransfer: "selected" as const,
    desktopHistoryAccounts: [a.id, b.id, unbound.id],
  };
  assert.deepEqual(historySources(a, [a, b, c, unbound], settings), [b]);
  assert.deepEqual(historySources(b, [a, b, c], settings), [a]);
  assert.deepEqual(historySources(c, [a, b, c], settings), []);
  assert.equal(allowedHistoryPair(a, b, settings), true);
  assert.equal(allowedHistoryPair(a, c, settings), false);
  assert.throws(() =>
    settingsSchema.parse({ ...settings, autoSwitchMode: "live" }),
  );
  assert.throws(() =>
    settingsSchema.parse({
      ...settings,
      desktopHistoryAccounts: ["../anything"],
    }),
  );
});
