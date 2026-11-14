import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { boardOrder, limitStanding, LimitsNow } from "../src/pages/usage/LimitsNow";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type T } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type Snapshot } from "../shared/types";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 13, 23, 30);
const at = (h: number) => new Date(NOW + h * HOUR).toISOString();
const account = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  name: id,
  kind: "personal",
  group: "default",
  color: "#888",
  createdAt: "2026-11-01T00:00:00.000Z",
  ...extra,
});
const ready = (id: string, five: number, week: number, weekIn: number, extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
  fiveHour: { usedPercent: five, resetsAt: at(2) },
  sevenDay: { usedPercent: week, resetsAt: at(weekIn) },
  ...extra,
});

test("the board puts an expiring week first, open ones by their week's end, full ones after, unread last", () => {
  const usage: Record<string, AccountUsage> = {
    alto: ready("alto", 81, 27, 124),
    vertex: ready("vertex", 18, 80, 29.5),
    nova: ready("nova", 0, 0, 165),
    full: ready("full", 100, 50, 60),
  };
  const order = boardOrder([account("nova"), account("alto"), account("none"), account("full"), account("vertex")], usage, NOW);
  assert.deepEqual(order.map((a) => a.id), ["vertex", "alto", "nova", "full", "none"]);
  assert.deepEqual(limitStanding(usage.vertex, NOW), { kind: "expiring", endsAt: at(29.5), left: 20 });
  assert.deepEqual(limitStanding(usage.full, NOW), { kind: "full", opensAt: at(2) });
  assert.deepEqual(limitStanding(undefined, NOW), { kind: "unread" });
});

test("the board shows each account's plan, its windows and Fable's own limit", () => {
  const accounts = [
    account("vertex", { name: "Vertex", auth: { loggedIn: true, checkedAt: at(0), plan: "max20" }, planning: { plan: "max20", capacityWeight: 20 } }),
    account("codex", { name: "Codex", provider: "codex", auth: { loggedIn: true, checkedAt: at(0), subscription: "plus" } }),
  ];
  const usage: Record<string, AccountUsage> = {
    vertex: ready("vertex", 18, 80, 29.5, {
      modelWindows: [{ key: "seven_day_fable", label: "Fable", model: "fable", usedPercent: 100, resetsAt: at(29.5) }],
    }),
    codex: ready("codex", 27, 20, 140),
  };
  const relay = {
    accounts,
    settings: DEFAULT_SETTINGS,
    data: { usage } as unknown as Snapshot,
  } as unknown as Relay;
  const tr: T = (a: string) => a;
  const html = renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { t: tr, language: "tr", setLanguage: () => {} } as never },
      createElement(RelayContext.Provider, { value: relay }, createElement(LimitsNow, { now: NOW })),
    ),
  );
  assert.match(html, /data-slot="limits-now"/);
  assert.match(html, /1\/2|2\/2/);
  assert.match(html, /Max 20×/);
  assert.match(html, /Plus/);
  assert.match(html, /Fable · haftalık %100/);
  assert.match(html, /kullanılmazsa silinir/);
  assert.ok(html.indexOf("Vertex") < html.indexOf("Codex"), "the expiring week first");
});
