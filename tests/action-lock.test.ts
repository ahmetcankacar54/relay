import test from "node:test";
import assert from "node:assert/strict";
import { relayAction } from "../src/data/relay-action";

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
