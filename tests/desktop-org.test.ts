import test from "node:test";
import assert from "node:assert/strict";
import { activeOrgHint } from "../electron/core/desktop-org";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const OLD = "00000000-0000-4000-8000-0000000000c3";
const NOW = "00000000-0000-4000-8000-0000000000d4";
const THIRD = "00000000-0000-4000-8000-0000000000e5";

test("a single workspace, or a config that says nothing, gives no hint", () => {
  assert.equal(activeOrgHint({ a: { accountUuid: ACCOUNT, orgUuid: NOW } }, ACCOUNT, [NOW]), undefined);
  assert.equal(activeOrgHint({ locale: "en-US" }, ACCOUNT, [OLD, NOW]), undefined);
  for (const config of [null, undefined, "x", [], 7])
    assert.equal(activeOrgHint(config, ACCOUNT, [OLD, NOW]), undefined);
});

test("an answer the Claude app remembered for the account names its workspace outright", () => {
  const config = {
    // The older workspace was refreshed last: the remembered pair still wins.
    [`dxt:allowlistLastUpdated:${OLD}`]: "2026-11-10T10:00:00.000Z",
    [`dxt:allowlistLastUpdated:${NOW}`]: "2026-08-11T10:00:00.000Z",
    sshTransportFlagLastAnswer: { accountUuid: ACCOUNT.toUpperCase(), orgUuid: NOW, on: true },
  };
  assert.deepEqual(activeOrgHint(config, ACCOUNT, [OLD, NOW]), { orgId: NOW, certain: true });
  // Another account's answer, or a workspace this account does not have, says nothing certain.
  assert.deepEqual(activeOrgHint(config, OTHER, [OLD, NOW]), { orgId: OLD, certain: false });
  assert.deepEqual(
    activeOrgHint({ ...config, sshTransportFlagLastAnswer: { accountUuid: ACCOUNT, orgUuid: THIRD } }, ACCOUNT, [OLD, NOW]),
    { orgId: OLD, certain: false },
  );
});

test("without one, the workspace the app refreshed last is the hint, certain only for this sign-in", () => {
  const config = {
    [`dxt:allowlistLastUpdated:${OLD}`]: "2026-08-11T10:06:35.679Z",
    [`dxt:allowlistLastUpdated:${NOW}`]: "2026-11-10T10:35:48.365Z",
    [`dxt:allowlistLastUpdated:${THIRD}`]: "2026-11-10T11:00:00.000Z",
    [`dxt:allowlistEnabled:${NOW}`]: false,
    "dxt:allowlistLastUpdated:not-a-workspace": "2026-11-10T12:00:00.000Z",
  };
  // THIRD is not one of the account's workspaces, however recent.
  assert.deepEqual(activeOrgHint(config, ACCOUNT, [OLD, NOW]), { orgId: NOW, certain: false });
  const signInBegan = Date.parse("2026-11-10T10:35:15.000Z");
  assert.deepEqual(activeOrgHint(config, ACCOUNT, [OLD, NOW], signInBegan), { orgId: NOW, certain: true });
  // Refreshed before the sign-in began: it may be left from an earlier account.
  assert.deepEqual(
    activeOrgHint(config, ACCOUNT, [OLD, NOW], Date.parse("2026-11-10T10:40:00.000Z")),
    { orgId: NOW, certain: false },
  );
  assert.equal(activeOrgHint({ [`dxt:allowlistLastUpdated:${NOW}`]: "soon" }, ACCOUNT, [OLD, NOW]), undefined);
});
