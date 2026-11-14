import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LimitBars } from "../src/components/LimitBars";
import { LimitRings } from "../src/components/LimitRings";
import { UsageCard } from "../src/features/UsageCard";
import { I18nContext } from "../src/data/i18n";
import {
  limitFull,
  modelLimitFull,
  overviewAccounts,
  usageWindowRows,
  windowElapsed,
} from "../src/data/selectors";
import { accountHealth, modelLimitWords } from "../src/lib/account-health";
import { meterFill } from "../src/lib/meter";
import { quotaWindows } from "../shared/quota-windows";
import { DEFAULT_SETTINGS, type Account, type AccountUsage, type ModelWindow } from "../shared/types";

// Saturday 2026-11-14 10:00 UTC; Fable's week opens on Monday at 05:00 UTC.
const NOW = Date.parse("2026-11-14T10:00:00Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const MONDAY = "2026-11-16T05:00:00.000Z";
const fable = (usedPercent: number, resetsAt = MONDAY): ModelWindow => ({
  key: "seven_day_fable", label: "Fable", model: "fable", usedPercent, resetsAt, weeklyShare: 50,
});
const use = (id: string, five: number, week: number, models: ModelWindow[] = [], extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: id, status: "ready", stale: false, checkedAt: iso(NOW - 60_000),
  fiveHour: { usedPercent: five, resetsAt: iso(NOW + 3 * HOUR) },
  sevenDay: { usedPercent: week, resetsAt: iso(NOW + 3.5 * 86_400_000) },
  ...(models.length ? { modelWindows: models } : {}),
  ...extra,
});
const acct = (id: string): Account => ({
  id, name: id, kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  planning: { plan: "max5", capacityWeight: 1 },
  auth: { loggedIn: true, email: `${id}@example.com`, checkedAt: iso(NOW) },
  desktop: { accountUuid: "00000000-0000-4000-8000-000000000001", orgId: "00000000-0000-4000-8000-000000000002", savedAt: iso(NOW), email: `${id}@example.com` },
});
const tr = (a: string) => a;
const en = (_: string, b: string) => b;
const withI18n = (language: "tr" | "en", node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(I18nContext.Provider, { value: { language, setLanguage() {}, t: language === "tr" ? tr : en } }, node),
  );

test("a model's own limit reads model first, then its period; an Antigravity model is its name alone", () => {
  const rows = usageWindowRows(
    use("a", 38, 78, [
      { key: "antigravity_gemini_3_pro", label: "Gemini 3 Pro", usedPercent: 20 },
      { key: "five_hour_opus", label: "Opus", model: "opus", usedPercent: 10 },
      fable(62),
      { key: "seven_day_oauth_apps", label: "Oauth Apps", usedPercent: 62 },
    ]),
  );
  // The account's two windows first, then the model limits fullest first.
  assert.deepEqual(rows.map((r) => [r.key, r.label.tr, r.label.en, r.period]), [
    ["five_hour", "5 saatlik dönem", "5-hour period", "five_hour"],
    ["seven_day", "Haftalık · tüm modeller", "Weekly · all models", "seven_day"],
    ["seven_day_fable", "Fable · haftalık", "Fable · weekly", "seven_day"],
    ["seven_day_oauth_apps", "Oauth Apps · haftalık", "Oauth Apps · weekly", "seven_day"],
    ["antigravity_gemini_3_pro", "Gemini 3 Pro", "Gemini 3 Pro", undefined],
    ["five_hour_opus", "Opus · 5 saat", "Opus · 5-hour", "five_hour"],
  ]);
  assert.deepEqual(rows.map((r) => !!r.model), [false, false, true, true, true, true]);
});

test("how much of a window has passed: five hours and a week, clamped, unknown without a length or reset", () => {
  assert.equal(windowElapsed({ period: "five_hour", resetsAt: iso(NOW + 3 * HOUR) }, NOW), 0.4);
  assert.equal(windowElapsed({ period: "seven_day", resetsAt: iso(NOW + 3.5 * 86_400_000) }, NOW), 0.5);
  assert.equal(windowElapsed({ period: "five_hour", resetsAt: iso(NOW + 9 * HOUR) }, NOW), 0);
  assert.equal(windowElapsed({ period: "five_hour", resetsAt: iso(NOW - HOUR) }, NOW), 1);
  assert.equal(windowElapsed({ resetsAt: iso(NOW + HOUR) }, NOW), undefined);
  assert.equal(windowElapsed({ period: "seven_day" }, NOW), undefined);
});

test("a spent Fable week is surfaced but never makes the account full", () => {
  const usage = use("a", 20, 40, [fable(100)]);
  assert.deepEqual(modelLimitFull(usage, NOW).map((w) => w.key), ["seven_day_fable"]);
  assert.equal(limitFull(usage, NOW), undefined, "the other models still answer");
  assert.equal(quotaWindows(usage)?.length, 2);
  // Not fresh, or already reset: nothing to say.
  assert.deepEqual(modelLimitFull({ ...usage, stale: true }, NOW), []);
  assert.deepEqual(modelLimitFull(use("a", 20, 40, [fable(100, iso(NOW - HOUR))]), NOW), []);
  assert.deepEqual(modelLimitFull(use("a", 20, 40, [fable(99)]), NOW), []);
});

test("the status names the spent model and when it opens, in both languages", () => {
  const spent = [fable(100)];
  assert.deepEqual(modelLimitWords(spent, NOW, "UTC"), [
    "Fable limiti dolu · Pzt 05:00’te açılır",
    "Fable limit is full · opens Mon 05:00",
  ]);
  // Within a day the clock alone.
  assert.deepEqual(modelLimitWords([fable(100, iso(NOW + 4 * HOUR))], NOW, "UTC"), [
    "Fable limiti dolu · 14:00’te açılır",
    "Fable limit is full · opens 14:00",
  ]);
  assert.equal(modelLimitWords([], NOW), undefined);
  const a = acct("a");
  const context = { active: false, desktopRunning: false, waiting: false, now: NOW, zone: "UTC" };
  const health = accountHealth(a, use("a", 20, 40, spent), context, tr);
  assert.equal(health.tone, "warn");
  assert.equal(health.label, "Fable limiti dolu · Pzt 05:00’te açılır");
  assert.equal(health.fix, undefined);
  assert.equal(accountHealth(a, use("a", 20, 40, spent), context, en).label, "Fable limit is full · opens Mon 05:00");
  // Room left on Fable: plain "Ready".
  assert.equal(accountHealth(a, use("a", 20, 40, [fable(60)]), context, tr).label, "Hazır");
});

test("an account with Fable spent is recommended only when no other is clear", () => {
  const [active, spent, clear] = [acct("active"), acct("spent"), acct("clear")];
  const usage = { spent: use("spent", 0, 10, [fable(100)]), clear: use("clear", 30, 60) };
  const rows = overviewAccounts(active, [active, spent, clear], usage, NOW);
  assert.deepEqual(rows.map((r) => [r.account.id, r.state, r.recommended]), [
    ["spent", "window-open", false],
    ["clear", "window-open", true],
  ]);
  const alone = overviewAccounts(active, [active, spent], usage, NOW);
  assert.deepEqual(alone.map((r) => [r.account.id, r.recommended]), [["spent", true]]);
});

test("limit bars fit the model's name and mark how much of the period has passed", () => {
  const usage = use("a", 62, 30, [fable(80), { key: "antigravity_gemini", label: "Gemini 3 Pro", usedPercent: 10 }]);
  const html = withI18n("tr", createElement(LimitBars, { usage, now: NOW }));
  // The name is never cut: no truncate on it, and the columns size to the longest name.
  assert.match(html, /<span class="text-xs leading-tight text-muted-foreground" title="Fable · haftalık">Fable · haftalık<\/span>/);
  assert.match(html, /grid-cols-\[auto_minmax\(3rem,1fr\)_auto\]/);
  // Five hours: 2 of 5 hours have passed; the week: half.
  const ticks = html.match(/data-slot="pace"[^>]*style="left:([\d.]+)%"/g) ?? [];
  assert.equal(ticks.length, 3, "the five hours, the week and Fable's week; not the Antigravity model");
  assert.match(html, /role="meter" aria-label="5 saatlik dönem"[^>]*aria-valuetext="%62 kullanıldı · Dönemden geçen süre %40; çubuk çizgiyi geçtiyse eşit hızdan hızlı kullanıyorsun"/);
  assert.match(html, /data-slot="pace"[^>]*style="left:40%"/);
  assert.match(html, /data-slot="pace"[^>]*style="left:50%"/);
  // Fable's bar is amber at 80 %, the five hours (62 %) in the calm meter tone.
  assert.match(html, /aria-label="Fable · haftalık"[^>]*><div class="h-full rounded-full bg-warn"/);
  assert.match(html, /aria-label="5 saatlik dönem"[^>]*><div class="h-full rounded-full bg-meter"/);
  // An unknown reading draws neither fill nor tick.
  assert.doesNotMatch(withI18n("en", createElement(LimitBars, { usage, now: NOW, state: "unknown" })), /data-slot="pace"/);
});

test("the panel's rings list a model limit with a bar in its tone, its percent and when it renews", () => {
  const usage = use("a", 20, 40, [fable(100), { key: "five_hour_opus", label: "Opus", model: "opus", usedPercent: 30, resetsAt: iso(NOW + 2 * HOUR) }]);
  const html = withI18n("tr", createElement(LimitRings, { usage, now: NOW, zone: "UTC" }));
  const lines = html.match(/<span data-slot="model-limit".*?<\/span><\/span><\/div>/g) ?? [];
  assert.equal(lines.length, 2);
  assert.match(lines[0], /bg-crit/);
  assert.match(lines[0], /Fable · haftalık <b[^>]*>%100<\/b> · Pazartesi 05:00 · 2 gün/);
  assert.match(lines[1], /bg-meter/);
  assert.match(lines[1], /Opus · 5 saat <b[^>]*>%30<\/b> · 2 sa kaldı/);
  // The ring itself says only the five hours and the week.
  assert.match(html, /role="img" aria-label="5 saatlik dönem %20 · Haftalık · tüm modeller %40"/);
  const stale = withI18n("tr", createElement(LimitRings, { usage, now: NOW, state: "stale" }));
  assert.match(stale, /data-slot="model-limit"[^>]*><span[^>]*><span class="block h-full rounded-full bg-crit opacity-45"/);
});

test("an old reading keeps a model's own limit, faded like the others", () => {
  const usage = use("a", 20, 40, [fable(70)], { stale: true });
  const html = renderToStaticMarkup(
    createElement(UsageCard, {
      usage, settings: DEFAULT_SETTINGS, now: NOW, language: "tr", t: tr, refresh() {}, connect() {},
    }),
  );
  assert.match(html, /<span>Fable · haftalık<\/span>/);
  assert.match(html, /role="meter" aria-label="Fable · haftalık"[^>]*aria-valuenow="70"[^>]*><span class="block h-full rounded-full bg-muted-foreground\/40"/);
});

test("usage fills in a calm neutral, never the action orange; amber and red stay for the warnings", () => {
  assert.equal(meterFill(50), "bg-meter");
  assert.equal(meterFill(75), "bg-warn");
  assert.equal(meterFill(90), "bg-crit");
  const css = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const values = (name: string) => [...css.matchAll(new RegExp(`--${name}: (#[0-9a-f]{6});`, "g"))].map((m) => m[1]);
  const meters = values("meter");
  assert.equal(meters.length, 2, "light and dark");
  for (const brand of values("brand")) assert.ok(!meters.includes(brand), `--meter is not the brand ${brand}`);
});
