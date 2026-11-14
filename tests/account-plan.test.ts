import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanEditor } from "../src/features/PlanEditor";
import { AccountsTable } from "../src/pages/accounts/AccountsTable";
import { ProviderForm } from "../src/pages/accounts/AddAccountProviders";
import { accountPlan, planLabel, planTitle, providerPlan } from "../src/pages/accounts/accountLabels";
import { accountTileLine } from "../src/lib/account-row";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type AccountProvider, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-11-14T10:00:00Z");
const checkedAt = new Date(NOW).toISOString();
const account = (provider: AccountProvider, extra: Partial<Account> = {}): Account => ({
  id: provider, name: `Hesap ${provider}`, kind: "personal", group: "personal", color: "blue",
  createdAt: checkedAt, provider, ...extra,
});
const signedIn = (subscription?: string, plan?: "pro" | "max5" | "max20" | "team"): Account["auth"] => ({
  loggedIn: true, checkedAt, ...(subscription ? { subscription } : {}), ...(plan ? { plan } : {}),
});
type T = (tr: string, en: string) => string;
const tr: T = (tr) => tr;
const en: T = (_tr, en) => en;

test("Codex accounts are named by their ChatGPT plan, never by a Claude plan", () => {
  const words: Record<string, string> = {
    free: "ChatGPT Free", go: "ChatGPT Go", plus: "ChatGPT Plus", pro: "ChatGPT Pro", team: "ChatGPT Team",
    business: "ChatGPT Business", enterprise: "ChatGPT Enterprise", edu: "ChatGPT Edu",
  };
  for (const [word, label] of Object.entries(words))
    assert.equal(accountPlan(account("codex", { auth: signedIn(word) }))?.label, label);
  assert.deepEqual(accountPlan(account("codex", { auth: signedIn("plus") })), {
    label: "ChatGPT Plus", short: "Plus", source: "detected", provider: "codex",
  });
  assert.equal(accountPlan(account("codex", { auth: signedIn("API key") }))?.label, "OpenAI API");
  // A Claude plan picked for it before Relay knew better is not its plan.
  const picked = account("codex", { planning: { plan: "pro", capacityWeight: 1 } });
  assert.equal(accountPlan(picked), undefined);
  assert.equal(planLabel(picked), undefined);
  assert.equal(planLabel({ ...picked, auth: signedIn("plus") }), undefined);
});

test("Antigravity accounts are named by their Google plan; the OAuth placeholder is no plan", () => {
  const words: Record<string, string> = {
    pro: "Google AI Pro", ultra: "Google AI Ultra", free: "Free", standard: "Code Assist Standard", legacy: "Legacy",
  };
  for (const [word, label] of Object.entries(words))
    assert.equal(accountPlan(account("antigravity", { auth: signedIn(word) }))?.label, label);
  assert.equal(accountPlan(account("antigravity", { auth: signedIn("ultra") }))?.short, "AI Ultra");
  assert.equal(accountPlan(account("antigravity", { auth: signedIn("Antigravity OAuth") })), undefined);
  // Google's internal tier ids are not plan names.
  assert.equal(accountPlan(account("antigravity", { auth: signedIn("g1-something") })), undefined);
  assert.equal(accountPlan(account("antigravity")), undefined);
});

test("Claude accounts read the tier from the sign-in, and Enterprise from the subscription", () => {
  const detected = account("claude", { auth: signedIn("max", "max20"), planning: { plan: "max20", capacityWeight: 1 } });
  assert.deepEqual(accountPlan(detected), { label: "Max 20×", short: "Max 20×", source: "detected", provider: "claude" });
  assert.equal(planTitle(detected, accountPlan(detected)!, tr), "Hesaptan algılandı");
  const enterprise = account("claude", { auth: signedIn("enterprise", "team"), planning: { plan: "team", capacityWeight: 4 } });
  assert.equal(accountPlan(enterprise)?.label, "Enterprise");
  assert.equal(planLabel(enterprise), "Enterprise");
  const chosen = account("claude", { planning: { plan: "pro", capacityWeight: 1 } });
  assert.equal(accountPlan(chosen)?.source, "chosen");
  assert.equal(planTitle(chosen, accountPlan(chosen)!, en), "Chosen for planning");
  // An account saved before providers existed is a Claude account.
  assert.equal(accountPlan({ ...chosen, provider: undefined })?.label, "Pro");
});

test("the add dialog's detected plan word is named as the account will be", () => {
  assert.equal(providerPlan("codex", "plus")?.label, "ChatGPT Plus");
  assert.equal(providerPlan("codex", "API key")?.label, "OpenAI API");
  assert.equal(providerPlan("antigravity", "Antigravity OAuth"), undefined);
  assert.equal(providerPlan("codex", undefined), undefined);
});

const editor = (a: Account, t = tr) =>
  renderToStaticMarkup(createElement(PlanEditor, { account: a, disabled: false, update() {}, t }));

test("Planning shows a Codex or Antigravity plan as read, with no Claude plan or capacity to pick", () => {
  const codex = editor(account("codex", { auth: signedIn("plus") }));
  assert.match(codex, /Plan: <span[^>]*>ChatGPT Plus<\/span>/);
  assert.match(codex, />algılandı</);
  assert.doesNotMatch(codex, /Plan seç|Pro · 1×|Max · 5×|Göreli kapasite/);
  const google = editor(account("antigravity", { auth: signedIn("pro") }), en);
  assert.match(google, />Google AI Pro</);
  assert.match(google, />detected</);
  const unread = editor(account("antigravity", { auth: signedIn("Antigravity OAuth") }));
  assert.match(unread, /Plan henüz okunmadı/);
  assert.doesNotMatch(unread, /Plan seç|Göreli kapasite|Oauth/i);
});

test("Planning shows a detected Claude plan, and asks only when none was read", () => {
  const detected = editor(account("claude", { auth: signedIn("max", "max5"), planning: { plan: "max5", capacityWeight: 1 } }));
  assert.match(detected, />Max 5×</);
  assert.match(detected, />algılandı</);
  assert.doesNotMatch(detected, /Plan seç|Göreli kapasite/);
  const unread = editor(account("claude"));
  assert.match(unread, /Plan seç/);
  assert.match(unread, /Göreli kapasite/);
});

function relayFor(accounts: Account[]): Relay {
  return {
    api: {}, preview: false, error: "", notice: "", accounts, active: accounts[0], settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: true, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: { settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {},
  } as unknown as Relay;
}
const wrap = (relay: Relay, child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: { language: "tr", setLanguage() {}, t: tr } },
      createElement(RelayContext.Provider, { value: relay }, child),
    ),
  );

test("the Accounts table and the Overview line name the plan the same way", () => {
  const codex = account("codex", { auth: signedIn("plus") });
  const google = account("antigravity", { auth: signedIn("Antigravity OAuth") });
  const html = wrap(relayFor([codex, google]), createElement(AccountsTable, { accounts: [codex, google], open() {}, link() {} }));
  assert.match(html, /data-slot="badge"[^>]*title="Hesaptan algılandı"[^>]*>ChatGPT Plus<\/span>/);
  assert.doesNotMatch(html, />(Oauth|Plus)</);
  const row = { account: codex, state: "ready", recommended: false } as const;
  assert.equal(accountTileLine(row, tr, "tr", "UTC", NOW).split(" · ")[0], "ChatGPT Plus");
});

test("the add dialog names the detected Codex plan", () => {
  const html = wrap(
    relayFor([]),
    createElement(ProviderForm, {
      provider: "codex",
      form: { name: "OpenAI · Codex", kind: "personal", group: "", apiKey: "" },
      onChange() {},
      session: { provider: "codex", detected: true, plan: "pro", source: "~/.codex/auth.json" },
      onResult() {},
      close() {},
    }),
  );
  assert.match(html, /ChatGPT Pro · ~\/\.codex\/auth\.json/);
});
