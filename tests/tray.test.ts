import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  trayAccountName,
  trayTooltip,
  trayUsageLabel,
  unavailableTrayMenu,
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
  assert.equal(target.label, "Max · 5h 22% · wk 92% used");
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
      (i) =>
        i.type !== "separator" && i.label.includes("Save Claude app sign-in"),
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
    "5h 22% · wk ? used",
  );
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: { usedPercent: NaN } },
      "en",
      now,
    ),
    "5h ? · wk 92% used",
  );
  // With no reading for either window there is nothing the word could describe.
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: undefined, sevenDay: undefined },
      "en",
      now,
    ),
    "5h ? · wk ?",
  );
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: { usedPercent: 130 }, sevenDay: { usedPercent: -1 } },
      "tr",
      now,
    ),
    "5 sa ? · hafta ?",
  );
});

test("Turkish labels, escaped names and empty snapshots remain usable", () => {
  assert.equal(trayAccountName("A&B\nnext\trow"), "A&&B next row");
  const s = snapshot();
  s.accounts[0].name = "A&B\nrow";
  assert.equal(trayTooltip(s), "Relay — A&B row");
  assert.equal(
    trayUsageLabel("target", usage("target"), "tr", now),
    "5 sa %22 · hafta %92 kullanıldı",
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

test("every menu row gives the percent used of both windows with its word once, in both languages", () => {
  const rows = (language: "tr" | "en") =>
    buildTrayMenu(snapshot(), language, now).flatMap((item) =>
      item.type === "checkbox" && item.label.startsWith("Max") ? [item.label] : [],
    );
  assert.deepEqual(rows("tr"), ["Max · 5 sa %22 · hafta %92 kullanıldı"]);
  assert.deepEqual(rows("en"), ["Max · 5h 22% · wk 92% used"]);
  // The word closes the row once, never after each figure.
  for (const label of [...rows("tr"), ...rows("en")]) {
    assert.equal(label.match(/kullanıldı|used/g)?.length, 1, label);
    assert.match(label, /(kullanıldı|used)$/, label);
  }
  // The header over the rows says the same direction.
  const header = (language: "tr" | "en") =>
    buildTrayMenu(snapshot(), language, now).flatMap((item) =>
      item.type === "normal" && /limit|quota/i.test(item.label) ? [item.label] : [],
    );
  assert.deepEqual(header("tr"), ["Kullanılan limit · geçmek için hesap seç"]);
  assert.deepEqual(header("en"), ["Quota used · select an account to switch"]);
});

test("the tooltip names the account and carries the five-hour percent used with its word", () => {
  const s = snapshot();
  s.desktop!.activeProfileId = "target";
  assert.equal(trayTooltip(s, "en", now), "Relay — Max · 22% used");
  assert.equal(trayTooltip(s, "tr", now), "Relay — Max · %22 kullanıldı");
  // No fresh reading: the name alone, as before.
  s.usage = {};
  assert.equal(trayTooltip(s, "en", now), "Relay — Max");
  assert.equal(trayTooltip({ accounts: [], usage: {} }, "tr", now), "Relay");
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

test("tray names the two sign-ins the way the app does while one is unfinished", () => {
  const labelFor = (patch: Partial<TraySnapshot>, language: "tr" | "en") => {
    const menu = buildTrayMenu({ ...snapshot(), ...patch }, language, now);
    return menu.flatMap((item) =>
      item.type === "separator" || item.enabled ? [] : [item.label],
    );
  };
  const pending = { desktop: { ...desktop, pendingProfileId: "target" } };
  assert.ok(
    labelFor(pending, "tr").includes("Önce Claude uygulaması girişini tamamla"),
  );
  assert.ok(
    labelFor(pending, "en").includes("Finish the Claude app sign-in first"),
  );
  assert.ok(
    labelFor({ authBusy: true }, "tr").includes(
      "Önce limit okuma girişini tamamla",
    ),
  );
  assert.ok(
    labelFor({ authBusy: true }, "en").includes(
      "Finish the usage sign-in first",
    ),
  );
});

test("the fallback menu follows the language and offers only Open and Quit", () => {
  const labels = (language: "tr" | "en") =>
    unavailableTrayMenu(language).map((item) => (item.type === "separator" ? "-" : item.label));
  assert.deepEqual(labels("en"), ["Open Relay", "Claude app status unavailable", "-", "Quit Relay"]);
  assert.deepEqual(labels("tr"), ["Relay’i aç", "Claude uygulamasının durumu okunamadı", "-", "Relay’den çık"]);
  assert.deepEqual(
    unavailableTrayMenu("tr").flatMap((item) => (item.type === "normal" && item.command ? [item.command.type] : [])),
    ["show", "quit"],
  );
});
