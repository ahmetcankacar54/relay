import test from "node:test";
import assert from "node:assert/strict";
import { mainSource } from "./helpers/main-source";
import { proxyExtrasSchema } from "../shared/proxy-status";
import { proxyConfigSchema } from "../electron/core/store";
import { AFFINITY_REVISION, currentAffinityTtl, LEGACY_AFFINITY_TTL_SECONDS } from "../shared/proxy-types";

test("a saved lifetime that is the old five-minute default moves to the hour, once", () => {
  // Saved before the default changed: never a choice.
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, undefined), 3_600);
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, 0), 3_600);
  // Any other saved value was chosen, and stays.
  assert.equal(currentAffinityTtl(900, undefined), 900);
  assert.equal(currentAffinityTtl(3_600, undefined), 3_600);
  // Five minutes chosen after the move stays five minutes.
  assert.equal(currentAffinityTtl(LEGACY_AFFINITY_TTL_SECONDS, AFFINITY_REVISION), LEGACY_AFFINITY_TTL_SECONDS);
  assert.equal(currentAffinityTtl(undefined, undefined), undefined);
});

test("the move is recorded beside the registry, which stays readable by older versions", () => {
  // The registry's proxy settings are strict: the revision may only live in proxy-pool.json.
  assert.equal(proxyExtrasSchema.parse({ affinityRevision: 1 }).affinityRevision, 1);
  assert.throws(() =>
    proxyConfigSchema.parse({ enabled: true, port: 8317, host: "127.0.0.1", affinityRevision: 1 }),
  );
  const main = mainSource();
  // Saving the settings keeps the revision, or the next start would move a chosen lifetime again.
  assert.match(main, /const \{ accountOrder, excludedAccountIds, clientBindings, affinityRevision, subagentOverflow, overflow, \.\.\.base \} = config;/);
  assert.match(main, /affinityRevision !== undefined \? \{ affinityRevision \} : \{\}/);
});
