import test from "node:test";
import assert from "node:assert/strict";
import { attemptAction, relayAction, relayReport, serialRead } from "../src/data/relay-action";

test("a second action while one runs is ignored and errors are shown", async () => {
  const lock = { current: false };
  const busy: string[] = [];
  const errors: string[] = [];
  let release!: () => void;
  const run = relayAction(lock, {
    setBusy: (k) => busy.push(k), setError: () => {}, setNotice: () => {},
    refresh: async () => {}, showError: (e) => errors.push(String(e)),
  });
  let second = false;
  const first = run("a", () => new Promise<void>((r) => (release = r)));
  await run("b", async () => { second = true; });
  assert.equal(second, false);
  release();
  await first;
  assert.deepEqual(busy, ["a", ""]);
  await run("c", async () => { throw new Error("boom"); });
  assert.deepEqual(errors, ["Error: boom"]);
  assert.equal(lock.current, false);
});

test("an action resolves false while the lock is held, true once it ran, false after an error", async () => {
  const lock = { current: false };
  const run = relayAction(lock, {
    setBusy() {}, setError() {}, setNotice() {},
    refresh: async () => {}, showError() {},
  });
  let release!: () => void;
  const first = run("a", () => new Promise<void>((r) => (release = r)));
  assert.equal(lock.current, true);
  let ran = false;
  assert.equal(await run("b", async () => { ran = true; }), false);
  assert.equal(ran, false);
  release();
  assert.equal(await first, true);
  assert.equal(await run("c", async () => { throw new Error("boom"); }), false);
  assert.equal(await run("d", async () => {}), true);
});

test("an action that ran stays true when only the refresh after it failed", async () => {
  const errors: unknown[] = [];
  const run = relayAction({ current: false }, {
    setBusy() {}, setError() {}, setNotice() {},
    refresh: async () => { throw new Error("offline"); },
    showError: (e) => errors.push(e),
  });
  assert.equal(await run("a", async () => {}), true);
  assert.equal(errors.length, 1);
});

test("report runs while an action holds the lock and shows its failure", async () => {
  const lock = { current: false };
  const errors: unknown[] = [];
  const deps = {
    setBusy() {}, setError() {}, setNotice() {},
    refresh: async () => {}, showError: (e: unknown) => void errors.push(e),
  };
  const action = relayAction(lock, deps);
  const report = relayReport(deps.showError);
  let release!: () => void;
  const held = action("switch:a", () => new Promise<void>((r) => (release = r)));
  assert.equal(lock.current, true);
  let opened = false;
  await report(async () => { opened = true; });
  assert.equal(opened, true);
  await report(async () => { throw new Error("no window"); });
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /no window/);
  // The running action was not touched.
  assert.equal(lock.current, true);
  release();
  assert.equal(await held, true);
});

test("attemptAction tells a refused call from a failed one", async () => {
  const lock = { current: false };
  const attempt = attemptAction(relayAction(lock, {
    setBusy() {}, setError() {}, setNotice() {},
    refresh: async () => {}, showError() {},
  }));
  assert.equal(await attempt("a", async () => {}), "ran");
  assert.equal(await attempt("b", async () => { throw new Error("boom"); }), "failed");
  lock.current = true;
  let ran = false;
  assert.equal(await attempt("c", async () => { ran = true; }), "refused");
  assert.equal(ran, false);
});

test("a read that started before an action's change does not apply once the action queued a follow-up", async () => {
  const epoch = { current: 0 };
  const reads: ((value: string) => void)[] = [];
  const applied: string[] = [];
  const refresh = serialRead(epoch, () => new Promise<string>((r) => reads.push(r)), (v) => void applied.push(v));
  // A poll reads the state from before the action's change ...
  const poll = refresh();
  // ... and the action's refresh after its change waits for it, as one follow-up.
  const followUp = refresh();
  assert.equal(refresh(), followUp);
  assert.equal(reads.length, 1);
  reads[0]("before");
  assert.equal(await poll, "before");
  await new Promise((r) => setImmediate(r));
  assert.equal(reads.length, 2);
  assert.deepEqual(applied, [], "the poll's stale state is never shown");
  reads[1]("after");
  assert.equal(await followUp, "after");
  assert.deepEqual(applied, ["after"]);
  // A lone read applies; one that started before a local change does not.
  const lone = refresh();
  reads[2]("again");
  await lone;
  assert.deepEqual(applied, ["after", "again"]);
  const dropped = refresh();
  epoch.current++;
  reads[3]("old");
  await dropped;
  assert.deepEqual(applied, ["after", "again"]);
});
