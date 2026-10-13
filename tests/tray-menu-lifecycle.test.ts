import test from "node:test";
import assert from "node:assert/strict";
import { TrayMenuLifecycle } from "../electron/core/tray-menu-lifecycle";

function fixture() {
  const applied: { value: string; generation: number }[] = [];
  const scheduled: (() => void)[] = [];
  const errors: unknown[] = [];
  const lifecycle = new TrayMenuLifecycle<string>({
    apply: (value, generation) => applied.push({ value, generation }),
    schedule: (callback) => scheduled.push(callback),
    onApplyError: (error) => errors.push(error),
  });
  const update = (value: string) => lifecycle.update(value, value);
  const flush = () => {
    const callbacks = scheduled.splice(0);
    for (const callback of callbacks) callback();
  };
  const current = () => applied.at(-1)!.generation;
  return { lifecycle, applied, errors, scheduled, update, flush, current };
}

test("unchanged polls retain the same native menu before and during tracking", () => {
  const f = fixture();
  f.update("A");
  for (let poll = 0; poll < 20; poll++) f.update("A");
  const generation = f.current();
  f.lifecycle.opened(generation);
  for (let poll = 0; poll < 20; poll++) f.update("A");
  assert.deepEqual(f.applied, [{ value: "A", generation }]);
  f.lifecycle.closed(generation);
  f.flush();
  assert.equal(f.applied.length, 1);
});

test("an open menu defers replacements and applies only the newest poll after close", () => {
  const f = fixture();
  f.update("A");
  const generation = f.current();
  f.lifecycle.opened(generation);
  f.update("B");
  f.update("C");
  assert.equal(f.applied.length, 1);
  f.lifecycle.closed(generation);
  assert.equal(f.applied.length, 1, "never replace inside the close callback");
  f.update("D");
  assert.equal(f.applied.length, 1, "another close listener must also defer");
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A", "D"],
  );
});

test("the latest poll reverting to current content clears an older pending change", () => {
  const f = fixture();
  f.update("A");
  const generation = f.current();
  f.lifecycle.opened(generation);
  f.update("B");
  f.update("A");
  f.lifecycle.closed(generation);
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A"],
  );
});

test("a changed poll arriving after close still waits for the next event-loop turn", () => {
  const f = fixture();
  f.update("A");
  f.lifecycle.opened(f.current());
  f.lifecycle.closed(f.current());
  f.update("B");
  assert.equal(f.applied.length, 1);
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A", "B"],
  );
});

test("callbacks from replaced menus cannot defer or flush the current menu", () => {
  const f = fixture();
  f.update("A");
  const old = f.current();
  f.update("B");
  const current = f.current();
  f.lifecycle.opened(old);
  f.lifecycle.closed(old);
  f.update("C");
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A", "B", "C"],
  );
  f.lifecycle.opened(f.current());
  f.update("D");
  f.lifecycle.closed(current);
  f.flush();
  assert.equal(f.applied.at(-1)!.value, "C");
  f.lifecycle.closed(f.current());
  f.flush();
  assert.equal(f.applied.at(-1)!.value, "D");
});

test("reopening before a scheduled replacement keeps it pending until the next close", () => {
  const f = fixture();
  f.update("A");
  const generation = f.current();
  f.lifecycle.opened(generation);
  f.update("B");
  f.lifecycle.closed(generation);
  f.lifecycle.opened(generation);
  f.flush();
  assert.equal(f.applied.length, 1);
  f.update("C");
  f.lifecycle.closed(generation);
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A", "C"],
  );
});

test("destruction invalidates queued replacements and late native callbacks", () => {
  const f = fixture();
  f.update("A");
  const generation = f.current();
  f.lifecycle.opened(generation);
  f.update("B");
  f.lifecycle.closed(generation);
  f.lifecycle.destroy();
  f.lifecycle.opened(generation);
  f.lifecycle.closed(generation);
  f.update("C");
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["A"],
  );
});

test("snapshot error fallback is deferred, deduplicated, and superseded by recovery", () => {
  const f = fixture();
  f.update("ready");
  f.lifecycle.opened(f.current());
  f.update("fallback: only open and quit");
  f.update("fallback: only open and quit");
  assert.equal(f.applied.length, 1);
  f.lifecycle.closed(f.current());
  f.flush();
  assert.equal(f.applied.at(-1)!.value, "fallback: only open and quit");
  f.lifecycle.opened(f.current());
  f.update("fallback: only open and quit");
  f.update("recovered");
  f.lifecycle.closed(f.current());
  f.flush();
  assert.deepEqual(
    f.applied.map((menu) => menu.value),
    ["ready", "fallback: only open and quit", "recovered"],
  );
});

test("a failed native install retains current identity and reports deferred errors", () => {
  const applied: { value: string; generation: number }[] = [];
  const scheduled: (() => void)[] = [];
  const errors: unknown[] = [];
  const expected = new Error("native install unavailable");
  const lifecycle = new TrayMenuLifecycle<string>({
    apply: (value, generation) => {
      if (value === "bad") throw expected;
      applied.push({ value, generation });
    },
    schedule: (callback) => scheduled.push(callback),
    onApplyError: (error) => errors.push(error),
  });
  lifecycle.update("A", "A");
  const generation = applied[0].generation;
  assert.throws(() => lifecycle.update("bad", "bad"), expected);
  lifecycle.opened(generation);
  lifecycle.update("bad", "bad");
  lifecycle.closed(generation);
  for (const callback of scheduled.splice(0)) callback();
  assert.deepEqual(errors, [expected]);
  lifecycle.update("A", "A");
  assert.equal(applied.length, 1);
  lifecycle.update("recovered", "recovered");
  assert.equal(applied.at(-1)!.value, "recovered");
});
