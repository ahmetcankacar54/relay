import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { holdsToken, namedAccount, pickSignIn, sameSignIn } from "../shared/extension-auth";
import {
  chooseInstance,
  localStateProfiles,
  startupRestores,
} from "../shared/browser-extension";
import { signInFor } from "./extension-world";

test("the sign-in is its own entries, found by name or by a token, with the account it names", () => {
  const uuid = randomUUID();
  const entries: [string, string][] = [
    ...Object.entries(signInFor(uuid)),
    ["savedPrompts", '["a prompt"]'],
    ["conversationCache", "{}"],
  ];
  const picked = pickSignIn(entries, [uuid, randomUUID()])!;
  assert.deepEqual(Object.keys(picked.signIn).sort(), ["accessToken", "accountUuid", "refreshToken", "tokenExpiry"]);
  assert.equal(picked.account, uuid);
});

test("key names need not be known: a nested sign-in under any key is found", () => {
  const uuid = randomUUID();
  const state = JSON.stringify({ access_token: "sk-ant-oat01-ABCDEFGHIJKL", refresh_token: "sk-ant-ort01-ABCDEFGHIJKL", account: { uuid: uuid.toUpperCase() } });
  const entries: [string, string][] = [["persistedState", state], ["tabGroups", "[]"], ["theme", '"dark"']];
  const picked = pickSignIn(entries, [uuid])!;
  assert.equal(picked.account, uuid);
  assert.deepEqual(Object.keys(picked.signIn), ["persistedState"]);
  // A bare token value under an odd name counts too.
  assert.ok(holdsToken([["x", '"sk-ant-oat01-ABCDEFGHIJKLMN"']]));
});

test("signed out: no token anywhere, even with an account uuid left behind", () => {
  const uuid = randomUUID();
  assert.equal(pickSignIn([], [uuid]), undefined);
  assert.equal(pickSignIn([["lastAccountUuid", JSON.stringify(uuid)], ["oauthState", '"abc"']], [uuid]), undefined);
  assert.equal(pickSignIn([["accessToken", "null"], ["refreshToken", '""']], [uuid]), undefined);
});

test("an account Relay does not have, or two it cannot tell apart, names no account", () => {
  const a = randomUUID();
  const b = randomUUID();
  const stranger = pickSignIn(Object.entries(signInFor(randomUUID())), [a, b])!;
  assert.ok(stranger);
  assert.equal(stranger.account, undefined);
  // Both named, one in an account key: that one.
  assert.equal(namedAccount([["accountUuid", JSON.stringify(a)], ["recent", JSON.stringify([a, b])]], [a, b]), a);
  // Both named, neither in an account key: none.
  assert.equal(namedAccount([["recent", JSON.stringify([a, b])]], [a, b]), undefined);
});

test("two sign-ins are the same only when every key is", () => {
  const uuid = randomUUID();
  assert.ok(sameSignIn(signInFor(uuid, 1), signInFor(uuid, 1)));
  assert.ok(!sameSignIn(signInFor(uuid, 1), signInFor(uuid, 2)));
  const { tokenExpiry, ...fewer } = signInFor(uuid, 1);
  assert.ok(!sameSignIn(signInFor(uuid, 1), fewer));
});

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
  const brave = { app: "brave", profile: "Default", name: "A" } as const;
  const chrome = { app: "chrome", profile: "Default", name: "B" } as const;
  assert.equal(chooseInstance([brave], undefined), brave);
  assert.equal(chooseInstance([brave, chrome], undefined), undefined);
  assert.equal(chooseInstance([brave, chrome], { app: "chrome", profile: "Default" }), chrome);
  // A chosen instance that is gone does not pick another of several.
  assert.equal(chooseInstance([brave, chrome], { app: "edge", profile: "Default" }), undefined);
  assert.equal(chooseInstance([], undefined), undefined);
});
