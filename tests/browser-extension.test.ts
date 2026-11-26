import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseInstance,
  localStateProfiles,
  startupRestores,
} from "../shared/browser-extension";

test("profiles come from Local State; guest and system profiles are dropped", () => {
  const state = {
    profile: {
      profiles_order: ["Profile 1", "Default"],
      info_cache: {
        Default: { name: "Kişisel" },
        "Profile 1": { name: "  Studio " },
        "Guest Profile": { name: "Guest", is_guest: true },
        "System Profile": { name: "System" },
        "Profile 2": { name: "Temp", is_ephemeral: true },
        "../evil": { name: "x" },
      },
    },
  };
  assert.deepEqual(localStateProfiles(state), [
    { profile: "Profile 1", name: "Studio" },
    { profile: "Default", name: "Kişisel" },
  ]);
  assert.deepEqual(localStateProfiles(undefined), []);
  assert.deepEqual(localStateProfiles({ profile: {} }), []);
});

test("the startup setting restores tabs only for 'last session' (1 or 5)", () => {
  assert.equal(startupRestores({ session: { restore_on_startup: 1 } }), true);
  assert.equal(startupRestores({ session: { restore_on_startup: 5 } }), true);
  assert.equal(startupRestores({ session: { restore_on_startup: 4 } }), false);
  assert.equal(startupRestores({ session: {} }), false);
  assert.equal(startupRestores(undefined), false);
});

test("the chosen instance wins, the only one is used, several without a choice are none", () => {
  const brave = {
    app: "brave",
    profile: "Default",
    name: "A",
    opened: true,
  } as const;
  const chrome = {
    app: "chrome",
    profile: "Default",
    name: "B",
    opened: true,
  } as const;
  assert.equal(chooseInstance([brave], undefined), brave);
  assert.equal(chooseInstance([brave, chrome], undefined), undefined);
  assert.equal(
    chooseInstance([brave, chrome], { app: "chrome", profile: "Default" }),
    chrome,
  );
  // A chosen instance that is gone does not pick another of several.
  assert.equal(
    chooseInstance([brave, chrome], { app: "edge", profile: "Default" }),
    undefined,
  );
  assert.equal(chooseInstance([], undefined), undefined);
});
