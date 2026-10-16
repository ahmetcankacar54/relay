// Regression tests for the final whole-branch review of the app-shell redesign.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopActionBody } from "../src/app/DesktopActionDialog";
import type { DesktopActionKind } from "../src/features/DesktopActionReview";
import { Banners, reconnectIssues } from "../src/app/Banners";
import { shortcutPage } from "../src/app/routes";
import { AddAccountSteps } from "../src/pages/accounts/AddAccountDialog";
import { AccountSheetBody } from "../src/pages/accounts/AccountSheet";
import { AccountsTable } from "../src/pages/accounts/AccountsTable";
import { AccountsCard } from "../src/pages/overview/AccountsCard";
import { forgetSetupOnLeave } from "../src/pages/Accounts";
import { LimitMeter } from "../src/components/LimitMeter";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type AuthFlow,
  type Snapshot,
} from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const linked = {
  accountUuid: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  savedAt: iso(NOW),
};
const a: Account = {
  id: "a", name: "Kişisel · Max", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW),
  desktop: linked, auth: { loggedIn: true, email: "a@example.com", checkedAt: iso(NOW) },
};
const b: Account = { id: "b", name: "Studio", kind: "personal", group: "personal", color: "blue", createdAt: iso(NOW) };
const accounts = [a, b];

function relayFor(extra: Partial<Relay> = {}, usage: Record<string, AccountUsage> = {}): Relay {
  return {
    api: { desktopHistorySummary: () => new Promise(() => {}) },
    preview: false, error: "", notice: "", accounts, active: a, settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0, activeProfileId: "a" },
    data: { settings: DEFAULT_SETTINGS, usage, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, confirmDesktopAction() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {}, dismissError: async () => {},
    dismissFlow() {}, submitCode() {},
    ...extra,
  } as unknown as Relay;
}
const i18n = (language: Language) => ({
  language,
  setLanguage() {},
  t: (tr: string, en: string) => (language === "tr" ? tr : en),
});
const wrap = (relay: Relay, child: ReactElement, language: Language = "tr") =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18n(language) },
      createElement(RelayContext.Provider, { value: relay }, child),
    ),
  );

// 1. Errors from actions started inside modals must be visible inside the modal.
test("the Desktop action dialog shows the current error as an alert", () => {
  const relay = relayFor({
    desktopRequest: { accountId: "a", kind: "switch" },
    error: "Profile not found",
  });
  const html = wrap(relay, createElement(DesktopActionBody));
  assert.match(html, /role="alert"[^>]*>[\s\S]*Profile not found/);
  const desktopError = wrap(
    relayFor({
      desktopRequest: { accountId: "a", kind: "switch" },
      desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 1, error: "Desktop failed" },
    } as Partial<Relay>),
    createElement(DesktopActionBody),
  );
  assert.match(desktopError, /role="alert"[^>]*>[\s\S]*Desktop failed/);
  assert.doesNotMatch(wrap(relayFor({ desktopRequest: { accountId: "a", kind: "switch" } }), createElement(DesktopActionBody)), /role="alert"/);
});

test("the add-account steps show the current error as an alert", () => {
  const html = wrap(relayFor({ error: "Profile limit reached" }), createElement(AddAccountSteps, { close() {} }));
  assert.match(html, /role="alert"[^>]*>[\s\S]*Profile limit reached/);
  assert.doesNotMatch(wrap(relayFor(), createElement(AddAccountSteps, { close() {} })), /role="alert"/);
});

test("the account sheet shows the current error too, since it covers the page banners", () => {
  const html = wrap(relayFor({ error: "Sheet action failed" }), createElement(AccountSheetBody, { account: b, now: NOW }));
  assert.match(html, /role="alert"[^>]*>[\s\S]*Sheet action failed/);
});

// 2. Browser sign-in started inside the dialog or sheet must be completable there.
const waitingFlow = { id: "f", accountId: "b", status: "waiting", browserReady: true, codeRequested: true } as unknown as AuthFlow;

test("step 3 of the add dialog embeds the browser sign-in controls without the panel id", () => {
  const html = wrap(
    relayFor({ flow: waitingFlow, flowAccount: b }),
    createElement(AddAccountSteps, { close() {}, initial: { step: 3, id: "b" } }),
  );
  assert.match(html, /Kodu gönder/);
  assert.match(html, /Tarayıcıyı yeniden aç/);
  assert.match(html, /İptal et/);
  assert.doesNotMatch(html, /id="cli-connection-panel"/);
  const failed = wrap(
    relayFor({ flow: { ...waitingFlow, status: "failed", codeRequested: false, error: "Sign-in failed badly" }, flowAccount: b }),
    createElement(AddAccountSteps, { close() {}, initial: { step: 3, id: "b" } }),
  );
  assert.match(failed, /Sign-in failed badly/);
  const other = wrap(
    relayFor({ flow: { ...waitingFlow, accountId: "a" }, flowAccount: a }),
    createElement(AddAccountSteps, { close() {}, initial: { step: 3, id: "b" } }),
  );
  assert.doesNotMatch(other, /Kodu gönder/);
});

test("the account sheet embeds the browser sign-in controls for its own flow", () => {
  const html = wrap(relayFor({ flow: waitingFlow, flowAccount: b }), createElement(AccountSheetBody, { account: b, now: NOW }));
  assert.match(html, /Kodu gönder/);
  assert.match(html, /Tarayıcıyı yeniden aç/);
  assert.doesNotMatch(html, /id="cli-connection-panel"/);
  const other = wrap(relayFor({ flow: waitingFlow, flowAccount: b }), createElement(AccountSheetBody, { account: a, now: NOW }));
  assert.doesNotMatch(other, /Kodu gönder/);
});

// 3. Reconnect banners follow the shared rule and offer the matching action.
test("reconnect banners use the shared rule, only for signed-in accounts, and respect dismissal", () => {
  const signedIn = (id: string): Account => ({ ...b, id, name: id, auth: { loggedIn: true, checkedAt: iso(NOW) } });
  const list = [signedIn("x"), signedIn("y"), signedIn("z"), signedIn("k"), signedIn("ok"), { ...b, id: "out", name: "out" }];
  const usage: Record<string, AccountUsage> = {
    x: { accountId: "x", status: "error", issue: "scope", stale: true },
    y: { accountId: "y", status: "error", issue: "renewal-required", stale: true },
    z: { accountId: "z", status: "ready", stale: false, connectionRenewalRequired: true },
    k: { accountId: "k", status: "error", issue: "keychain-locked", stale: true },
    ok: { accountId: "ok", status: "ready", stale: false },
    out: { accountId: "out", status: "error", issue: "expired", stale: true },
  };
  const issues = reconnectIssues(list, usage, new Set());
  assert.deepEqual(
    issues.map((i) => [i.account.id, i.issue, i.action]),
    [
      ["x", "scope", "login"],
      ["y", "renewal-required", "renew"],
      ["z", "renewal-required", "renew"],
      ["k", "keychain-locked", "renew"],
    ],
  );
  assert.deepEqual(
    reconnectIssues(list, usage, new Set(["x:scope", "y:renewal-required"])).map((i) => i.account.id),
    ["z", "k"],
  );
});

test("a renewal banner offers Renew connection and can be dismissed", () => {
  const html = wrap(
    relayFor({}, { a: { accountId: "a", status: "error", issue: "renewal-required", stale: true } }),
    createElement(Banners),
  );
  assert.match(html, /Bağlantıyı yenile/);
  assert.doesNotMatch(html, /Yeniden bağlan/);
  assert.match(html, /aria-label="Uyarıyı kapat"/);
});

// 4. A setup target must not survive leaving the Accounts page.
test("leaving the accounts page forgets the setup target", () => {
  const calls: (string | undefined)[] = [];
  const queued: (() => void)[] = [];
  const effect = forgetSetupOnLeave(() => (id) => calls.push(id), (fn) => queued.push(fn));
  // StrictMode mounts, unmounts and re-mounts at once: the target survives.
  effect()();
  const cleanup = effect();
  queued.splice(0).forEach((fn) => fn());
  assert.deepEqual(calls, []);
  cleanup();
  queued.splice(0).forEach((fn) => fn());
  assert.deepEqual(calls, [undefined]);
});

// 5 + 6. Overview accounts card: Desktop link gating and suffix-free reopening time.
test("the overview Desktop link is disabled while Desktop cannot start a setup", () => {
  const usage: Record<string, AccountUsage> = { a: { accountId: "a", status: "ready", stale: false, checkedAt: iso(NOW), fiveHour: { usedPercent: 10 }, sevenDay: { usedPercent: 10 } } };
  const link = (extra: Partial<Relay>) =>
    wrap(relayFor(extra, usage), createElement(AccountsCard, { go() {}, now: NOW })).match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Desktop’a bağla<\/button>/)?.[0] ?? "";
  assert.doesNotMatch(link({}), /disabled=""/);
  for (const extra of [
    { desktopBusy: true },
    { pendingDesktop: a },
    { desktop: { available: false, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 } },
    { desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: true, errorRevision: 0 } },
  ] as Partial<Relay>[])
    assert.match(link(extra), /disabled=""/, JSON.stringify(extra));
});

test("an exhausted account says when it reopens without a Turkish suffix", () => {
  const other: Account = { ...a, id: "o", name: "Other" };
  const reset = iso(NOW + 2 * 3_600_000);
  const usage: Record<string, AccountUsage> = {
    a: { accountId: "a", status: "ready", stale: false, checkedAt: iso(NOW), fiveHour: { usedPercent: 10 }, sevenDay: { usedPercent: 10 } },
    o: { accountId: "o", status: "ready", stale: false, checkedAt: iso(NOW), fiveHour: { usedPercent: 100, resetsAt: reset }, sevenDay: { usedPercent: 10 } },
  };
  const relay = relayFor({ accounts: [a, other] }, usage);
  const tr = wrap(relay, createElement(AccountsCard, { go() {}, now: NOW }));
  assert.match(tr, /Açılış \d\d:\d\d/);
  assert.doesNotMatch(tr, /&#x27;te açılır/);
  const en = wrap(relay, createElement(AccountsCard, { go() {}, now: NOW }), "en");
  assert.match(en, /Opens \d\d:\d\d/);
});

// 7 + 8. Theme: native controls follow the scheme and small success text has a readable token.
test("the theme declares color-scheme and a success text colour", () => {
  const css = fs.readFileSync(path.join(import.meta.dirname, "../src/styles/theme.css"), "utf8");
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
  assert.match(light, /color-scheme:\s*light/);
  assert.match(light, /--ok-foreground:\s*#2f7a45/);
  assert.match(dark, /color-scheme:\s*dark/);
  assert.match(dark, /--ok-foreground:\s*#7ad694/);
  assert.match(css, /--color-ok-foreground:\s*var\(--ok-foreground\)/);
  const offenders = ["src/features/PlanningPanel.tsx"].filter((f) =>
    /["\s]text-ok["\s]/.test(fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8")),
  );
  assert.deepEqual(offenders, []);
});

// 9. Page shortcuts stay inside an open dialog.
test("page shortcuts are ignored while a dialog is open", () => {
  const key = { key: "2", metaKey: true, ctrlKey: false };
  assert.equal(shortcutPage(key), "hesaplar");
  assert.equal(shortcutPage(key, true), undefined);
  assert.equal(shortcutPage({ ...key, key: "," }, true), undefined);
});

// 10. One tooltip provider for the whole shell.
test("only the shell provides tooltips", () => {
  const dir = path.join(import.meta.dirname, "../src");
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") && !f.includes(`components${path.sep}ui`));
  const users = files.filter((f) => /<TooltipProvider/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(users, [path.join("app", "Shell.tsx")]);
});

// 11. Percent formatting follows the language.
test("limit percentages read %45 in Turkish and 45% in English", () => {
  const meter = (language: Language) =>
    renderToStaticMarkup(
      createElement(I18nContext.Provider, { value: i18n(language) }, createElement(LimitMeter, { label: "x", percent: 45 })),
    );
  assert.match(meter("tr"), />%45</);
  assert.match(meter("en"), />45%</);
  const usage: Record<string, AccountUsage> = { a: { accountId: "a", status: "ready", stale: false, checkedAt: iso(NOW), fiveHour: { usedPercent: 38 }, sevenDay: { usedPercent: 78 } } };
  const table = (language: Language) =>
    wrap(relayFor({}, usage), createElement(AccountsTable, { accounts, open() {}, link() {} }), language);
  assert.match(table("tr"), /%38 · %78/);
  assert.match(table("en"), /38% · 78%/);
});

test("a confirmed Desktop action shows the travelling panda until it finishes", () => {
  const request = { accountId: "b", kind: "switch" as const };
  const running = wrap(relayFor({ desktopRequest: request, busy: "desktop-action:b", desktopBusy: true }), createElement(DesktopActionBody));
  assert.match(/<svg[^>]*data-scene="travel"[^>]*>/.exec(running)?.[0] ?? "", /width="110"/);
  assert.match(running, /Studio hesabına geçiliyor/);
  assert.match(running, /Claude kapanıp yeniden açılıyor…/);
  assert.doesNotMatch(running, /type="checkbox"/);
  // Desktop is busy with something else: the review stays as it is, without the panda.
  const elsewhere = wrap(relayFor({ desktopRequest: request, desktopBusy: true }), createElement(DesktopActionBody));
  assert.doesNotMatch(elsewhere, /data-scene="travel"/);
  assert.match(elsewhere, /type="checkbox"/);
});

test("the travelling panda names what each Desktop action is doing", () => {
  const line = (kind: DesktopActionKind) =>
    wrap(relayFor({ desktopRequest: { accountId: "b", kind }, busy: "desktop-action:b", desktopBusy: true }), createElement(DesktopActionBody));
  assert.match(line("history"), /Ortak geçmiş birleştiriliyor/);
  assert.match(line("cancel"), /Yedek geri yükleniyor/);
  assert.match(line("recover"), /Yedek geri yükleniyor/);
  assert.match(line("capture"), /Açık hesap kaydediliyor/);
  assert.match(line("login"), /Desktop bağlantısı kuruluyor/);
  assert.match(line("reconnect"), /Desktop bağlantısı kuruluyor/);
});
