import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CODE_TAB_LINK, openCodeTab, type CodeTabDeps } from "../electron/core/code-tab";

function world(booted: (t: number) => boolean | undefined, running = true) {
  let now = 0;
  const calls: string[] = [];
  const deps: CodeTabDeps = {
    open: async () => void calls.push("open"),
    booted: async () => booted(now),
    running: async () => running,
    openLink: async (url) => void calls.push(url),
    sleep: async (ms) => void (now += ms),
    now: () => now,
  };
  return { deps, calls, at: () => now };
}

test("the Code link waits for Claude's page to boot, so it does not restart the boot", async () => {
  const w = world((t) => t >= 3_000);
  assert.equal(await openCodeTab(w.deps), "opened");
  assert.deepEqual(w.calls, ["open", CODE_TAB_LINK]);
  assert.ok(w.at() >= 3_000);
});

test("a Claude whose log cannot tell gets a short grace; one that never boots gets no link", async () => {
  const untold = world(() => undefined);
  assert.equal(await openCodeTab(untold.deps), "opened");
  assert.ok(untold.at() >= 4_000 && untold.at() < 6_000);
  const stuck = world(() => false);
  assert.equal(await openCodeTab(stuck.deps, 10_000), "timeout");
  assert.deepEqual(stuck.calls, ["open"]);
});

test("the main process opens only the fixed Code link through its own channel", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const start = main.indexOf('handle("open-code-tab"');
  const handler = main.slice(start, main.indexOf("handle(", start + 10));
  assert.match(handler, /manualDesktopLock/);
  assert.match(handler, /openLink: \(url\) => shell\.openExternal\(url\)/);
  assert.equal(CODE_TAB_LINK, "claude://code/new");
});
