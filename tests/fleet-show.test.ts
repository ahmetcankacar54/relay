import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTINUE_OPENS,
  CONTINUE_REOPEN_MS,
  CONTINUE_SHOW_MS,
  waitForConversation,
  type ShowDeps,
} from "../electron/core/fleet-show";
import type { DesktopAutomationSnapshot } from "../electron/core/desktop-continuation-host";

const TARGET = "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "local_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function view(place: string, idleMs = 60_000): DesktopAutomationSnapshot {
  return {
    observedAt: 1,
    pid: 1,
    localSessionId: place,
    accountLabel: "A",
    permissionMode: "Auto",
    status: "stopped",
    quotaStopped: false,
    composerEmpty: true,
    sendEnabled: false,
    contextFingerprint: "a".repeat(64),
    coverage: "active-conversation-only",
    idleMs,
  };
}

function harness(screen: (opened: number) => DesktopAutomationSnapshot) {
  const clock = { now: 0 };
  const opens: number[] = [];
  let movedAt = Infinity;
  const deps: ShowDeps = {
    inspect: async () => screen(opens.length),
    open: async () => {
      opens.push(clock.now);
    },
    booted: async () => true,
    unchanged: () => clock.now < movedAt,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  };
  return {
    clock,
    opens,
    deps,
    moveAt: (ms: number) => {
      movedAt = ms;
    },
  };
}

test("a conversation that shows is continued once the user is idle, after one link", async () => {
  const h = harness((opened) => view(opened ? TARGET : OTHER));
  const result = await waitForConversation(TARGET, h.deps);
  assert.ok("shown" in result);
  assert.deepEqual(h.opens, [0]);
});

test("links go at most three times, 30 s apart, never every few seconds", async () => {
  // Seen 2026-10-27 in split view: the conversation never came into focus, and a link every
  // 5 s for 3 minutes reloaded Claude under the user.
  const h = harness(() => view(OTHER));
  const result = await waitForConversation(TARGET, h.deps);
  assert.deepEqual(result, { skipped: "not-shown", last: view(OTHER), opened: CONTINUE_OPENS });
  assert.equal(h.opens.length, CONTINUE_OPENS);
  for (let i = 1; i < h.opens.length; i++)
    assert.ok(h.opens[i] - h.opens[i - 1] >= CONTINUE_REOPEN_MS);
  assert.ok(h.clock.now >= CONTINUE_SHOW_MS);
});

test("while the user works in Claude no link goes and nothing is taken as shown", async () => {
  const busy = harness(() => view(OTHER, 1_000));
  const result = await waitForConversation(TARGET, busy.deps);
  assert.equal("skipped" in result && result.skipped, "user-active");
  assert.equal(busy.opens.length, 0);
  // On screen, but the user is typing: it waits for a pause.
  const clock = { now: 0 };
  const shown = harness(() => view(TARGET, clock.now < 10_000 ? 500 : 9_000));
  shown.deps.now = () => clock.now;
  shown.deps.sleep = async (ms) => {
    clock.now += ms;
  };
  assert.ok("shown" in (await waitForConversation(TARGET, shown.deps)));
  assert.equal(clock.now, 10_000);
});

test("a conversation the user continued by hand ends the wait at once, with no more links", async () => {
  const h = harness(() => view(OTHER));
  h.moveAt(10_000);
  const result = await waitForConversation(TARGET, h.deps);
  assert.equal("skipped" in result && result.skipped, "moved-on");
  assert.equal(h.opens.length, 1);
  assert.ok(h.clock.now < 20_000);
  // Moved on before the first look: no link at all.
  const early = harness(() => view(OTHER));
  early.moveAt(0);
  assert.equal(
    "skipped" in (await waitForConversation(TARGET, early.deps)) && early.opens.length,
    0,
  );
});
