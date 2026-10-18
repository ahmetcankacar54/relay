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

test("history stays within the sharing group by default; all accounts share only when chosen", () => {
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
  assert.equal(DEFAULT_SETTINGS.desktopHistoryTransfer, "same-group");
  assert.equal(settings.desktopHistoryTransfer, "same-group");
  assert.deepEqual(historySources(a, [a, b, c], settings), [b]);
  assert.deepEqual(
    historySources(a, [a, b, c], {
      ...settings,
      desktopHistoryTransfer: "all",
    }),
    [b, c],
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

/** A registry saved by an older Relay, with the history mode (and version) as given. */
async function storeWith(
  settings: (old: Record<string, unknown>) => Record<string, unknown> | undefined,
) {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Store } = await import("../electron/core/store");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-history-"));
  const state: Record<string, unknown> = {
    version: 1,
    accounts: [],
    pinned: [],
    importEnabled: false,
    lineage: {},
  };
  const saved = settings({ ...DEFAULT_SETTINGS });
  if (saved) state.settings = saved;
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
  return {
    store: new Store(root),
    reopen: () => new Store(root),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("a new install keeps company and personal Code history apart", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { Store } = await import("../electron/core/store");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-history-"));
  try {
    const store = new Store(root);
    assert.equal(store.state.settings.desktopHistoryTransfer, "same-group");
    assert.equal(store.state.settings.historyPolicyVersion, 2);
    const personal = store.create({ name: "Kişisel", kind: "personal" });
    const company = store.create({ name: "Şirket", kind: "work" });
    for (const a of [personal, company])
      store.update((s) => {
        s.accounts.find((x) => x.id === a.id)!.desktop = {
          accountUuid: randomUUID(),
          orgId: randomUUID(),
          savedAt: new Date().toISOString(),
        };
      });
    assert.deepEqual(
      historySources(store.account(personal.id), store.state.accounts, store.state.settings),
      [],
    );
    // The first write does not change the mode, and the next start keeps it.
    assert.equal(new Store(root).state.settings.desktopHistoryTransfer, "same-group");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an existing install keeps the history mode it stored", async () => {
  for (const mode of ["all", "same-group", "selected", "off"] as const) {
    const { store, reopen, cleanup } = await storeWith((old) => ({
      ...old,
      desktopHistoryTransfer: mode,
      historyPolicyVersion: 2,
    }));
    try {
      assert.equal(store.state.settings.desktopHistoryTransfer, mode, mode);
      assert.equal(reopen().state.settings.desktopHistoryTransfer, mode, mode);
    } finally {
      await cleanup();
    }
  }
});

test("a stored registry without the history mode keeps the old default, all accounts", async () => {
  // Settings that never wrote the field.
  for (const version of [2, undefined] as const) {
    const { store, reopen, cleanup } = await storeWith((old) => {
      const { desktopHistoryTransfer, historyPolicyVersion, ...rest } = old;
      return version ? { ...rest, historyPolicyVersion: version } : rest;
    });
    try {
      assert.equal(store.state.settings.desktopHistoryTransfer, "all", String(version));
      assert.equal(reopen().state.settings.desktopHistoryTransfer, "all", String(version));
      assert.equal(store.state.settings.usageRefreshMinutes, DEFAULT_SETTINGS.usageRefreshMinutes);
    } finally {
      await cleanup();
    }
  }
  // No settings at all.
  const none = await storeWith(() => undefined);
  try {
    assert.equal(none.store.state.settings.desktopHistoryTransfer, "all");
    assert.deepEqual(none.store.state.settings, {
      ...DEFAULT_SETTINGS,
      desktopHistoryTransfer: "all",
    });
  } finally {
    await none.cleanup();
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
