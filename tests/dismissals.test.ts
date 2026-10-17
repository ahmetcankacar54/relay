import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  dismissalAccountId,
  dismissalKey,
  getDismissals,
  pruneDismissals,
  resetDismissalsForTests,
  subscribeDismissals,
  useDismissals,
} from "../src/data/dismissals";

const STORAGE_KEY = "relay.dismissed.v1";

/** A Storage that remembers what it was asked, so a test can see a write or the lack of one. */
function fakeStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  return {
    items,
    writes,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => {
      items.set(key, value);
      writes.push([key, value]);
    },
  };
}

const install = (localStorage: unknown) =>
  Object.assign(globalThis, {
    window: {
      get localStorage() {
        if (localStorage instanceof Error) throw localStorage;
        return localStorage;
      },
    },
  });

beforeEach(() => resetDismissalsForTests());
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  resetDismissalsForTests();
});

/** What a component sees from the hook. Rendering is enough: nothing here needs an effect. */
function mount() {
  let seen: ReturnType<typeof useDismissals> | undefined;
  function Probe() {
    seen = useDismissals();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.ok(seen);
  return seen;
}

test("a dismissal key joins the account and the issue", () => {
  assert.equal(dismissalKey("a1", "expired"), "a1:expired");
});

test("the account id is the part of a key before the first colon", () => {
  assert.equal(dismissalAccountId(dismissalKey("a1", "expired")), "a1");
  assert.equal(dismissalAccountId("a1:renewal-required"), "a1");
  assert.equal(dismissalAccountId("a1:odd:issue"), "a1");
  assert.equal(dismissalAccountId("no-colon"), "no-colon");
});

test("a dismissed key survives a remount and a reload", () => {
  const storage = fakeStorage();
  install(storage);
  assert.deepEqual([...mount().dismissed], []);
  mount().dismiss(dismissalKey("a", "expired"));
  // Another mounted Banners (another page) sees it at once: the store is shared.
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
  assert.equal(storage.items.get(STORAGE_KEY), JSON.stringify(["a:expired"]));
  // A reload forgets the memory and reads the storage again.
  resetDismissalsForTests();
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
});

test("dismissing the same key twice writes once", () => {
  const storage = fakeStorage();
  install(storage);
  mount().dismiss("a:expired");
  mount().dismiss("a:expired");
  assert.equal(storage.writes.length, 1);
});

test("prune removes a key whose issue is gone and keeps one that is still current", () => {
  const storage = fakeStorage();
  install(storage);
  mount().dismiss("a:expired");
  mount().dismiss("b:scope");
  pruneDismissals(["a:expired", "c:keychain-locked"]);
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
  assert.equal(storage.items.get(STORAGE_KEY), JSON.stringify(["a:expired"]));
  resetDismissalsForTests();
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
});

test("a prune that changes nothing neither writes nor tells anyone", () => {
  const storage = fakeStorage();
  install(storage);
  mount().dismiss("a:expired");
  const writes = storage.writes.length;
  let told = 0;
  const stop = subscribeDismissals(() => void told++);
  pruneDismissals(["a:expired", "b:scope"]);
  pruneDismissals(["a:expired"]);
  assert.equal(storage.writes.length, writes);
  assert.equal(told, 0);
  const before = getDismissals();
  pruneDismissals([]);
  assert.equal(told, 1);
  assert.notEqual(
    getDismissals(),
    before,
    "a change gives React a new snapshot",
  );
  stop();
  mount().dismiss("x:scope");
  assert.equal(told, 1, "an unsubscribed listener hears nothing");
});

test("every dismissal tells the subscribers once and gives a new snapshot", () => {
  install(fakeStorage());
  let told = 0;
  const stop = subscribeDismissals(() => void told++);
  const before = getDismissals();
  assert.equal(
    getDismissals(),
    before,
    "the snapshot is stable between changes",
  );
  mount().dismiss("a:expired");
  assert.equal(told, 1);
  assert.notEqual(getDismissals(), before);
  stop();
});

test("a storage that throws falls back to memory", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("full");
    },
  };
  for (const storage of [
    broken,
    new Error("no storage in this window"),
    undefined,
  ]) {
    resetDismissalsForTests();
    install(storage);
    mount().dismiss("a:expired");
    assert.deepEqual([...mount().dismissed], ["a:expired"], String(storage));
    pruneDismissals(["b:scope"]);
    assert.deepEqual([...mount().dismissed], [], String(storage));
  }
});

test("a window without a localStorage property keeps working in memory", () => {
  Reflect.deleteProperty(globalThis, "window");
  mount().dismiss("a:expired");
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
});

test("a stored value that is not a list of keys is ignored", () => {
  for (const raw of [
    "not json",
    "{}",
    "42",
    "null",
    '["a:expired",3,null,{"k":1}]',
  ]) {
    resetDismissalsForTests();
    install(fakeStorage({ [STORAGE_KEY]: raw }));
    assert.deepEqual(
      [...mount().dismissed],
      raw.startsWith("[") ? ["a:expired"] : [],
      raw,
    );
  }
});

test("resetting the store does not touch the storage", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: '["a:expired"]' });
  install(storage);
  assert.deepEqual([...mount().dismissed], ["a:expired"]);
  resetDismissalsForTests();
  assert.equal(storage.writes.length, 0);
  assert.equal(storage.items.get(STORAGE_KEY), '["a:expired"]');
});

test("prune keeps the keys of accounts whose issue is not known yet", () => {
  const storage = fakeStorage();
  install(storage);
  for (const key of [
    "a:expired",
    "b:renewal-required",
    "c:scope",
    "d:keychain-locked",
  ])
    mount().dismiss(key);
  // a and b have not been read yet: their keys stay, whatever the current list says.
  pruneDismissals(["d:keychain-locked"], ["a", "b"]);
  assert.deepEqual([...mount().dismissed].sort(), [
    "a:expired",
    "b:renewal-required",
    "d:keychain-locked",
  ]);
  resetDismissalsForTests();
  assert.deepEqual([...mount().dismissed].sort(), [
    "a:expired",
    "b:renewal-required",
    "d:keychain-locked",
  ]);
  // Once a is read, it prunes like any other account.
  pruneDismissals(["d:keychain-locked"], ["b"]);
  assert.deepEqual([...mount().dismissed].sort(), [
    "b:renewal-required",
    "d:keychain-locked",
  ]);
  // Without the list it prunes everything that is not current, as before.
  pruneDismissals([]);
  assert.deepEqual([...mount().dismissed], []);
});

test("dismissMany adds several keys with one write and one notification", () => {
  const storage = fakeStorage();
  install(storage);
  mount().dismiss("a:expired");
  const writes = storage.writes.length;
  let told = 0;
  const stop = subscribeDismissals(() => void told++);
  mount().dismissMany(["a:expired", "b:scope", "c:keychain-locked", "b:scope"]);
  assert.deepEqual(
    [...mount().dismissed],
    ["a:expired", "b:scope", "c:keychain-locked"],
  );
  assert.equal(storage.writes.length, writes + 1);
  assert.equal(told, 1);
  assert.equal(
    storage.items.get(STORAGE_KEY),
    JSON.stringify(["a:expired", "b:scope", "c:keychain-locked"]),
  );
  // Nothing new, nothing written or told.
  mount().dismissMany(["a:expired", "c:keychain-locked"]);
  mount().dismissMany([]);
  assert.equal(storage.writes.length, writes + 1);
  assert.equal(told, 1);
  stop();
});
