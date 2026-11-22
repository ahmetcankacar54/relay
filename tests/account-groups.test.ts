import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountsTable } from "../src/pages/accounts/AccountsTable";
import { groupAccounts, readAccountsView, workGroupKey, type AccountSort } from "../src/pages/accounts/accountGroups";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext } from "../src/data/i18n";
import { i18nValue, testT } from "./i18n";
import { DEFAULT_SETTINGS, type Account, type AccountProvider, type AccountUsage, type Snapshot } from "../shared/types";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const en = testT("en");

const account = (id: string, extra: Partial<Account> = {}): Account => ({
  id,
  name: id,
  kind: "work",
  group: "work:a",
  color: "olive",
  createdAt: new Date(NOW).toISOString(),
  ...extra,
});
const of = (provider: AccountProvider, id: string, group: string, extra: Partial<Account> = {}) => account(id, { provider, group, ...extra });

const sections = (accounts: Account[], o: { by?: "provider" | "workGroup" | "none"; sort?: AccountSort; usage?: Record<string, AccountUsage>; language?: string } = {}) =>
  groupAccounts(accounts, { by: o.by ?? "provider", sort: o.sort ?? "default", usage: o.usage ?? {}, now: NOW, language: o.language ?? "en", t: en });

test("by provider: a provider whose accounts span two work groups lists them as children, named groups in order", () => {
  const list = [of("claude", "c1", "work:b"), of("claude", "c2", "work:a"), of("codex", "x1", "work:a"), of("claude", "c3", "work:a")];
  const result = sections(list);
  assert.deepEqual(result.map((s) => s.key), ["provider:claude", "provider:codex"]);
  const [claude, codex] = result;
  assert.equal(claude.label, "Claude");
  assert.deepEqual(claude.accounts, []);
  assert.deepEqual(claude.children.map((c) => [c.key, c.level, c.label, c.accounts.map((a) => a.id)]), [
    ["provider:claude/group:work:a", 1, "a", ["c2", "c3"]],
    ["provider:claude/group:work:b", 1, "b", ["c1"]],
  ]);
  assert.deepEqual(codex.children, []);
  assert.deepEqual(codex.accounts.map((a) => a.id), ["x1"]);
});

test("an account in its own workspace is 'separate' and its group comes last, after personal and the named ones", () => {
  const own = account("solo", { group: "work:solo" });
  assert.equal(workGroupKey(own), "separate");
  assert.equal(workGroupKey(account("p", { kind: "personal", group: "personal" })), "personal");
  assert.equal(workGroupKey(account("n", { group: "work:team" })), "work:team");
  const result = sections([own, account("n", { group: "work:team" }), account("p", { kind: "personal", group: "personal" })], { by: "workGroup" });
  assert.deepEqual(result.map((s) => [s.key, s.label]), [
    ["group:personal", "Personal"],
    ["group:work:team", "team"],
    ["group:separate", "Separate workspaces"],
  ]);
  // Below a provider the same order holds.
  const nested = sections([own, account("n", { group: "work:team" })]);
  assert.deepEqual(nested[0].children.map((c) => c.key), ["provider:claude/group:work:team", "provider:claude/group:separate"]);
});

test("sort by name follows the language's collation", () => {
  const list = ["b", "Ä", "a"].map((name, i) => account(`n${i}`, { name }));
  const [only] = sections(list, { sort: "name", language: "de" });
  assert.deepEqual(only.accounts.map((a) => a.name), ["a", "Ä", "b"]);
});

test("sort by five-hour use puts the least used first and unknown usage last", () => {
  const list = [account("unread"), account("high"), account("low")];
  const usage: Record<string, AccountUsage> = {
    high: { accountId: "high", status: "ready", stale: false, fiveHour: { usedPercent: 80 } },
    low: { accountId: "low", status: "ready", stale: false, fiveHour: { usedPercent: 10 } },
  };
  const [only] = sections(list, { sort: "usage", usage });
  assert.deepEqual(only.accounts.map((a) => a.id), ["low", "high", "unread"]);
});

test("no grouping is one headerless section in input order", () => {
  const list = [of("codex", "x", "work:a"), of("claude", "c", "work:b")];
  assert.deepEqual(sections(list, { by: "none" }).map((s) => [s.key, s.label, s.accounts.map((a) => a.id)]), [["all", "", ["x", "c"]]]);
});

test("the stored view falls back to defaults for missing or broken values", () => {
  const stored = (values: Record<string, string>) => readAccountsView((key) => values[key] ?? null);
  assert.deepEqual(stored({}), { groupBy: "provider", sort: "default", collapsed: [] });
  assert.deepEqual(stored({ "relay.accounts.collapsed": "{not json", "relay.accounts.groupBy": "planet" }).collapsed, []);
  assert.deepEqual(stored({ "relay.accounts.collapsed": "{\"a\":1}" }).collapsed, []);
  assert.deepEqual(stored({ "relay.accounts.groupBy": "planet", "relay.accounts.sort": "random" }), { groupBy: "provider", sort: "default", collapsed: [] });
  assert.deepEqual(
    stored({ "relay.accounts.groupBy": "workGroup", "relay.accounts.sort": "name", "relay.accounts.collapsed": "[\"provider:codex\", 3]" }),
    { groupBy: "workGroup", sort: "name", collapsed: ["provider:codex"] },
  );
  assert.deepEqual(readAccountsView(() => {
    throw new Error("no storage");
  }), { groupBy: "provider", sort: "default", collapsed: [] });
});

const relayFor = (accounts: Account[]): Relay =>
  ({
    api: { extensionStatus: async () => undefined, checkExtension: async () => undefined, terminalStatus: async () => undefined, checkTerminal: async () => undefined },
    preview: false, error: "", notice: "", accounts, active: undefined, settings: DEFAULT_SETTINGS, busy: "",
    usageBusy: new Set<string>(), desktopBusy: false, hasUnclaimedDesktop: false, targetOrg: "", historyRevision: 0,
    desktop: { available: true, running: false, organizations: [], busy: false, recoveryRequired: false, errorRevision: 0 },
    data: { settings: DEFAULT_SETTINGS, usage: {}, accounts, authFlows: [] } as unknown as Snapshot,
    requestDesktop() {}, setSetupId() {}, cancelDesktopRequest() {}, setOrg() {}, setNotice() {},
    startCli: async () => {}, refreshUsage: async () => {}, action: async () => {},
  }) as unknown as Relay;

const render = (accounts: Account[], props: Partial<Parameters<typeof AccountsTable>[0]>) =>
  renderToStaticMarkup(
    createElement(
      I18nContext.Provider,
      { value: i18nValue("en") },
      createElement(
        RelayContext.Provider,
        { value: relayFor(accounts) },
        createElement(AccountsTable, { accounts, open() {}, link() {}, ...props }),
      ),
    ),
  );

test("a collapsed section's header says so and its rows are not drawn; the others stay open", () => {
  const list = [of("claude", "c1", "work:a"), of("codex", "x1", "work:a")];
  const html = render(list, { collapsed: ["provider:codex"], toggle() {} });
  assert.match(html, /data-slot="list-group" data-provider="codex"[^>]*aria-expanded="false" aria-controls="accounts-provider:codex"/);
  assert.match(html, /data-slot="list-group" data-provider="claude"[^>]*aria-expanded="true"/);
  assert.match(html, /data-account="c1"/);
  assert.doesNotMatch(html, /data-account="x1"/);
  assert.match(html, /id="accounts-provider:codex" role="group" aria-label="Codex" hidden=""/);
});

test("rows open through their name, the one keyboard stop, and nest under work groups", () => {
  const list = [of("claude", "c1", "work:a"), of("claude", "c2", "work:b")];
  const html = render(list, { toggle() {} });
  const row = html.slice(html.indexOf('data-slot="list-row"'));
  assert.doesNotMatch(row.slice(0, row.indexOf(">")), /role="button"|tabindex/);
  assert.match(row, /<button type="button" data-list-nav="" class="[^"]*" title="c1">c1<\/button>/);
  // Provider (level 0) then its work group (level 1) and the row indented twice.
  assert.match(html, /data-slot="list-section" id="accounts-provider:claude"[\s\S]*?data-slot="list-section" id="accounts-provider:claude\/group:work:a"[\s\S]*?data-slot="list-row"[^>]*class="[^"]*ps-14/);
});

test("without provider groups each row carries its provider's mark", () => {
  const list = [of("codex", "x1", "work:a")];
  const html = render(list, { groupBy: "none" });
  assert.doesNotMatch(html, /data-slot="list-group"/);
  assert.match(html, /data-slot="list-row"[\s\S]*?data-slot="provider-logo" data-provider="codex"/);
});
