import test from "node:test";
import assert from "node:assert/strict";
import { providerViews } from "../src/lib/provider-view";
import { countdown } from "../src/components/LimitLine";
import { antigravityAccountState } from "../src/features/AntigravityAccount";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const account = (id: string, provider?: Account["provider"]): Account =>
  ({ id, name: id, kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW), ...(provider ? { provider } : {}), auth: { loggedIn: true, checkedAt: iso(NOW) } }) as Account;
const read = (five: number, week: number): AccountUsage => ({
  accountId: "", status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + 3_600_000) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 86_400_000) },
});

test("providers are listed only when they have accounts, Claude first, each with the account in use", () => {
  const claude = account("c1");
  const g1 = account("g1", "antigravity");
  const g2 = account("g2", "antigravity");
  const usage = {
    c1: read(95, 10),
    g1: { ...read(0, 0), fiveHour: undefined, sevenDay: undefined, modelWindows: [{ key: "antigravity_x", label: "X", usedPercent: 100, resetsAt: iso(NOW + 1_500_000) }] },
  };
  const views = providerViews({ accounts: [g1, claude, g2], usage, active: claude, antigravity: { installed: true, canOpen: true, accountId: "g1" }, now: NOW });
  assert.deepEqual(views.map((v) => v.id), ["claude", "antigravity"]);
  assert.equal(views[0].current?.id, "c1");
  assert.equal(views[0].via, "app");
  assert.equal(views[0].tone, "crit");
  // The Antigravity app's account, its fullest model as the headline, and "in the app".
  assert.equal(views[1].current?.id, "g1");
  assert.equal(views[1].via, "app");
  assert.equal(views[1].head?.usedPercent, 100);
  assert.deepEqual(views[1].accounts.map((a) => a.id), ["g1", "g2"]);
  // No account open in the app: no current one, and no tone to show.
  const none = providerViews({ accounts: [g1], usage, antigravity: { installed: true, canOpen: true }, now: NOW });
  assert.equal(none[0].current, undefined);
  assert.equal(none[0].tone, "none");
});

test("a reset reads as a short countdown, a day or more in days", () => {
  const t = (tr: string) => tr;
  assert.equal(countdown(iso(NOW + 25 * 60_000), NOW, t), "25 dk");
  assert.equal(countdown(iso(NOW + 110 * 60_000), NOW, t), "1 sa 50 dk");
  assert.equal(countdown(iso(NOW + 3 * 86_400_000 + 3_600_000), NOW, t), "3 gün");
  assert.equal(countdown(iso(NOW - 1), NOW, t), undefined);
  assert.equal(countdown(undefined, NOW, t), undefined);
});

test("an Antigravity account's state with the app decides its one button", () => {
  const app = { installed: true, canOpen: true, canSwitch: true, accountId: "g1", saved: ["g1", "g2"] };
  assert.equal(antigravityAccountState(app, "g1"), "current");
  assert.equal(antigravityAccountState(app, "g2"), "saved");
  assert.equal(antigravityAccountState(app, "g3"), "unsaved");
  assert.equal(antigravityAccountState({ ...app, busy: "signing-in", signInFor: "g3" }, "g3"), "waiting");
  // Off macOS Relay cannot move the app: only the account it uses is known.
  assert.equal(antigravityAccountState({ installed: true, canOpen: false, accountId: "g1" }, "g1"), "current");
  assert.equal(antigravityAccountState({ installed: true, canOpen: false, accountId: "g1" }, "g2"), "unavailable");
  assert.equal(antigravityAccountState(undefined, "g1"), "unavailable");
});
