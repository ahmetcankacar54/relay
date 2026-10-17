import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Banners, reconnectCause } from "../src/app/Banners";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import {
  dismissalKey,
  getDismissals,
  pruneDismissals,
  resetDismissalsForTests,
} from "../src/data/dismissals";
import { fakeDom } from "./fake-dom";
import {
  DEFAULT_SETTINGS,
  type Account,
  type AccountUsage,
  type Snapshot,
  type UsageIssue,
} from "../shared/types";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const account = (loggedIn = true, id = "a", name = "Kişisel · Max"): Account => ({
  id,
  name,
  kind: "personal",
  group: "personal",
  color: "olive",
  createdAt: iso(NOW),
  auth: { loggedIn, email: "a@example.com", checkedAt: iso(NOW) },
});
const usage = (issue?: UsageIssue, accountId = "a"): AccountUsage => ({
  accountId,
  status: "error",
  stale: true,
  ...(issue ? { issue } : {}),
});
const pick = (language: Language) => (tr: string, en: string) =>
  language === "tr" ? tr : en;

const CAUSES: [string, UsageIssue | undefined, string, string][] = [
  [
    "expired",
    "expired",
    "oturumun süresi doldu ve yenilenemedi",
    "the session expired and could not be renewed",
  ],
  [
    "credentials-missing",
    "credentials-missing",
    "kayıtlı giriş bulunamadı",
    "the saved sign-in was not found",
  ],
  [
    "scope",
    "scope",
    "giriş kullanım verisine erişemiyor",
    "the sign-in cannot read usage",
  ],
  [
    "identity-mismatch",
    "identity-mismatch",
    "giriş başka bir hesaba ait",
    "the sign-in belongs to another account",
  ],
  [
    "anything else",
    "unavailable",
    "bağlantı kullanılamıyor",
    "the connection is unavailable",
  ],
  [
    "no issue at all",
    undefined,
    "bağlantı kullanılamıyor",
    "the connection is unavailable",
  ],
];

test("reconnectCause names the cause for every row, in both languages", () => {
  const out = account(false);
  assert.equal(
    reconnectCause(out, usage("expired"), pick("tr")),
    "giriş yapılmamış",
  );
  assert.equal(reconnectCause(out, undefined, pick("en")), "not signed in");
  for (const [name, issue, tr, en] of CAUSES) {
    assert.equal(reconnectCause(account(), usage(issue), pick("tr")), tr, name);
    assert.equal(reconnectCause(account(), usage(issue), pick("en")), en, name);
  }
  // A missing usage record is not a crash.
  assert.equal(
    reconnectCause(account(), undefined, pick("tr")),
    "bağlantı kullanılamıyor",
  );
});

function relayFor(
  usages: Record<string, AccountUsage>,
  accounts: Account[] = [account()],
  loaded = true,
): Relay {
  return {
    api: {},
    preview: false,
    error: "",
    notice: "",
    accounts,
    active: accounts[0],
    settings: DEFAULT_SETTINGS,
    busy: "",
    usageBusy: new Set<string>(),
    desktopBusy: false,
    desktop: {
      available: true,
      running: true,
      organizations: [],
      busy: false,
      recoveryRequired: false,
      errorRevision: 0,
    },
    data: loaded
      ? ({
          settings: DEFAULT_SETTINGS,
          usage: usages,
          accounts,
          authFlows: [],
        } as unknown as Snapshot)
      : undefined,
    setNotice() {},
    startCli: async () => {},
    refreshUsage: async () => {},
    dismissError: async () => {},
  } as unknown as Relay;
}
const tree = (relay: Relay, language: Language, props: { initialExpanded?: boolean } = {}) =>
  createElement(
    I18nContext.Provider,
    { value: { language, setLanguage() {}, t: pick(language) } },
    createElement(
      RelayContext.Provider,
      { value: relay },
      createElement(Banners, props),
    ),
  );
const render = (relay: Relay, language: Language = "tr", props: { initialExpanded?: boolean } = {}) =>
  renderToStaticMarkup(tree(relay, language, props));

test("the sign-in banner says what is wrong and what Reconnect does", () => {
  const tr = render(relayFor({ a: usage("expired") }));
  assert.match(
    tr,
    /Kişisel · Max · limit okuma girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./,
  );
  assert.match(
    tr,
    /Yeniden bağlan, tarayıcıda bu hesabın limit okuma girişini açar\. Onaylayınca uyarı kapanır\./,
  );
  assert.match(tr, /<button[^>]*>Yeniden bağlan<\/button>/);
  const en = render(relayFor({ a: usage("scope") }), "en");
  assert.match(
    en,
    /Kişisel · Max · the usage sign-in needs to be renewed: the sign-in cannot read usage\./,
  );
  assert.match(
    en,
    /Reconnect opens this account’s usage sign-in in the browser\. The warning closes once you approve it\./,
  );
});

test("the explanation belongs to the sign-in banner only, not to the renewal banner", () => {
  const html = render(relayFor({ a: usage("renewal-required") }));
  assert.match(html, /Bağlantıyı yenile/);
  assert.doesNotMatch(html, /Yeniden bağlan, tarayıcıda/);
  assert.doesNotMatch(html, /oturumun süresi doldu/);
});

// Grouping and dismissal. The dismissal store is shared by every Banners, so each test starts empty.
const KEY = "relay.dismissed.v1";
let stored = new Map<string, string>();
const storage = () => ({
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
});
/** A fresh window and an empty store, as a restart gives. `seed` is what the last run left behind. */
const restart = (seed: string[] = []) => {
  stored = new Map(seed.length > 0 ? [[KEY, JSON.stringify(seed)]] : []);
  Object.assign(globalThis, { window: { localStorage: storage() } });
  resetDismissalsForTests();
};
beforeEach(() => restart());
afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
  resetDismissalsForTests();
});

const max = account(true, "a", "Kişisel · Max");
const team = account(true, "b", "İş · Team");
const pro = account(true, "c", "Ek · Pro");
const healthy = account(true, "ok", "Sağlam");
const ready = (id: string): AccountUsage => ({ accountId: id, status: "ready", stale: false });
const all3 = {
  a: usage("expired", "a"),
  b: usage("renewal-required", "b"),
  c: usage("keychain-locked", "c"),
};
const banners = (html: string) => html.split("bg-warn/10").length - 1;

test("one warning renders as a single banner, even beside healthy accounts", () => {
  const html = render(relayFor({ a: usage("expired"), ok: ready("ok") }, [max, healthy]));
  assert.equal(banners(html), 1);
  assert.match(html, /Kişisel · Max · limit okuma girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./);
  assert.match(html, /<button[^>]*>Yeniden bağlan<\/button>/);
  assert.match(html, /aria-label="Uyarıyı kapat"/);
  assert.doesNotMatch(html, /ilgi bekliyor|aria-expanded|Göster/);
  const renew = render(relayFor({ b: usage("renewal-required", "b") }, [team]));
  assert.match(renew, /İş · Team · limit okuma girişinin yenilenmesi gerekiyor\./);
  assert.match(renew, /<button[^>]*>Bağlantıyı yenile<\/button>/);
  assert.doesNotMatch(renew, /ilgi bekliyor|aria-expanded/);
});

test("two or more warnings share one banner with a count and a Show button", () => {
  const html = render(relayFor(all3, [max, team, pro]));
  assert.equal(banners(html), 1);
  assert.match(html, /3 hesabın girişi ilgi bekliyor\./);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Göster<\/button>/);
  assert.equal(html.split('aria-label="Tüm uyarıları kapat"').length - 1, 1);
  // Collapsed, none of the rows are drawn.
  assert.doesNotMatch(html, /Kişisel · Max|Yeniden bağlan|Bağlantıyı yenile|Anahtarlık erişimine izin ver/);
  const en = render(relayFor(all3, [max, team, pro]), "en");
  assert.match(en, /3 accounts need sign-in attention\./);
  assert.match(en, /<button[^>]*aria-expanded="false"[^>]*>Show<\/button>/);
  assert.match(en, /aria-label="Dismiss all warnings"/);
  const two = render(relayFor({ a: all3.a, b: all3.b }, [max, team]));
  assert.match(two, /2 hesabın girişi ilgi bekliyor\./);
});

test("the expanded group lists a row per warning with today's text, button and dismiss", () => {
  const html = render(relayFor(all3, [max, team, pro]), "tr", { initialExpanded: true });
  assert.equal(banners(html), 1, "the rows live inside the one banner");
  assert.match(html, /3 hesabın girişi ilgi bekliyor\./);
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*>Gizle<\/button>/);
  assert.match(html, /Kişisel · Max · limit okuma girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./);
  assert.match(html, /Yeniden bağlan, tarayıcıda bu hesabın limit okuma girişini açar\./);
  assert.match(html, /İş · Team · limit okuma girişinin yenilenmesi gerekiyor\./);
  assert.match(html, /Ek · Pro · limitleri okumak için Anahtarlık erişimi gerekiyor\./);
  for (const label of ["Yeniden bağlan", "Bağlantıyı yenile", "Anahtarlık erişimine izin ver"])
    assert.equal(html.split(`>${label}</button>`).length - 1, 1, label);
  for (const name of ["Kişisel · Max", "İş · Team", "Ek · Pro"])
    assert.match(html, new RegExp(`aria-label="${name} uyarısını kapat"`), name);
  assert.match(html, /aria-label="Tüm uyarıları kapat"/);
  const en = render(relayFor(all3, [max, team, pro]), "en", { initialExpanded: true });
  assert.match(en, /<button[^>]*aria-expanded="true"[^>]*>Hide<\/button>/);
  assert.match(en, /aria-label="Dismiss warning for İş · Team"/);
  assert.match(en, /Allow Keychain access/);
});

test("a dismissed warning stays hidden after a remount and a restart", () => {
  const relay = relayFor({ a: usage("expired") });
  assert.equal(banners(render(relay)), 1);
  // A restart: the last run left the dismissal in storage.
  restart([dismissalKey("a", "expired")]);
  assert.equal(banners(render(relay)), 0);
  assert.equal(banners(render(relay)), 0, "and again on a second mount");
  // A different issue on the same account is a new warning.
  assert.equal(banners(render(relayFor({ a: usage("scope") }))), 1);
});

test("dismissed warnings leave the group, and the group gives way to a single banner", () => {
  const relay = relayFor(all3, [max, team, pro]);
  restart([dismissalKey("a", "expired")]);
  assert.match(render(relay), /2 hesabın girişi ilgi bekliyor\./);
  restart([dismissalKey("a", "expired"), dismissalKey("b", "renewal-required")]);
  const one = render(relay);
  assert.equal(banners(one), 1);
  assert.match(one, /Ek · Pro · limitleri okumak için Anahtarlık erişimi gerekiyor\./);
  assert.doesNotMatch(one, /ilgi bekliyor|aria-expanded/);
  restart(["a:expired", "b:renewal-required", "c:keychain-locked"]);
  assert.equal(banners(render(relay)), 0);
});

test("after the issue goes away and comes back, the warning shows again", () => {
  const relay = relayFor({ a: usage("expired") });
  restart(["a:expired"]);
  assert.equal(banners(render(relay)), 0);
  // While it keeps happening, the dismissal holds.
  pruneDismissals(["a:expired"]);
  assert.equal(banners(render(relay)), 0);
  // The issue went away (the current issues no longer include it), then it came back.
  pruneDismissals([]);
  assert.equal(banners(render(relay)), 1);
});

/**
 * The drawn tree, read from the fake DOM. It keeps attributes but not the text React sets through
 * `textContent`, so buttons are found by their labels, sizes and ARIA state, not by their words.
 */
interface FakeNode {
  tagName: string;
  attributes: Map<string, string>;
  childNodes: FakeNode[];
}
const drawn = (node: FakeNode, found: FakeNode[] = []): FakeNode[] => {
  found.push(node);
  for (const child of node.childNodes) drawn(child, found);
  return found;
};
const buttonsIn = (container: unknown) =>
  drawn(container as FakeNode).filter((n) => n.tagName === "button");
const labelled = (container: unknown, label: string) =>
  buttonsIn(container).find((b) => b.attributes.get("aria-label") === label);
/** The group's Show / Hide button: the only one with an expanded state. */
const toggle = (container: unknown) =>
  buttonsIn(container).find((b) => b.attributes.has("aria-expanded"));
/** The small outline buttons in the rows: each warning's own Reconnect, Renew or Keychain. */
const rowActions = (container: unknown) =>
  buttonsIn(container).filter(
    (b) => b.attributes.get("data-size") === "sm" && !b.attributes.has("aria-expanded"),
  );

test("Banners prunes dismissals of issues that went away, but never while loading", async () => {
  restart(["a:expired", "gone:scope"]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (relay: Relay) => act(async () => root.render(tree(relay, "tr")));
    // The first snapshot has not arrived: no issues are known, and none may be pruned.
    await mount(relayFor({}, [], false));
    assert.deepEqual([...getDismissals()].sort(), ["a:expired", "gone:scope"]);
    // Loaded: `a` still has its issue (dismissed, so hidden); `gone` has none.
    await mount(relayFor({ a: usage("expired") }));
    assert.deepEqual([...getDismissals()], ["a:expired"]);
    assert.equal(stored.get(KEY), JSON.stringify(["a:expired"]));
    assert.equal(labelled(dom.container, "Uyarıyı kapat"), undefined, "still dismissed");
    // The issue goes away, and the dismissal goes with it.
    await mount(relayFor({ a: ready("a") }));
    assert.deepEqual([...getDismissals()], []);
    // It comes back and shows.
    await mount(relayFor({ a: usage("expired") }));
    assert.ok(labelled(dom.container, "Uyarıyı kapat"));
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the group opens and closes, and its dismiss buttons clear one row or all", async () => {
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const started: string[] = [];
    const relay = {
      ...relayFor(all3, [max, team, pro]),
      startCli: async (a: Account) => void started.push(a.id),
    } as Relay;
    const c = dom.container;
    let root = createRoot(c as unknown as Element);
    await act(async () => root.render(tree(relay, "tr")));
    const click = (node: FakeNode | undefined) => {
      assert.ok(node, "the button is drawn");
      return act(async () => dom.dispatch(node, "click", { detail: 1 }));
    };
    // Collapsed: the group's own buttons, and no rows.
    assert.equal(toggle(c)?.attributes.get("aria-expanded"), "false");
    assert.ok(labelled(c, "Tüm uyarıları kapat"));
    assert.equal(labelled(c, "Uyarıyı kapat"), undefined, "not the single banner");
    assert.equal(rowActions(c).length, 0);
    // Show lists a row per warning; Hide takes them away again.
    await click(toggle(c));
    assert.equal(toggle(c)?.attributes.get("aria-expanded"), "true");
    assert.equal(rowActions(c).length, 3);
    await click(toggle(c));
    assert.equal(toggle(c)?.attributes.get("aria-expanded"), "false");
    assert.equal(rowActions(c).length, 0);
    await click(toggle(c));
    // A row's own button runs its action and does not dismiss it.
    await click(rowActions(c)[0]);
    assert.deepEqual(started, ["a"]);
    assert.deepEqual([...getDismissals()], []);
    // A row's dismiss clears only that row, and the group follows the count.
    await click(labelled(c, "Kişisel · Max uyarısını kapat"));
    assert.deepEqual([...getDismissals()], ["a:expired"]);
    assert.equal(labelled(c, "Kişisel · Max uyarısını kapat"), undefined);
    assert.ok(labelled(c, "İş · Team uyarısını kapat"), "the group stays open");
    assert.equal(rowActions(c).length, 2);
    // Down to one warning, the group gives way to a single banner.
    await click(labelled(c, "İş · Team uyarısını kapat"));
    assert.equal(toggle(c), undefined);
    assert.ok(labelled(c, "Uyarıyı kapat"));
    // The issues go away and return (a prune), so the group is back; its dismiss clears every warning.
    await act(async () => pruneDismissals([]));
    assert.ok(toggle(c));
    await click(labelled(c, "Tüm uyarıları kapat"));
    assert.deepEqual([...getDismissals()].sort(), ["a:expired", "b:renewal-required", "c:keychain-locked"]);
    assert.equal(toggle(c), undefined);
    assert.equal(labelled(c, "Uyarıyı kapat"), undefined);
    assert.equal(stored.get(KEY), JSON.stringify([...getDismissals()]));
    // A new mount, as another page gives, shows nothing.
    await act(async () => root.unmount());
    root = createRoot(c as unknown as Element);
    await act(async () => root.render(tree(relay, "tr")));
    assert.equal(toggle(c), undefined);
    assert.equal(labelled(c, "Uyarıyı kapat"), undefined);
    assert.equal(buttonsIn(c).length, 0);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});
