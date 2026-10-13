import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  trayAccountName,
  trayTooltip,
  trayUsageLabel,
  type TraySnapshot,
} from "../shared/tray";
import type { Account, AccountUsage, DesktopState } from "../shared/types";

const now = Date.parse("2026-10-13T10:00:00Z");
const account = (id: string, name = id): Account => ({
  id,
  name,
  kind: "personal",
  group: "personal",
  color: "#227755",
  createdAt: "2026-10-12T00:00:00Z",
  desktop: {
    accountUuid: `uuid-${id}`,
    orgId: `org-${id}`,
    savedAt: "2026-10-12T00:00:00Z",
  },
});
const desktop: DesktopState = {
  available: true,
  running: true,
  organizations: [],
  activeProfileId: "current",
  busy: false,
  recoveryRequired: false,
  errorRevision: 0,
};
const usage = (id: string): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  checkedAt: new Date(now).toISOString(),
  fiveHour: { usedPercent: 22.5, resetsAt: "2026-10-13T14:00:00Z" },
  sevenDay: { usedPercent: 92, resetsAt: "2026-10-17T10:00:00Z" },
});
const snapshot = (): TraySnapshot => ({
  accounts: [account("current", "Current"), account("target", "Max")],
  usage: { target: usage("target") },
  desktop: { ...desktop },
});

test("tray account action requests a review and never bypasses restart consent", () => {
  const menu = buildTrayMenu(snapshot(), "en", now);
  const current = menu.find((item) => item.type === "checkbox" && item.checked);
  assert.ok(current && current.type === "checkbox");
  assert.equal(current.enabled, false);
  assert.equal(current.command, undefined);
  const target = menu.find((item) => item.type === "checkbox" && !item.checked);
  assert.ok(target && target.type === "checkbox");
  assert.equal(target.label, "Max · 5h 77% · wk 8%");
  assert.deepEqual(target.command, {
    type: "review-switch",
    profileId: "target",
  });
  const commands = menu.flatMap((item) =>
    item.type === "separator" || !item.command ? [] : [item.command.type],
  );
  assert.deepEqual(commands, ["show", "review-switch", "quit"]);
});

test("tray disables all switch targets while state is unavailable or occupied", async (t) => {
  const states: [string, Partial<TraySnapshot>][] = [
    ["initial snapshot", { desktop: undefined }],
    ["unsupported", { desktop: { ...desktop, available: false } }],
    ["Desktop operation", { desktop: { ...desktop, busy: true } }],
    ["recovery", { desktop: { ...desktop, recoveryRequired: true } }],
    [
      "Desktop sign-in",
      { desktop: { ...desktop, pendingProfileId: "target" } },
    ],
    ["CLI sign-in", { authBusy: true }],
  ];
  for (const [label, patch] of states) {
    await t.test(label, () => {
      const state = { ...snapshot(), ...patch };
      assert.equal(canRequestTraySwitch(state, "target"), false);
      const menu = buildTrayMenu(state, "en", now);
      assert.ok(
        menu.every(
          (item) =>
            item.type === "separator" || item.command?.type !== "review-switch",
        ),
      );
      assert.ok(
        menu.some(
          (item) => item.type !== "separator" && item.command?.type === "show",
        ),
      );
    });
  }
});

test("tray only offers saved Desktop identities and blocks mismatched CLI identities", () => {
  const s = snapshot();
  s.accounts.push({ ...account("unlinked"), desktop: undefined });
  s.accounts.push({
    ...account("mismatch"),
    auth: {
      loggedIn: true,
      accountUuid: "different-account",
      checkedAt: "2026-10-13T10:00:00Z",
    },
  });
  assert.equal(canRequestTraySwitch(s, "unlinked"), false);
  assert.equal(canRequestTraySwitch(s, "mismatch"), false);
  assert.equal(canRequestTraySwitch(s, "deleted"), false);
  assert.equal(canRequestTraySwitch(s, "target"), true);
  assert.ok(
    buildTrayMenu(s).some(
      (i) => i.type !== "separator" && i.label.includes("Connect Desktop"),
    ),
  );
});

test("stale, reset, unknown and foreign quota stays unknown in the tray", () => {
  assert.equal(trayUsageLabel("target", undefined, "en", now), "5h ? · wk ?");
  for (const u of [
    { ...usage("target"), stale: true },
    { ...usage("target"), status: "loading" as const },
    {
      ...usage("target"),
      checkedAt: new Date(now - 36 * 60_000).toISOString(),
    },
    { ...usage("target"), checkedAt: new Date(now + 5 * 60_000).toISOString() },
    {
      ...usage("target"),
      fiveHour: { usedPercent: 0, resetsAt: new Date(now).toISOString() },
    },
    usage("different"),
  ])
    assert.equal(
      trayUsageLabel("target", u, "en", now),
      "5h ? · wk ? · outdated",
    );
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), sevenDay: undefined },
      "en",
      now,
    ),
    "5h 77% · wk ?",
  );
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: { usedPercent: NaN } },
      "en",
      now,
    ),
    "5h ? · wk 8%",
  );
});

test("Turkish labels, escaped names and empty snapshots remain usable", () => {
  assert.equal(trayAccountName("A&B\nnext\trow"), "A&&B next row");
  const s = snapshot();
  s.accounts[0].name = "A&B\nrow";
  assert.equal(trayTooltip(s), "Relay — A&B row");
  assert.equal(
    trayUsageLabel("target", usage("target"), "tr", now),
    "5h 77% · hf 8%",
  );
  const empty = buildTrayMenu({ accounts: [], usage: {}, desktop }, "tr", now);
  assert.ok(
    empty.some(
      (i) => i.type !== "separator" && i.label === "Relay’de hesap ekle",
    ),
  );
  assert.ok(
    empty.some((i) => i.type !== "separator" && i.label === "Relay’i aç"),
  );
});

test("a fresh recheck rejects a target when Desktop changes after menu creation", () => {
  const s = snapshot();
  const target = buildTrayMenu(s, "en", now).find(
    (i) => i.type !== "separator" && i.command?.type === "review-switch",
  );
  assert.ok(target);
  s.desktop!.busy = true;
  assert.equal(canRequestTraySwitch(s, "target"), false);
  s.desktop!.busy = false;
  s.desktop!.activeProfileId = "target";
  assert.equal(canRequestTraySwitch(s, "target"), false);
});
