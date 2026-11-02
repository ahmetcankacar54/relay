import test from "node:test";
import assert from "node:assert/strict";
import { refreshTray, type TrayRefreshSteps } from "../electron/core/tray-refresh";

type Snapshot = { name: string };

function steps(overrides: Partial<TrayRefreshSteps<Snapshot>> = {}) {
  const calls: string[] = [];
  const all: TrayRefreshSteps<Snapshot> = {
    current: () => true,
    snapshot: async () => ({ name: "healthy" }),
    mascot: {
      next: (s) => void calls.push(`mascot:${s.name}`),
      unavailable: () => void calls.push("mascot:unavailable"),
    },
    show: (s) => void calls.push(`show:${s.name}`),
    unavailable: () => void calls.push("menu:unavailable"),
    ...overrides,
  };
  return { all, calls };
}

test("a healthy snapshot feeds the panda and the menu", async () => {
  const { all, calls } = steps();
  await refreshTray(all);
  assert.deepEqual(calls, ["mascot:healthy", "show:healthy"]);
});

test("a throwing panda never takes down a healthy menu or rejects", async () => {
  const { all, calls } = steps();
  all.mascot = {
    next: () => {
      throw new Error("tray image refused");
    },
    unavailable: () => void calls.push("mascot:unavailable"),
  };
  await refreshTray(all);
  assert.deepEqual(calls, ["show:healthy"]);
});

test("a failing menu build falls back without telling the panda the snapshot failed", async () => {
  const { all, calls } = steps();
  all.show = () => {
    throw new Error("menu");
  };
  await refreshTray(all);
  assert.deepEqual(calls, ["mascot:healthy", "menu:unavailable"]);
});

test("a failing snapshot rests the panda and shows the fallback menu", async () => {
  for (const snapshot of [
    async () => {
      throw new Error("unreadable");
    },
    () => {
      throw new Error("sync");
    },
  ]) {
    const { all, calls } = steps({ snapshot });
    await refreshTray(all);
    assert.deepEqual(calls, ["mascot:unavailable", "menu:unavailable"]);
  }
});

test("nothing rejects even when every step throws", async () => {
  const boom = () => {
    throw new Error("boom");
  };
  await refreshTray({
    current: () => true,
    snapshot: boom,
    mascot: { next: boom, unavailable: boom },
    show: boom,
    unavailable: boom,
  });
  await refreshTray({
    current: () => true,
    snapshot: async () => ({ name: "healthy" }),
    mascot: { next: boom, unavailable: boom },
    show: boom,
    unavailable: boom,
  });
});

test("a superseded or destroyed tray ignores the result", async () => {
  for (const snapshot of [async () => ({ name: "late" }), async () => Promise.reject(new Error("late"))]) {
    const { all, calls } = steps({ snapshot, current: () => false });
    await refreshTray(all);
    assert.deepEqual(calls, []);
  }
});
