import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pickSignIn, sameSignIn, signInAccount, SIGN_IN_KEYS } from "../shared/extension-auth";
import {
  chooseInstance,
  localStateProfiles,
  startupRestores,
} from "../shared/browser-extension";
import { signInFor } from "./extension-world";

test("the sign-in is the sign-in keys and nothing else", () => {
  const uuid = randomUUID();
  const entries: [string, string][] = [
    ...Object.entries(signInFor(uuid)),
    ["savedPrompts", '["a prompt"]'],
    ["conversationCache", "{}"],
  ];
  const picked = pickSignIn(entries)!;
  assert.deepEqual(Object.keys(picked).sort(), [...SIGN_IN_KEYS].sort());
  assert.equal(signInAccount(picked), uuid);
});

test("an upper-case account uuid reads as lower case", () => {
  const uuid = randomUUID();
  assert.equal(signInAccount(signInFor(uuid.toUpperCase())), uuid);
});

test("a store without an account, without a token, or with a bad uuid is not signed in", () => {
  const good = signInFor(randomUUID());
  assert.ok(pickSignIn(Object.entries(good)));
  assert.equal(pickSignIn([]), undefined);
  assert.equal(pickSignIn(Object.entries({ ...good, accountUuid: undefined as any })), undefined);
  assert.equal(
    pickSignIn(Object.entries({ ...good, accountUuid: JSON.stringify("not-a-uuid") })),
    undefined,
  );
  assert.equal(
    pickSignIn(Object.entries({ ...good, accountUuid: "not json{" })),
    undefined,
  );
  const { accessToken, refreshToken, ...noTokens } = good;
  assert.equal(pickSignIn(Object.entries(noTokens)), undefined);
  // Either token is enough to count as signed in.
  assert.ok(pickSignIn(Object.entries({ ...noTokens, refreshToken })));
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
