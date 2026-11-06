import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrayMenu,
  canRequestTraySwitch,
  DEFAULT_MENU_BAR_ITEMS,
  MENU_BAR_ITEMS,
  MENU_BAR_MAX_ITEMS,
  menuBarItems,
  trayAccountName,
  trayCost,
  trayCountdown,
  trayResetClock,
  trayShortName,
  trayTitle,
  trayTokens,
  trayTooltip,
  trayUsageLabel,
  unavailableTrayMenu,
  type TraySnapshot,
} from "../shared/tray";
import { mascotPose, mascotRest } from "../shared/mascot";
import type { Account, AccountUsage, DesktopState, MenuBarItem } from "../shared/types";

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
  assert.equal(target.label, "Max · 5 h 22% · week 92% used");
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

test("unknown, future and foreign quota stays unknown in the tray", () => {
  assert.equal(trayUsageLabel("target", undefined, "en", now), "5 h ? · week ?");
  for (const u of [
    { ...usage("target"), checkedAt: new Date(now + 5 * 60_000).toISOString() },
    usage("different"),
    // A sign-in problem keeps nothing to show, whatever the cache still holds.
    { ...usage("target"), status: "error" as const, stale: true, issue: "keychain-locked" as const },
    { ...usage("target"), stale: true, connectionRenewalRequired: true },
  ])
    assert.equal(
      trayUsageLabel("target", u, "en", now),
      "5 h ? · week ? · usage data is out of date",
    );
});

test("a reading old for a passing reason keeps its figures in the menu, marked, until each window resets", () => {
  for (const u of [
    { ...usage("target"), stale: true },
    { ...usage("target"), status: "loading" as const },
    { ...usage("target"), status: "error" as const, stale: true, issue: "unavailable" as const },
    { ...usage("target"), status: "error" as const, stale: true, issue: "rate-limited" as const },
    {
      ...usage("target"),
      checkedAt: new Date(now - 36 * 60_000).toISOString(),
    },
  ])
    assert.equal(
      trayUsageLabel("target", u, "en", now),
      "5 h ~22% · week ~92% used · usage data is out of date",
    );
  assert.equal(
    trayUsageLabel("target", { ...usage("target"), stale: true }, "tr", now),
    "5 sa ~%22 · hafta ~%92 kullanıldı · limit verisi eski",
  );
  // A window that has reset since is unknown; the other keeps its figure.
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: { usedPercent: 0, resetsAt: new Date(now).toISOString() } },
      "en",
      now,
    ),
    "5 h ? · week ~92% used · usage data is out of date",
  );
});

test("a fresh reading's windows read as they are", () => {
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), sevenDay: undefined },
      "en",
      now,
    ),
    "5 h 22% · week ? used",
  );
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: { usedPercent: NaN } },
      "en",
      now,
    ),
    "5 h ? · week 92% used",
  );
  // With no reading for either window there is nothing the word could describe.
  assert.equal(
    trayUsageLabel(
      "target",
      { ...usage("target"), fiveHour: undefined, sevenDay: undefined },
      "en",
      now,
    ),
    "5 h ? · week ?",
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
  assert.deepEqual(rows("en"), ["Max · 5 h 22% · week 92% used"]);
  // The word closes the row once, never after each figure.
  for (const label of [...rows("tr"), ...rows("en")]) {
    assert.equal(label.match(/kullanıldı|used/g)?.length, 1, label);
    assert.match(label, /(kullanıldı|used)$/, label);
  }
  // The header over the rows says what a click does.
  const header = (language: "tr" | "en") =>
    buildTrayMenu(snapshot(), language, now).flatMap((item) =>
      item.type === "normal" && /hesap seç|select an account/i.test(item.label) ? [item.label] : [],
    );
  assert.deepEqual(header("tr"), ["Geçmek için hesap seç"]);
  assert.deepEqual(header("en"), ["Select an account to switch"]);
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
  assert.equal(trayTooltip(busy("current"), "en", now), "Relay switches to Current…");
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

test("the title shows a dash while Claude is closed or a sign-in problem keeps the limits unknown", () => {
  const closed = onTarget(40, { desktop: { ...desktop, activeProfileId: "target", running: false } });
  assert.equal(trayTitle(closed, now, "tr"), "—");
  assert.equal(trayTooltip(closed, "tr", now), "Relay — Max · Claude uygulaması kapalı");
  assert.equal(trayTooltip(closed, "en", now), "Relay — Max · Claude app closed");
  // Expired, scope, a missing or foreign sign-in: the service keeps nothing of the last reading.
  const expired: Partial<AccountUsage> = {
    status: "error", stale: false, issue: "expired", fiveHour: undefined, sevenDay: undefined, checkedAt: undefined,
  };
  assert.equal(trayTitle(onTarget(40, {}, expired), now, "tr"), "—");
  assert.equal(trayTooltip(onTarget(40, {}, expired), "en", now), "Relay — Max · usage data is out of date");
  // A locked Keychain or a connection to renew keeps the figures in the cache, but they are not shown.
  for (const signIn of [
    { status: "error", stale: true, issue: "keychain-locked" },
    { status: "error", stale: true, issue: "renewal-required" },
    { stale: true, connectionRenewalRequired: true },
  ] as Partial<AccountUsage>[]) {
    const s = onTarget(40, {}, signIn);
    assert.equal(trayTitle(s, now, "tr"), "—", signIn.issue);
    assert.equal(trayTooltip(s, "tr", now), "Relay — Max · limit verisi eski", signIn.issue);
  }
  assert.equal(trayTitle(onTarget(40, {}, { checkedAt: new Date(now - 29 * 60_000).toISOString() }), now, "tr"), "%40");
  // A refresh in progress keeps the reading it started from.
  assert.equal(trayTitle(onTarget(40, {}, { status: "loading" }), now, "tr"), "%40");
  // Before the first reading, and with no saved account open, there is nothing to sleep over.
  assert.equal(trayTitle(onTarget(40, { usage: {} }), now, "tr"), "");
  assert.equal(trayTitle(onTarget(40, {}, { status: "loading", checkedAt: undefined }), now, "tr"), "");
  assert.equal(trayTitle({ ...snapshot(), desktop: { ...desktop, activeProfileId: undefined } }, now, "tr"), "");
});

test("a read that fails for a passing reason keeps the last figure in the title, marked, while the panda sleeps", () => {
  // No network, a rate limit, the service down: Relay keeps the previous reading, marked stale.
  for (const issue of ["unavailable", "rate-limited"] as const) {
    const failed = onTarget(40, {}, { status: "error", stale: true, issue });
    assert.equal(trayTitle(failed, now, "tr"), "~%40", issue);
    assert.equal(trayTitle(failed, now, "en"), "~40%", issue);
    assert.equal(mascotRest(failed, now), "unknown", issue);
    assert.equal(mascotPose(failed, now), "sleeping", issue);
    assert.equal(
      trayTooltip(failed, "tr", now),
      "Relay — Max · ~%40 kullanıldı · 9 sa 50 dk sonra yenilenir · limit verisi eski, az önce okundu",
      issue,
    );
    // The read after it starts from the same reading.
    assert.equal(trayTitle(onTarget(40, {}, { status: "loading", stale: true, issue }), now, "tr"), "~%40", issue);
  }
  // A reading that has only grown old.
  const old = onTarget(40, {}, { checkedAt: new Date(now - 31 * 60_000).toISOString() });
  assert.equal(trayTitle(old, now, "tr"), "~%40");
  assert.equal(
    trayTooltip(old, "en", now),
    "Relay — Max · ~40% used · renews in 9:50 · usage data is out of date, read 31 min ago",
  );
  // From 80 % on the countdown still follows; it holds, the reset time does not change.
  assert.equal(trayTitle(onTarget(94, {}, { stale: true }), now, "tr"), "~%94 · 9:50");
  // A full window stays full until it resets: its clock needs no mark.
  assert.equal(trayTitle(onTarget(100, { timeZone: "Europe/Istanbul" }, { stale: true }), now, "tr"), "22:50");
  // Once the window has reset the old figure says nothing: the dash.
  const later = Date.parse("2026-10-13T19:51:00Z");
  assert.equal(trayTitle(onTarget(40, {}, { stale: true }), later, "tr"), "—");
  // A reading from the future is not one.
  assert.equal(trayTitle(onTarget(40, {}, { stale: true, checkedAt: new Date(now + 5 * 60_000).toISOString() }), now, "tr"), "—");
});

test("the title shows the items chosen, in their order", () => {
  const today = { date: "2026-10-13", tokens: 12_430_000, cost: 18.2 };
  const titled = (
    titleItems: MenuBarItem[] | undefined,
    language: "tr" | "en" = "tr",
    usedPercent = 40,
    extra: Partial<TraySnapshot> = {},
    u: Partial<AccountUsage> = {},
  ) => trayTitle(onTarget(usedPercent, { titleItems, today, timeZone: "UTC", ...extra }, u), now, language);
  const thin = (...parts: string[]) => parts.join(" · ");
  // Nothing chosen yet: the five-hour percent, as always.
  assert.equal(titled(undefined), "%40");
  assert.equal(titled(["five-hour"]), "%40");
  assert.equal(titled(["week"]), "%92");
  assert.equal(titled(["five-hour", "week"]), "%40 · %92");
  // The time left has its own item; with it the percent never adds it again.
  assert.equal(titled(["reset"]), "9:50");
  assert.equal(titled(["five-hour", "reset"], "tr", 94), "%94 · 9:50");
  assert.equal(titled(["five-hour", "reset"], "en", 40), "40% · 9:50");
  assert.equal(titled(["five-hour", "reset"], "tr", 100, { timeZone: "Europe/Istanbul" }), "%100 · 22:50");
  assert.equal(titled(["reset"], "tr", 100, { timeZone: "Europe/Istanbul" }), "22:50");
  // Today's tokens in millions and their API value, across all accounts.
  assert.equal(titled(["tokens"]), "12,4M");
  assert.equal(titled(["tokens"], "en"), "12.4M");
  assert.equal(titled(["cost"]), "$18,20");
  assert.equal(titled(["cost"], "en"), "$18.20");
  assert.equal(titled(["cost"], "tr", 40, { today: { ...today, costEstimated: true } }), "≈$18,20");
  assert.equal(titled(["account"]), "Max");
  assert.equal(titled(["cost", "five-hour", "tokens"]), "$18,20 · %40 · 12,4M");
  // More than three parts get thin spaces around the dot.
  assert.equal(titled(["five-hour", "week", "tokens", "cost"]), thin("%40", "%92", "12,4M", "$18,20"));
  assert.equal(titled(["five-hour", "tokens", "cost"], "tr", 94), thin("%94", "9:50", "12,4M", "$18,20"));
  // With four items there is no room left for the countdown the percent would add.
  assert.equal(titled(["five-hour", "week", "tokens", "cost"], "tr", 94), thin("%94", "%92", "12,4M", "$18,20"));
  // None chosen: the panda alone.
  assert.equal(titled([]), "");
  // Yesterday's figures, or none yet, are left out.
  assert.equal(titled(["five-hour", "tokens"], "tr", 40, { today: { ...today, date: "2026-10-12" } }), "%40");
  assert.equal(titled(["five-hour", "cost"], "tr", 40, { today: undefined }), "%40");
  // Last known figures each carry the mark; today's figures do not need it.
  assert.equal(titled(["five-hour", "week", "tokens"], "tr", 40, {}, { status: "error", stale: true, issue: "unavailable" }), "~%40 · ~%92 · 12,4M");
  // Claude closed: one dash for the limits, whatever else is chosen stays.
  const closed = { desktop: { ...desktop, activeProfileId: "target", running: false } };
  assert.equal(titled(["five-hour", "week", "tokens", "account"], "tr", 40, closed), "— · 12,4M · Max");
  assert.equal(titled(["week", "reset"], "tr", 40, closed), "—");
  // A switch names its target whatever is chosen.
  const switching = { switchingTo: "current", desktop: { ...desktop, activeProfileId: "target", busy: true } };
  assert.equal(titled(["tokens", "cost"], "tr", 40, switching), "Current…");
  // A long name is cut shorter than a switch's, and says so.
  const long = onTarget(40, { titleItems: ["account", "five-hour"] });
  long.accounts[1].name = "Şirket hesabı (ekip)";
  assert.equal(trayTitle(long, now, "tr"), "Şirket he… · %40");
});

test("the title's items name themselves in the tooltip", () => {
  const s = onTarget(40, {
    titleItems: ["five-hour", "week", "tokens", "cost"],
    today: { date: "2026-10-13", tokens: 12_430_000, cost: 18.2 },
    timeZone: "UTC",
  });
  assert.equal(
    trayTooltip(s, "tr", now),
    "Relay — Max · %40 kullanıldı · 9 sa 50 dk sonra yenilenir · hafta %92 kullanıldı · bugün 12,4M token, $18,20 API karşılığı",
  );
  assert.equal(
    trayTooltip(s, "en", now),
    "Relay — Max · 40% used · renews in 9:50 · week 92% used · today 12.4M tokens, $18.20 API value",
  );
  // With Claude closed, today's figures still say what they are.
  const closed = { ...s, desktop: { ...desktop, activeProfileId: "target", running: false } };
  assert.equal(trayTooltip(closed, "tr", now), "Relay — Max · Claude uygulaması kapalı · bugün 12,4M token, $18,20 API karşılığı");
});

test("tokens read in millions and the API value in dollars, short", () => {
  assert.equal(trayTokens(0, "tr"), "0,0M");
  assert.equal(trayTokens(430_000, "en"), "0.4M");
  assert.equal(trayTokens(12_430_000, "tr"), "12,4M");
  // From 100M on, whole millions; never "100,0M".
  assert.equal(trayTokens(99_960_000, "tr"), "100M");
  assert.equal(trayTokens(184_400_000, "en"), "184M");
  // From a billion, billions: "milyar" in Turkish, where "B" would read as "bin".
  assert.equal(trayTokens(999_400_000, "en"), "999M");
  assert.equal(trayTokens(999_600_000, "tr"), "1,0Mr");
  assert.equal(trayTokens(1_823_000_000, "tr"), "1,8Mr");
  assert.equal(trayTokens(1_234_000_000, "en"), "1.2B");
  assert.equal(trayTokens(NaN, "en"), "0.0M");
  assert.equal(trayCost(18.2, "tr"), "$18,20");
  assert.equal(trayCost(99.99, "en"), "$99.99");
  assert.equal(trayCost(184.4, "en"), "$184");
  assert.equal(trayCost(1234.5, "tr"), "$1.235");
  assert.equal(trayCost(5, "en", true), "≈$5.00");
  assert.equal(trayCost(-1, "en"), "$0.00");
});

test("the title's items are kept known, once each, and at most four", () => {
  assert.deepEqual(menuBarItems(undefined), ["five-hour"]);
  assert.deepEqual(menuBarItems("tokens"), ["five-hour"]);
  assert.deepEqual(menuBarItems([]), []);
  assert.deepEqual(
    menuBarItems(["tokens", "bogus", "tokens", "cost", "week", "reset", "account"]),
    ["tokens", "cost", "week", "reset"],
  );
  assert.equal(MENU_BAR_MAX_ITEMS, 4);
  assert.deepEqual(MENU_BAR_ITEMS, ["five-hour", "week", "reset", "tokens", "cost", "account"]);
  assert.deepEqual(DEFAULT_MENU_BAR_ITEMS, ["five-hour"]);
});

test("any four items stay a short title", () => {
  // The widest figure of each item: a stale full week, a clock, a thousand millions, an estimated
  // thousand dollars, a long name.
  const wide = onTarget(99, {
    timeZone: "UTC",
    today: { date: "2026-10-13", tokens: 1_234_000_000, cost: 1234, costEstimated: true },
  }, { stale: true, sevenDay: { usedPercent: 100, resetsAt: "2026-10-17T10:00:00Z" } });
  wide.accounts[1].name = "Çok uzun bir hesap adı";
  const combos = (from: number, size: number): MenuBarItem[][] =>
    size === 0
      ? [[]]
      : MENU_BAR_ITEMS.slice(from).flatMap((item, i) =>
          combos(from + i + 1, size - 1).map((rest) => [item, ...rest]),
        );
  let widest = "";
  for (let size = 1; size <= MENU_BAR_MAX_ITEMS; size++)
    for (const items of combos(0, size))
      for (const language of ["tr", "en"] as const) {
        const title = trayTitle({ ...wide, titleItems: items }, now, language);
        // Never more than four parts, whatever is chosen.
        assert.ok(title.split(/ · | · /).length <= MENU_BAR_MAX_ITEMS, title);
        if (title.length > widest.length) widest = title;
      }
  assert.equal(widest, "~%100 · 1,2Mr · ≈$1.234 · Çok uzun…");
  assert.ok(widest.length <= 36, widest);
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
