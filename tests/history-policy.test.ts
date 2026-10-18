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

test("history is shared between all connected accounts by default; groups apply only when chosen", () => {
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
  assert.equal(settings.desktopHistoryTransfer, "all");
  assert.deepEqual(historySources(a, [a, b, c], settings), [b, c]);
  assert.deepEqual(
    historySources(a, [a, b, c], {
      ...settings,
      desktopHistoryTransfer: "same-group",
    }),
    [b],
  );
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
test("a registry from before shared-by-default moves from the old group default once; explicit choices stay", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Store } = await import("../electron/core/store");
  for (const [saved, expected] of [
    ["same-group", "all"],
    ["selected", "selected"],
    ["off", "off"],
  ] as const) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-history-"));
    try {
      const { historyPolicyVersion, ...old } = DEFAULT_SETTINGS;
      await fs.writeFile(
        path.join(root, "state.json"),
        JSON.stringify({
          version: 1,
          settings: { ...old, desktopHistoryTransfer: saved },
          accounts: [],
          pinned: [],
          importEnabled: false,
          lineage: {},
        }),
      );
      const store = new Store(root);
      assert.equal(store.state.settings.desktopHistoryTransfer, expected);
      assert.equal(store.state.settings.historyPolicyVersion, 2);
      // A later deliberate group choice is not migrated again.
      store.update((s) => {
        s.settings.desktopHistoryTransfer = "same-group";
      });
      assert.equal(
        new Store(root).state.settings.desktopHistoryTransfer,
        "same-group",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("the menu bar animation setting is optional and never defaulted", () => {
  const stored = settingsSchema.parse({ ...DEFAULT_SETTINGS });
  assert.equal("menuBarAnimation" in stored, false);
  assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, menuBarAnimation: false }).menuBarAnimation, false);
  assert.deepEqual(settingsPatchSchema.parse({ menuBarAnimation: false }), { menuBarAnimation: false });
  assert.equal("menuBarAnimation" in settingsPatchSchema.parse({ appearance: "dark" }), false);
  assert.throws(() => settingsPatchSchema.parse({ menuBarAnimation: "yes" }));
});

test("the switch window setting is optional and never defaulted", () => {
  const stored = settingsSchema.parse({ ...DEFAULT_SETTINGS });
  assert.equal("switchWindow" in stored, false);
  assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, switchWindow: false }).switchWindow, false);
  assert.deepEqual(settingsPatchSchema.parse({ switchWindow: false }), { switchWindow: false });
  assert.equal("switchWindow" in settingsPatchSchema.parse({ appearance: "dark" }), false);
  assert.throws(() => settingsPatchSchema.parse({ switchWindow: "no" }));
});

test("the panda pranks setting is optional and never defaulted", () => {
  const stored = settingsSchema.parse({ ...DEFAULT_SETTINGS });
  assert.equal("pranks" in stored, false);
  assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, pranks: "rarely" }).pranks, "rarely");
  assert.deepEqual(settingsPatchSchema.parse({ pranks: "off" }), { pranks: "off" });
  assert.equal("pranks" in settingsPatchSchema.parse({ appearance: "dark" }), false);
  assert.throws(() => settingsPatchSchema.parse({ pranks: "never" }));
});

test("the draft re-typing setting is optional, never defaulted, and off when missing", () => {
  assert.equal("draftRetype" in DEFAULT_SETTINGS, false);
  const stored = settingsSchema.parse({ ...DEFAULT_SETTINGS });
  assert.equal("draftRetype" in stored, false);
  assert.equal(settingsSchema.parse({ ...DEFAULT_SETTINGS, draftRetype: true }).draftRetype, true);
  assert.deepEqual(settingsPatchSchema.parse({ draftRetype: true }), { draftRetype: true });
  assert.deepEqual(settingsPatchSchema.parse({ draftRetype: false }), { draftRetype: false });
  assert.equal("draftRetype" in settingsPatchSchema.parse({ appearance: "dark" }), false);
  assert.throws(() => settingsPatchSchema.parse({ draftRetype: "yes" }));
});
