import test from "node:test";
import assert from "node:assert/strict";
import {
  placeTray,
  TRAY_GUID,
  TRAY_START_POSITION,
  type TrayDefaults,
} from "../electron/core/tray-place";

function defaults(saved: Record<string, number> = {}) {
  const writes: Array<[string, number]> = [];
  const store: TrayDefaults = {
    // As NSUserDefaults: a float never set reads 0.
    getUserDefault: (key) => saved[key] ?? 0,
    setUserDefault: (key, _type, value) => {
      saved[key] = value;
      writes.push([key, value]);
    },
  };
  return { store, writes, saved };
}

test("an item never placed starts right of the notch, under its own id", () => {
  const d = defaults();
  placeTray(d.store);
  assert.deepEqual(d.writes, [
    [`NSStatusItem Preferred Position ${TRAY_GUID}`, TRAY_START_POSITION],
  ]);
});

test("a place kept from an earlier start, or the user's drag, is left as it is", () => {
  const d = defaults({ [`NSStatusItem Preferred Position ${TRAY_GUID}`]: 812.5 });
  placeTray(d.store);
  assert.deepEqual(d.writes, []);
});

test("defaults that cannot be read leave the item where AppKit puts it", () => {
  assert.doesNotThrow(() =>
    placeTray({
      getUserDefault: () => {
        throw new Error("no defaults");
      },
      setUserDefault: () => {
        throw new Error("no defaults");
      },
    }),
  );
});
