import test from "node:test";
import assert from "node:assert/strict";
import {
  accountTileLine,
  fullLimitNote,
  fullLimitWarning,
  panelRowLine,
  ringState,
} from "../src/lib/account-row";
import type { OverviewRow } from "../src/data/selectors";
import type { Account, AccountUsage, UsageIssue } from "../shared/types";

const NOW = Date.parse("2026-10-23T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const tr = (a: string) => a;
const en = (_: string, b: string) => b;
const acct = (extra: Partial<Account> = {}): Account => ({
  id: "x", name: "X", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan: "team", capacityWeight: 1 },
  auth: { loggedIn: true, email: "x@example.com", checkedAt: iso(NOW) },
  desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: "x@example.com" },
  ...extra,
});
const use = (five: number, week: number, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: "x", status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + (3 * 60 + 10) * 60_000) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 4 * 86_400_000) },
  ...extra,
});
const row = (state: OverviewRow["state"], usage?: AccountUsage, account = acct(), availableAt?: string): OverviewRow =>
  ({ account, usage, state, availableAt, recommended: false });
const old = (u: AccountUsage) => ({ ...u, checkedAt: iso(NOW - 2 * 3_600_000) });
/** An account without a plan picked, whose usage sign-in reported a Max subscription. */
const max = () => acct({ planning: undefined, auth: { loggedIn: true, checkedAt: iso(NOW), subscription: "max" } });

test("ringState reads how far an account's limits can be trusted", () => {
  assert.equal(ringState(undefined, NOW), "unknown");
  assert.equal(ringState({ accountId: "x", status: "idle", stale: false }, NOW), "unknown");
  // A read that kept nothing has no rings to draw.
  assert.equal(ringState({ accountId: "x", status: "error", stale: true, issue: "unavailable" as UsageIssue, checkedAt: iso(NOW) }, NOW), "unknown");
  assert.equal(ringState(use(22, 35), NOW), "fresh");
  // Old, marked stale, failed with the previous limits kept, or past a reset: the same rule as `freshUsage`.
  assert.equal(ringState(old(use(22, 35)), NOW), "stale");
  assert.equal(ringState(use(22, 35, { stale: true }), NOW), "stale");
  assert.equal(ringState(use(22, 35, { status: "error", issue: "rate-limited" }), NOW), "stale");
  assert.equal(ringState(use(22, 35, { fiveHour: { usedPercent: 22, resetsAt: iso(NOW - 1) } }), NOW), "stale");
  // A used-up window on a fresh reading is full; on an old one it is only stale.
  assert.equal(ringState(use(100, 35), NOW), "full");
  assert.equal(ringState(use(20, 100), NOW), "full");
  assert.equal(ringState(old(use(100, 35)), NOW), "stale");
});

test("the Overview line leads with the plan, as the Accounts table names it", () => {
  assert.equal(accountTileLine(row("window-open", use(22, 35)), tr, "tr", "UTC", NOW), "Team · dönem açık · 3 sa 10 dk kaldı");
  assert.equal(accountTileLine(row("window-open", use(22, 35)), en, "en", "UTC", NOW), "Team · period open · 3 h 10 m left");
  assert.equal(accountTileLine(row("ready", use(0, 35)), tr, "tr", "UTC", NOW), "Team · hazır");
  // Without a plan picked, the subscription the sign-in reported; without either, the status alone.
  assert.equal(accountTileLine(row("ready", use(0, 35), max()), tr, "tr", "UTC", NOW), "Max · hazır");
  const bare = acct({ planning: undefined });
  assert.equal(accountTileLine(row("ready", use(0, 35), bare), tr, "tr", "UTC", NOW), "Hazır");
  assert.equal(accountTileLine(row("window-open", use(22, 35), bare), en, "en", "UTC", NOW), "Period open · 3 h 10 m left");
  // A full account says when it opens.
  const at = iso(NOW + 3_600_000);
  assert.equal(accountTileLine(row("exhausted", use(100, 35), acct(), at), tr, "tr", "UTC", NOW), "Team · 11:00’de açılır (1 sa)");
  assert.equal(accountTileLine(row("exhausted", use(100, 35), acct(), at), en, "en", "UTC", NOW), "Team · opens 11:00 (1 h)");
  assert.equal(accountTileLine(row("not-linked", undefined, acct({ desktop: undefined })), tr, "tr", "UTC", NOW), "Team · giriş kaydedilmedi");
});

test("an old reading says its age on the Overview line, and a problem still outranks it", () => {
  const stale = row("unknown", old(use(22, 35)), max());
  // Its period's reset is still ahead, and a reset time does not grow old.
  assert.equal(accountTileLine(stale, tr, "tr", "UTC", NOW), "Max · limit verisi 2 sa önce okundu · 3 sa 10 dk sonra yenilenir");
  assert.equal(accountTileLine(stale, en, "en", "UTC", NOW), "Max · usage data read 2 h ago · resets in 3 h 10 m");
  // Marked stale by a failed read that kept the limits: also its age.
  const kept = row("unknown", old(use(22, 35, { status: "error", issue: "rate-limited", stale: true })), max());
  assert.equal(accountTileLine(kept, tr, "tr", "UTC", NOW), "Max · limit verisi 2 sa önce okundu · 3 sa 10 dk sonra yenilenir");
  // Nothing kept: no age to tell.
  const lost = row("unknown", { accountId: "x", status: "error", issue: "unavailable", stale: false }, max());
  assert.equal(accountTileLine(lost, tr, "tr", "UTC", NOW), "Max · limit verisi eski");
  // A sign-in problem or a pending approval is said instead; proper names keep their capitals.
  const locked = row("unknown", old(use(22, 35, { status: "error", issue: "keychain-locked", stale: true })), max());
  assert.equal(accountTileLine(locked, tr, "tr", "UTC", NOW), "Max · anahtarlık izni gerekli");
  assert.equal(accountTileLine(locked, en, "en", "UTC", NOW), "Max · Keychain access needed");
  assert.equal(accountTileLine(stale, tr, "tr", "UTC", NOW, true), "Max · tarayıcı onayı bekleniyor");
});

test("the panel line leads with the time left, so a narrow panel cuts the percents instead", () => {
  assert.equal(panelRowLine(row("window-open", use(22, 35)), tr, "tr", "UTC", NOW), "3 sa 10 dk sonra yenilenir · %22 · %35");
  assert.equal(panelRowLine(row("window-open", use(22, 35)), en, "en", "UTC", NOW), "Resets in 3 h 10 m · 22% · 35%");
  // An old reading keeps its reset, which does not grow old, and says its age.
  assert.equal(panelRowLine(row("unknown", old(use(22, 35))), tr, "tr", "UTC", NOW), "3 sa 10 dk sonra yenilenir · 2 sa önce okundu · %22 · %35");
  assert.equal(panelRowLine(row("unknown", old(use(22, 35))), en, "en", "UTC", NOW), "Resets in 3 h 10 m · read 2 h ago · 22% · 35%");
  assert.equal(panelRowLine(row("ready", use(0, 35)), tr, "tr", "UTC", NOW), "Hazır · %0 · %35");
  // A full account says how long until it opens.
  const opens = iso(NOW + 90 * 60_000);
  assert.equal(panelRowLine(row("exhausted", use(100, 57), acct(), opens), tr, "tr", "UTC", NOW), "1 sa 30 dk sonra açılır · %100 · %57");
  // Without a reading, only the status.
  assert.equal(panelRowLine(row("unknown", undefined), tr, "tr", "UTC", NOW), "Limit verisi yok");
  assert.equal(panelRowLine(row("not-linked", undefined, acct({ desktop: undefined })), tr, "tr", "UTC", NOW), "Giriş kaydedilmedi");
  // A reading without a week shows the one percent.
  const five = use(40, 0);
  delete five.sevenDay;
  assert.equal(panelRowLine(row("window-open", five), tr, "tr", "UTC", NOW), "3 sa 10 dk sonra yenilenir · %40");
});

test("a full account's switch says when its limit opens, in days once it is a day away", () => {
  const soon = iso(NOW + 90 * 60_000);
  assert.equal(fullLimitNote(soon, tr, "tr", "UTC", NOW), "Limit dolu · 11:30’da açılır (1 sa 30 dk)");
  assert.equal(fullLimitNote(soon, en, "en", "UTC", NOW), "Limit is full · opens 11:30 (1 h 30 m)");
  assert.equal(fullLimitNote(iso(NOW + 2 * 86_400_000), tr, "tr", "UTC", NOW), "Limit dolu · 10:00’da açılır (2 gün)");
  // Unknown, or already past: only that it is full.
  assert.equal(fullLimitNote(undefined, tr, "tr", "UTC", NOW), "Limit dolu");
  assert.equal(fullLimitNote(iso(NOW - 60_000), en, "en", "UTC", NOW), "Limit is full");
  assert.equal(
    fullLimitWarning(soon, tr, "tr", "UTC", NOW),
    "Bu hesabın limiti dolu; 11:30’da açılır (1 sa 30 dk sonra). O zamana kadar bu hesapla yeni mesaj gönderemezsin.",
  );
  assert.equal(
    fullLimitWarning(soon, en, "en", "UTC", NOW),
    "This account’s limit is full; it opens at 11:30 (in 1 h 30 m). Until then you can’t send new messages on it.",
  );
  assert.match(fullLimitWarning(undefined, tr, "tr", "UTC", NOW), /ne zaman açılacağı bilinmiyor/);
});
