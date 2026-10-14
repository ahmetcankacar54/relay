import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, settingsPatchSchema } from "../electron/core/store";
import { themeSource } from "../electron/core/appearance";
import { DEFAULT_SETTINGS } from "../shared/types";

test("appearance defaults to system and old registries migrate", async () => {
  assert.equal(DEFAULT_SETTINGS.appearance, "system");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-appearance-"));
  try {
    const { appearance, ...settings } = DEFAULT_SETTINGS;
    await fs.writeFile(
      path.join(root, "state.json"),
      JSON.stringify({ version: 1, settings, accounts: [], pinned: [], importEnabled: false, lineage: {} }),
    );
    assert.equal(new Store(root).state.settings.appearance, "system");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("appearance patches accept only the three modes and map to the theme source", () => {
  assert.equal(settingsPatchSchema.safeParse({ appearance: "dark" }).success, true);
  assert.equal(settingsPatchSchema.safeParse({ appearance: "sepia" }).success, false);
  assert.deepEqual(settingsPatchSchema.parse({ usageWarnings: false }), { usageWarnings: false });
  assert.equal(themeSource({ appearance: "light" }), "light");
  assert.equal(themeSource({ appearance: "system" }), "system");
});
