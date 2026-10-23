import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  trayAccountName,
  trayCountdown,
  trayResetClock,
  trayShortName,
  trayTitle,
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
      "5h ? · wk ? · usage data is out of date",
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
  // With the window's reset known, it also says when the window renews.
  assert.equal(trayTooltip(s, "en", now), "Relay — Max · 22% used · renews in 4:00");
  assert.equal(trayTooltip(s, "tr", now), "Relay — Max · %22 kullanıldı · 4 sa sonra yenilenir");
  // Turkish says the time left in hours and minutes, never as a clock ("1:50 sonra").
  const soon = { ...usage("target"), fiveHour: { usedPercent: 22.5, resetsAt: new Date(now + 110 * 60_000).toISOString() } };
  s.usage = { target: soon };
  assert.equal(trayTooltip(s, "tr", now), "Relay — Max · %22 kullanıldı · 1 sa 50 dk sonra yenilenir");
  s.usage = { target: { ...soon, fiveHour: { usedPercent: 22.5, resetsAt: new Date(now + 7 * 60_000).toISOString() } } };
  assert.equal(trayTooltip(s, "tr", now), "Relay — Max · %22 kullanıldı · 7 dk sonra yenilenir");
  // Without one, the percent alone.
  s.usage = { target: { ...usage("target"), fiveHour: { usedPercent: 22.5 } } };
  assert.equal(trayTooltip(s, "en", now), "Relay — Max · 22% used");
  assert.equal(trayTooltip(s, "tr", now), "Relay — Max · %22 kullanıldı");
  // No fresh reading: the name alone, as before.
  s.usage = {};
  assert.equal(trayTooltip(s, "en", now), "Relay — Max");
  assert.equal(trayTooltip({ accounts: [], usage: {} }, "tr", now), "Relay");
});

test("the countdown reads h:mm until the reset, rounding up to the minute, and nothing once it passed", () => {
  const at = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(trayCountdown(at(110 * 60_000), now), "1:50");
  assert.equal(trayCountdown(at(7 * 60_000), now), "0:07");
  assert.equal(trayCountdown(at(5 * 3_600_000), now), "5:00");
  // A part-minute counts as a whole one, so the last seconds read 0:01, never 0:00.
  assert.equal(trayCountdown(at(61_000), now), "0:02");
  assert.equal(trayCountdown(at(1_000), now), "0:01");
  assert.equal(trayCountdown(at(0), now), undefined);
  assert.equal(trayCountdown(at(-60_000), now), undefined);
  assert.equal(trayCountdown(undefined, now), undefined);
  assert.equal(trayCountdown("soon", now), undefined);
});

test("the menu bar title adds the time left from 80 % used on, when the reset is known", () => {
  const titled = (usedPercent: number, resetsAt?: string, language: "tr" | "en" = "tr") => {
    const s = snapshot();
    s.desktop!.activeProfileId = "target";
    s.usage = { target: { ...usage("target"), fiveHour: { usedPercent, ...(resetsAt ? { resetsAt } : {}) } } };
    return trayTitle(s, now, language);
  };
  const in110 = new Date(now + 110 * 60_000).toISOString();
  // Below 80 % the item stays a plain number.
  assert.equal(titled(22.5, in110), "%22");
  assert.equal(titled(79.9, in110), "%79");
  assert.equal(titled(80, in110), "%80 · 1:50");
  assert.equal(titled(94, in110), "%94 · 1:50");
  assert.equal(titled(94, in110, "en"), "94% · 1:50");
  // No reset time: the percent alone.
  assert.equal(titled(94), "%94");
  // A reset already past makes the reading old, so the title is empty rather than counting down.
  assert.equal(titled(94, new Date(now - 60_000).toISOString()), "");
});

/** The snapshot with "target" open in Claude and its five-hour window at `usedPercent`. */
const onTarget = (usedPercent: number, extra: Partial<TraySnapshot> = {}, u: Partial<AccountUsage> = {}): TraySnapshot => {
  const s = snapshot();
  s.desktop!.activeProfileId = "target";
  s.usage = {
    target: { ...usage("target"), fiveHour: { usedPercent, resetsAt: "2026-10-13T19:50:00Z" }, ...u },
  };
  return { ...s, ...extra };
};

test("a full five-hour window shows the clock it reopens at, in the planning time zone", () => {
  const istanbul = onTarget(100, { timeZone: "Europe/Istanbul" });
  assert.equal(trayTitle(istanbul, now, "tr"), "22:50");
  assert.equal(trayTitle(istanbul, now, "en"), "22:50");
  assert.equal(trayTitle(onTarget(100, { timeZone: "UTC" }), now, "en"), "19:50");
  assert.equal(trayTooltip(istanbul, "tr", now), "Relay — Max · %100 kullanıldı · 22:50’de açılır");
  assert.equal(trayTooltip(istanbul, "en", now), "Relay — Max · 100% used · opens at 22:50");
  // 99.9 % is not full yet: the countdown stays.
  assert.equal(trayTitle(onTarget(99.9, { timeZone: "UTC" }), now, "tr"), "%99 · 9:50");
  // Without a reset time a full window still reads as a percent.
  const unknownReset = onTarget(100, { timeZone: "UTC" });
  unknownReset.usage.target.fiveHour = { usedPercent: 100 };
  assert.equal(trayTitle(unknownReset, now, "tr"), "%100");
  // An unknown zone falls back to the system's clock rather than failing.
  assert.match(trayTitle(onTarget(100, { timeZone: "Mars/Olympus" }), now, "en"), /^\d\d:\d\d$/);
  assert.equal(trayResetClock("2026-10-13T19:50:00Z", now, "en", "UTC"), "19:50");
  assert.equal(trayResetClock("2026-10-13T09:00:00Z", now, "en", "UTC"), undefined);
});

test("while a switch runs the title names the account it opens, cut short when long", () => {
  const busy = (switchingTo?: string) =>
    onTarget(40, { switchingTo, desktop: { ...desktop, activeProfileId: "target", busy: true, running: false } });
  assert.equal(trayTitle(busy("current"), now, "tr"), "Current…");
  assert.equal(trayTooltip(busy("current"), "tr", now), "Relay — Current hesabına geçiliyor…");
  assert.equal(trayTooltip(busy("current"), "en", now), "Relay — Switching to Current…");
  const long = busy("current");
  long.accounts[0].name = "Şirket hesabı (ekip)\nikinci";
  assert.equal(trayTitle(long, now, "tr"), "Şirket hesabı…");
  assert.equal(trayShortName("Abcdefghijklmn"), "Abcdefghijklmn");
  assert.equal(trayShortName("Abcdefghijklmno"), "Abcdefghijklm");
  // Busy with no known target (a save, a link): the title keeps the percent, though Claude may be closed.
  assert.equal(trayTitle(busy(), now, "tr"), "%40");
  // A target left over once Desktop is no longer busy is ignored.
  assert.equal(trayTitle(onTarget(40, { switchingTo: "current" }), now, "tr"), "%40");
});

test("the title shows a dash while the panda sleeps: Claude closed, or the reading failed or is old", () => {
  const closed = onTarget(40, { desktop: { ...desktop, activeProfileId: "target", running: false } });
  assert.equal(trayTitle(closed, now, "tr"), "—");
  assert.equal(trayTooltip(closed, "tr", now), "Relay — Max · Claude uygulaması kapalı");
  assert.equal(trayTooltip(closed, "en", now), "Relay — Max · Claude app closed");
  const old = onTarget(40, {}, { checkedAt: new Date(now - 31 * 60_000).toISOString() });
  assert.equal(trayTitle(old, now, "tr"), "—");
  assert.equal(trayTooltip(old, "tr", now), "Relay — Max · limit verisi eski");
  assert.equal(trayTooltip(old, "en", now), "Relay — Max · usage data is out of date");
  assert.equal(trayTitle(onTarget(40, {}, { checkedAt: new Date(now - 29 * 60_000).toISOString() }), now, "tr"), "%40");
  assert.equal(trayTitle(onTarget(40, {}, { status: "error", issue: "rate-limited" }), now, "tr"), "—");
  // A refresh in progress keeps the reading it started from.
  assert.equal(trayTitle(onTarget(40, {}, { status: "loading" }), now, "tr"), "%40");
  // Before the first reading, and with no saved account open, there is nothing to sleep over.
  assert.equal(trayTitle(onTarget(40, { usage: {} }), now, "tr"), "");
  assert.equal(trayTitle(onTarget(40, {}, { status: "loading", checkedAt: undefined }), now, "tr"), "");
  assert.equal(trayTitle({ ...snapshot(), desktop: { ...desktop, activeProfileId: undefined } }, now, "tr"), "");
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
