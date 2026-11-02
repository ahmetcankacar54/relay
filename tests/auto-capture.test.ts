import test from "node:test";
import assert from "node:assert/strict";
import type { Account, DesktopState } from "../shared/types";
import { readSignIn } from "../electron/core/sign-in-wait";
import { AUTO_CAPTURE_LIMIT_MS, AutoCapture } from "../electron/core/auto-capture";

const NEW = "00000000-0000-4000-8000-0000000000a1";
const OLD = "00000000-0000-4000-8000-0000000000b2";
const ORG = "00000000-0000-4000-8000-0000000000c3";
const ORG2 = "00000000-0000-4000-8000-0000000000d4";
const account = (id: string, uuid?: string) =>
  ({ id, name: `Acc ${id}`, ...(uuid ? { desktop: { accountUuid: uuid, orgId: ORG, savedAt: "" } } : {}) }) as unknown as Account;
const state = (patch: Partial<DesktopState> = {}) =>
  ({ available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, ...patch }) as DesktopState;

test("a sign-in is ready once a new account is signed in and Code has a workspace", () => {
  const accounts = [account("p"), account("q", OLD)];
  assert.deepEqual(readSignIn(state({ pendingProfileId: "p" }), accounts, "p"), { kind: "waiting" });
  assert.deepEqual(readSignIn(state({ pendingProfileId: "p", currentAccountUuid: NEW }), accounts, "p"), { kind: "waiting" });
  assert.deepEqual(readSignIn(state({ pendingProfileId: "p", currentAccountUuid: NEW, organizations: [ORG] }), accounts, "p"), {
    kind: "ready", accountUuid: NEW, orgs: [ORG],
  });
  // The first account: open in Claude and never saved, with no pending sign-in.
  assert.equal(readSignIn(state({ currentAccountUuid: NEW, organizations: [ORG] }), accounts, "p").kind, "ready");
  assert.equal(readSignIn(state({ pendingProfileId: "p", currentAccountUuid: OLD, organizations: [ORG] }), accounts, "p").kind, "saved-elsewhere");
  assert.equal(readSignIn(state({ pendingProfileId: "q" }), accounts, "p").kind, "other-pending");
  // A renewed sign-in of the profile's own account is saved again; without a pending one it is done.
  assert.equal(readSignIn(state({ pendingProfileId: "q", currentAccountUuid: OLD, organizations: [ORG] }), accounts, "q").kind, "ready");
  assert.equal(readSignIn(state({ currentAccountUuid: OLD, organizations: [ORG] }), accounts, "q").kind, "done");
});

function harness(readings: DesktopState[], accounts = [account("p")], fail?: Error) {
  let now = 0;
  let i = 0;
  const captures: [string, string][] = [];
  let changes = 0;
  const auto = new AutoCapture({
    snapshot: async () => readings[Math.min(i++, readings.length - 1)],
    accounts: () => accounts,
    capture: async (id, org) => {
      captures.push([id, org]);
      if (fail) throw fail;
    },
    changed: () => void changes++,
    now: () => now,
  });
  return { auto, captures, advance: (ms: number) => void (now += ms), changes: () => changes };
}

test("the sign-in is saved by itself at the first tick that finds it ready, once", async () => {
  const h = harness([
    state({ pendingProfileId: "p" }),
    state({ pendingProfileId: "p", currentAccountUuid: NEW, organizations: [ORG] }),
  ]);
  await h.auto.tick();
  assert.equal(h.auto.state(), undefined, "nothing happens before it is armed");
  h.auto.arm("p");
  await h.auto.tick();
  assert.equal(h.auto.state()?.status, "waiting");
  await h.auto.tick();
  assert.deepEqual(h.captures, [["p", ORG]]);
  assert.deepEqual(h.auto.state(), { accountId: "p", status: "saved" });
  await h.auto.tick();
  assert.equal(h.captures.length, 1);
});

test("several workspaces wait for the user's pick; a saved account signed in instead is named", async () => {
  const h = harness([
    state({ pendingProfileId: "p", currentAccountUuid: OLD, organizations: [ORG] }),
    state({ pendingProfileId: "p", currentAccountUuid: NEW, organizations: [ORG, ORG2] }),
  ], [account("p"), account("q", OLD)]);
  h.auto.arm("p");
  await h.auto.tick();
  assert.deepEqual(h.auto.state(), { accountId: "p", status: "waiting", alreadySaved: "Acc q" });
  await h.auto.tick();
  assert.deepEqual(h.auto.state(), { accountId: "p", status: "choose-org", orgs: [ORG, ORG2] });
  await assert.rejects(h.auto.choose("p", "00000000-0000-4000-8000-0000000000ff"));
  await h.auto.choose("p", ORG2);
  assert.deepEqual(h.captures, [["p", ORG2]]);
  assert.equal(h.auto.state()?.status, "saved");
});

test("a failed save, a sign-in pending for another profile and the time limit end the wait", async () => {
  const failing = harness([state({ pendingProfileId: "p", currentAccountUuid: NEW, organizations: [ORG] })], undefined, new Error("Claude is still running."));
  failing.auto.arm("p");
  await failing.auto.tick();
  assert.deepEqual(failing.auto.state(), { accountId: "p", status: "failed", error: "Claude is still running." });
  const other = harness([state({ pendingProfileId: "x" })]);
  other.auto.arm("p");
  await other.auto.tick();
  assert.equal(other.auto.state()?.error, "other-pending");
  const slow = harness([state({ pendingProfileId: "p" })]);
  slow.auto.arm("p");
  slow.advance(AUTO_CAPTURE_LIMIT_MS + 1);
  await slow.auto.tick();
  assert.equal(slow.auto.state()?.error, "timeout");
  slow.auto.disarm("someone-else");
  assert.ok(slow.auto.state());
  slow.auto.disarm();
  assert.equal(slow.auto.state(), undefined);
});
