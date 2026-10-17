import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Banners, reconnectCause, reconnectIssues } from "../src/app/Banners";
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
const account = (
  loggedIn = true,
  id = "a",
  name = "Kişisel · Max",
): Account => ({
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
  authFlows: unknown[] = [],
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
          authFlows,
        } as unknown as Snapshot)
      : undefined,
    setNotice() {},
    startCli: async () => {},
    refreshUsage: async () => {},
    dismissError: async () => {},
  } as unknown as Relay;
}
const tree = (
  relay: Relay,
  language: Language,
  props: { initialExpanded?: boolean } = {},
) =>
  createElement(
    I18nContext.Provider,
    { value: { language, setLanguage() {}, t: pick(language) } },
    createElement(
      RelayContext.Provider,
      { value: relay },
      createElement(Banners, props),
    ),
  );
const render = (
  relay: Relay,
  language: Language = "tr",
  props: { initialExpanded?: boolean } = {},
) => renderToStaticMarkup(tree(relay, language, props));

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
/** How many times the store was written since the restart. */
let writes = 0;
const storage = () => ({
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes++;
    stored.set(key, value);
  },
});
/** A fresh window and an empty store, as a restart gives. `seed` is what the last run left behind. */
const restart = (seed: string[] = []) => {
  stored = new Map(seed.length > 0 ? [[KEY, JSON.stringify(seed)]] : []);
  writes = 0;
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
const ready = (id: string): AccountUsage => ({
  accountId: id,
  status: "ready",
  stale: false,
});
const all3 = {
  a: usage("expired", "a"),
  b: usage("renewal-required", "b"),
  c: usage("keychain-locked", "c"),
};
const banners = (html: string) => html.split("bg-warn/10").length - 1;

test("one warning renders as a single banner, even beside healthy accounts", () => {
  const html = render(
    relayFor({ a: usage("expired"), ok: ready("ok") }, [max, healthy]),
  );
  assert.equal(banners(html), 1);
  assert.match(
    html,
    /Kişisel · Max · limit okuma girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./,
  );
  assert.match(html, /<button[^>]*>Yeniden bağlan<\/button>/);
  assert.match(html, /aria-label="Uyarıyı kapat"/);
  assert.doesNotMatch(html, /ilgi bekliyor|aria-expanded|Göster/);
  const renew = render(relayFor({ b: usage("renewal-required", "b") }, [team]));
  assert.match(
    renew,
    /İş · Team · limit okuma girişinin yenilenmesi gerekiyor\./,
  );
  assert.match(renew, /<button[^>]*>Bağlantıyı yenile<\/button>/);
  assert.doesNotMatch(renew, /ilgi bekliyor|aria-expanded/);
});

test("two or more warnings share one banner with a count and a Show button", () => {
  const html = render(relayFor(all3, [max, team, pro]));
  assert.equal(banners(html), 1);
  assert.match(html, /3 hesabın limit okuma girişi ilgi bekliyor\./);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>Göster<\/button>/);
  assert.equal(html.split('aria-label="Tüm uyarıları kapat"').length - 1, 1);
  // Collapsed, none of the rows are drawn.
  assert.doesNotMatch(
    html,
    /Kişisel · Max|Yeniden bağlan|Bağlantıyı yenile|Anahtarlık erişimine izin ver/,
  );
  const en = render(relayFor(all3, [max, team, pro]), "en");
  assert.match(en, /3 accounts need usage sign-in attention\./);
  assert.match(en, /<button[^>]*aria-expanded="false"[^>]*>Show<\/button>/);
  assert.match(en, /aria-label="Dismiss all warnings"/);
  const two = render(relayFor({ a: all3.a, b: all3.b }, [max, team]));
  assert.match(two, /2 hesabın limit okuma girişi ilgi bekliyor\./);
});

test("the expanded group lists a row per warning with today's text, button and dismiss", () => {
  const html = render(relayFor(all3, [max, team, pro]), "tr", {
    initialExpanded: true,
  });
  assert.equal(banners(html), 1, "the rows live inside the one banner");
  assert.match(html, /3 hesabın limit okuma girişi ilgi bekliyor\./);
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*>Gizle<\/button>/);
  assert.match(
    html,
    /Kişisel · Max · limit okuma girişinin yenilenmesi gerekiyor: oturumun süresi doldu ve yenilenemedi\./,
  );
  assert.match(
    html,
    /Yeniden bağlan, tarayıcıda bu hesabın limit okuma girişini açar\./,
  );
  assert.match(
    html,
    /İş · Team · limit okuma girişinin yenilenmesi gerekiyor\./,
  );
  assert.match(
    html,
    /Ek · Pro · limitleri okumak için Anahtarlık erişimi gerekiyor\./,
  );
  for (const label of [
    "Yeniden bağlan",
    "Bağlantıyı yenile",
    "Anahtarlık erişimine izin ver",
  ])
    assert.equal(html.split(`>${label}</button>`).length - 1, 1, label);
  // Each row's button says which account it is for, after its visible label.
  for (const [label, name] of [
    ["Yeniden bağlan", "Kişisel · Max"],
    ["Bağlantıyı yenile", "İş · Team"],
    ["Anahtarlık erişimine izin ver", "Ek · Pro"],
  ])
    assert.match(
      html,
      new RegExp(
        `<button[^>]*aria-label="${label} · ${name}"[^>]*>${label}</button>`,
      ),
      name,
    );
  for (const name of ["Kişisel · Max", "İş · Team", "Ek · Pro"])
    assert.match(
      html,
      new RegExp(`aria-label="${name} uyarısını kapat"`),
      name,
    );
  assert.match(html, /aria-label="Tüm uyarıları kapat"/);
  const en = render(relayFor(all3, [max, team, pro]), "en", {
    initialExpanded: true,
  });
  assert.match(en, /<button[^>]*aria-expanded="true"[^>]*>Hide<\/button>/);
  assert.match(en, /aria-label="Dismiss warning for İş · Team"/);
  assert.match(en, /Allow Keychain access/);
  assert.match(en, /aria-label="Reconnect · Kişisel · Max"/);
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
  assert.match(render(relay), /2 hesabın limit okuma girişi ilgi bekliyor\./);
  restart([
    dismissalKey("a", "expired"),
    dismissalKey("b", "renewal-required"),
  ]);
  const one = render(relay);
  assert.equal(banners(one), 1);
  assert.match(
    one,
    /Ek · Pro · limitleri okumak için Anahtarlık erişimi gerekiyor\./,
  );
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
    (b) =>
      b.attributes.get("data-size") === "sm" &&
      !b.attributes.has("aria-expanded"),
  );

test("Banners prunes dismissals of issues that went away, but never while loading", async () => {
  restart(["a:expired", "gone:scope"]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (relay: Relay) =>
      act(async () => root.render(tree(relay, "tr")));
    // The first snapshot has not arrived: no issues are known, and none may be pruned.
    await mount(relayFor({}, [], false));
    assert.deepEqual([...getDismissals()].sort(), ["a:expired", "gone:scope"]);
    // Loaded: `a` still has its issue (dismissed, so hidden); `gone` has none.
    await mount(relayFor({ a: usage("expired") }));
    assert.deepEqual([...getDismissals()], ["a:expired"]);
    assert.equal(stored.get(KEY), JSON.stringify(["a:expired"]));
    assert.equal(
      labelled(dom.container, "Uyarıyı kapat"),
      undefined,
      "still dismissed",
    );
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
    assert.equal(
      labelled(c, "Uyarıyı kapat"),
      undefined,
      "not the single banner",
    );
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
    const before = writes;
    await click(labelled(c, "Tüm uyarıları kapat"));
    assert.equal(writes, before + 1, "dismissing all writes once");
    assert.deepEqual([...getDismissals()].sort(), [
      "a:expired",
      "b:renewal-required",
      "c:keychain-locked",
    ]);
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

const idle = (id: string): AccountUsage => ({
  accountId: id,
  status: "idle",
  stale: false,
});
const loading = (id: string): AccountUsage => ({
  accountId: id,
  status: "loading",
  stale: false,
});

test("a restart keeps the dismissals until each account's first read settles", async () => {
  // The usage cache is in memory: right after launch every logged-in account is idle, with no issue.
  restart(["a:expired", "b:renewal-required", "c:scope"]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (usages: Record<string, AccountUsage>) =>
      act(async () =>
        root.render(tree(relayFor(usages, [max, team, pro]), "tr")),
      );
    const keys = () => [...getDismissals()].sort();
    // Idle, loading and no record at all are all "not read yet".
    await mount({ a: idle("a"), b: loading("b") });
    assert.deepEqual(keys(), ["a:expired", "b:renewal-required", "c:scope"]);
    assert.equal(
      stored.get(KEY),
      JSON.stringify(["a:expired", "b:renewal-required", "c:scope"]),
    );
    assert.equal(writes, 0, "nothing was pruned or written");
    // a is read and has no issue any more: only its key goes. b is still unread.
    await mount({ a: ready("a"), b: idle("b") });
    assert.deepEqual(keys(), ["b:renewal-required", "c:scope"]);
    // c is read and still has its issue: it stays dismissed, and b is still waiting.
    await mount({ a: ready("a"), b: idle("b"), c: usage("scope", "c") });
    assert.deepEqual(keys(), ["b:renewal-required", "c:scope"]);
    // b fails with another issue: its old key goes, and the new warning shows.
    await mount({
      a: ready("a"),
      b: usage("scope", "b"),
      c: usage("scope", "c"),
    });
    assert.deepEqual(keys(), ["c:scope"]);
    assert.ok(
      labelled(dom.container, "Uyarıyı kapat"),
      "b's new warning shows alone",
    );
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("an account signed out is not waiting for a read, so its dismissals are pruned", async () => {
  restart(["a:expired"]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () =>
      root.render(
        tree(relayFor({ a: idle("a") }, [account(false, "a")]), "tr"),
      ),
    );
    assert.deepEqual([...getDismissals()], []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the grouped banner keeps the same buttons when it opens and closes", async () => {
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const c = dom.container;
    const root = createRoot(c as unknown as Element);
    await act(async () =>
      root.render(tree(relayFor(all3, [max, team, pro]), "tr")),
    );
    const showHide = toggle(c);
    const dismissAll = labelled(c, "Tüm uyarıları kapat");
    assert.ok(showHide && dismissAll);
    const click = (node: FakeNode) =>
      act(async () => dom.dispatch(node, "click", { detail: 1 }));
    await click(showHide);
    assert.equal(showHide.attributes.get("aria-expanded"), "true");
    assert.equal(
      toggle(c),
      showHide,
      "the button survives opening, so it keeps focus",
    );
    assert.equal(labelled(c, "Tüm uyarıları kapat"), dismissAll);
    await click(showHide);
    assert.equal(showHide.attributes.get("aria-expanded"), "false");
    assert.equal(toggle(c), showHide, "and closing");
    assert.equal(labelled(c, "Tüm uyarıları kapat"), dismissAll);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the Show button points at the list it opens", () => {
  const closed = render(relayFor(all3, [max, team, pro]));
  const id = /<button[^>]*aria-controls="([^"]+)"[^>]*>Göster<\/button>/.exec(
    closed,
  )?.[1];
  assert.ok(id, "the toggle names a list");
  const open = render(relayFor(all3, [max, team, pro]), "tr", {
    initialExpanded: true,
  });
  assert.ok(open.includes(`aria-controls="${id}"`));
  assert.match(
    open,
    new RegExp(`<ul[^>]*id="${id.replace(/[^\w-]/g, "\\$&")}"`),
  );
  // A single warning has no list and no toggle.
  assert.doesNotMatch(
    render(relayFor({ a: usage("expired") })),
    /aria-controls/,
  );
});

test("a single warning keeps its flat one-line layout", () => {
  const html = render(relayFor({ a: usage("expired") }));
  assert.match(
    html,
    /class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm border-warn\/40 bg-warn\/10"/,
  );
  assert.doesNotMatch(html, /flex-col gap-2 rounded-lg/);
});

const EXPLAIN_TR =
  "Yeniden bağlan, tarayıcıda bu hesabın limit okuma girişini açar. Onaylayınca uyarı kapanır.";

test("the expanded group explains Reconnect once, under the list, and only when a row offers it", () => {
  const twoLogins = {
    a: usage("expired", "a"),
    b: usage("scope", "b"),
    c: usage("keychain-locked", "c"),
  };
  const html = render(relayFor(twoLogins, [max, team, pro]), "tr", {
    initialExpanded: true,
  });
  assert.equal(html.split(EXPLAIN_TR).length - 1, 1, "once");
  assert.ok(html.indexOf(EXPLAIN_TR) > html.indexOf("</ul>"), "under the list");
  const en = render(relayFor(twoLogins, [max, team, pro]), "en", {
    initialExpanded: true,
  });
  assert.equal(
    en.split(
      "Reconnect opens this account’s usage sign-in in the browser. The warning closes once you approve it.",
    ).length - 1,
    1,
  );
  // No login row, no explanation.
  const renewals = render(
    relayFor({ b: all3.b, c: all3.c }, [team, pro]),
    "tr",
    { initialExpanded: true },
  );
  assert.doesNotMatch(renewals, /Yeniden bağlan/);
  // Collapsed, no explanation either.
  assert.doesNotMatch(
    render(relayFor(twoLogins, [max, team, pro])),
    /Yeniden bağlan, tarayıcıda/,
  );
  // A single sign-in banner keeps its own.
  assert.equal(
    render(relayFor({ a: usage("expired") })).split(EXPLAIN_TR).length - 1,
    1,
  );
});

test("while a browser approval is pending, the sign-in banner says so and Reconnect waits", () => {
  const pending = [{ id: "f", accountId: "a", status: "waiting" }];
  const html = render(relayFor({ a: usage("expired") }, [max], true, pending));
  assert.match(html, /Kişisel · Max · tarayıcı onayı bekleniyor\./);
  assert.doesNotMatch(html, /limit okuma girişinin yenilenmesi gerekiyor/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Yeniden bağlan<\/button>/);
  const en = render(
    relayFor({ a: usage("expired") }, [max], true, pending),
    "en",
  );
  assert.match(en, /Kişisel · Max · waiting for browser approval\./);
  assert.match(en, /<button[^>]*disabled=""[^>]*>Reconnect<\/button>/);
  // Every pending status counts; a finished flow does not.
  for (const status of ["starting", "verifying"])
    assert.match(
      render(
        relayFor({ a: usage("expired") }, [max], true, [
          { ...pending[0], status },
        ]),
      ),
      /tarayıcı onayı bekleniyor/,
      status,
    );
  for (const status of ["failed", "connected", "cancelled"]) {
    const done = render(
      relayFor({ a: usage("expired") }, [max], true, [
        { ...pending[0], status },
      ]),
    );
    assert.doesNotMatch(done, /tarayıcı onayı bekleniyor/, status);
    assert.doesNotMatch(done, /disabled=""[^>]*>Yeniden bağlan/, status);
  }
  // Another account's flow leaves this banner alone.
  const other = render(
    relayFor({ a: usage("expired") }, [max], true, [
      { ...pending[0], accountId: "b" },
    ]),
  );
  assert.doesNotMatch(other, /tarayıcı onayı bekleniyor|disabled=""/);
  // In the group, only the pending row waits.
  const group = render(relayFor(all3, [max, team, pro], true, pending), "tr", {
    initialExpanded: true,
  });
  assert.match(group, /Kişisel · Max · tarayıcı onayı bekleniyor\./);
  assert.match(
    group,
    /<button[^>]*disabled=""[^>]*aria-label="Yeniden bağlan · Kişisel · Max"|<button[^>]*aria-label="Yeniden bağlan · Kişisel · Max"[^>]*disabled=""/,
  );
  assert.doesNotMatch(
    group,
    /disabled=""[^>]*>Bağlantıyı yenile|disabled=""[^>]*>Anahtarlık erişimine izin ver/,
  );
});

// A usage sign-in of another account than the Claude app's reads the wrong limits, whatever the last read said.
const SAVED = {
  accountUuid: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  savedAt: iso(NOW),
};
const other = (id = "m", name = "Ek · Pro"): Account => ({
  ...account(true, id, name),
  desktop: SAVED,
  auth: {
    loggedIn: true,
    email: "a@example.com",
    checkedAt: iso(NOW),
    accountUuid: "00000000-0000-4000-8000-0000000000ff",
    orgId: SAVED.orgId,
  },
});
const sameIdentity = (id = "s", name = "Aynı · Max"): Account => ({
  ...other(id, name),
  auth: { ...other(id, name).auth!, accountUuid: SAVED.accountUuid },
});

test("a usage sign-in of another account than the Claude app sign-in gets the sign-in banner", () => {
  for (const u of [undefined, ready("m"), usage("rate-limited", "m"), usage("keychain-locked", "m"), usage("renewal-required", "m")]) {
    const found = reconnectIssues([other()], { m: u }, new Set());
    assert.equal(found.length, 1, String(u?.issue));
    assert.deepEqual([found[0].issue, found[0].action], ["identity-mismatch", "login"], String(u?.issue));
    const tr = render(relayFor(u ? { m: u } : {}, [other()]));
    assert.equal(banners(tr), 1);
    assert.match(
      tr,
      /Ek · Pro · limit okuma girişinin yenilenmesi gerekiyor: giriş başka bir hesaba ait\./,
    );
    assert.match(tr, /<button[^>]*>Yeniden bağlan<\/button>/);
    assert.doesNotMatch(tr, /Bağlantıyı yenile|Anahtarlık erişimine izin ver/);
    assert.match(tr, /aria-label="Uyarıyı kapat"/);
  }
  const en = render(relayFor({ m: ready("m") }, [other()]), "en");
  assert.match(
    en,
    /Ek · Pro · the usage sign-in needs to be renewed: the sign-in belongs to another account\./,
  );
  assert.match(en, /<button[^>]*>Reconnect<\/button>/);
  // A different organization is a mismatch too.
  const otherOrg: Account = {
    ...other(),
    auth: { ...other().auth!, accountUuid: SAVED.accountUuid, orgId: "00000000-0000-4000-8000-0000000000ee" },
  };
  assert.equal(reconnectIssues([otherOrg], {}, new Set()).length, 1);
});

test("the mismatch banner is not repeated when the read already reports a sign-in problem", () => {
  const same = reconnectIssues([other()], { m: usage("identity-mismatch", "m") }, new Set());
  assert.deepEqual(same.map((i) => [i.issue, i.action]), [["identity-mismatch", "login"]]);
  assert.equal(banners(render(relayFor({ m: usage("identity-mismatch", "m") }, [other()]))), 1);
  // Another sign-in problem keeps its own issue and cause.
  const expired = reconnectIssues([other()], { m: usage("expired", "m") }, new Set());
  assert.deepEqual(expired.map((i) => [i.issue, i.action]), [["expired", "login"]]);
  assert.match(
    render(relayFor({ m: usage("expired", "m") }, [other()])),
    /oturumun süresi doldu ve yenilenemedi/,
  );
});

test("the mismatch banner is dismissed by its own key, and a matching identity has none", () => {
  const relay = relayFor({ m: ready("m") }, [other()]);
  assert.equal(banners(render(relay)), 1);
  restart([dismissalKey("m", "identity-mismatch")]);
  assert.equal(banners(render(relay)), 0);
  // Another issue's dismissal does not hide it.
  restart([dismissalKey("m", "expired")]);
  assert.equal(banners(render(relay)), 1);
  assert.deepEqual(
    reconnectIssues([other()], { m: ready("m") }, new Set([dismissalKey("m", "identity-mismatch")])),
    [],
  );
  // The same identity, no desktop link, or a signed-out account: nothing to warn about.
  assert.deepEqual(reconnectIssues([sameIdentity()], { s: ready("s") }, new Set()), []);
  assert.deepEqual(reconnectIssues([account(true, "a")], { a: ready("a") }, new Set()), []);
  assert.deepEqual(
    reconnectIssues([{ ...other(), auth: { ...other().auth!, loggedIn: false } }], {}, new Set()),
    [],
  );
});

test("a dismissed mismatch outlives every read and goes once the identities match", async () => {
  restart([dismissalKey("m", "identity-mismatch")]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (accounts: Account[], u: AccountUsage) =>
      act(async () => root.render(tree(relayFor({ m: u }, accounts), "tr")));
    const keys = () => [...getDismissals()].sort();
    // Whatever the read says, the usage sign-in is still another account's.
    for (const u of [
      ready("m"),
      usage("rate-limited", "m"),
      usage("keychain-locked", "m"),
    ]) {
      await mount([other()], u);
      assert.deepEqual(keys(), ["m:identity-mismatch"], String(u.issue));
    }
    assert.equal(writes, 0, "nothing was pruned or written");
    // The usage sign-in is the Claude app's again: the dismissal has nothing left to hide.
    await mount([sameIdentity("m", "Ek · Pro")], ready("m"));
    assert.deepEqual(keys(), []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("a mismatched account counts in the grouped banner and its row says why", () => {
  const html = render(
    relayFor({ a: usage("expired", "a"), m: ready("m") }, [max, other()]),
    "tr",
    { initialExpanded: true },
  );
  assert.equal(banners(html), 1);
  assert.match(html, /2 hesabın limit okuma girişi ilgi bekliyor\./);
  assert.match(html, /Ek · Pro · limit okuma girişinin yenilenmesi gerekiyor: giriş başka bir hesaba ait\./);
  assert.match(html, /aria-label="Ek · Pro uyarısını kapat"/);
});

test("a read that fails for a moment does not prune the dismissals of that account", async () => {
  restart(["a:expired", "b:renewal-required"]);
  const dom = fakeDom({ localStorage: () => storage() });
  dom.install();
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    const mount = (usages: Record<string, AccountUsage>) =>
      act(async () => root.render(tree(relayFor(usages, [max, team]), "tr")));
    const keys = () => [...getDismissals()].sort();
    // The usage service is down or asks to wait: the account is as good as unread.
    await mount({
      a: usage("unavailable", "a"),
      b: usage("rate-limited", "b"),
    });
    assert.deepEqual(keys(), ["a:expired", "b:renewal-required"]);
    assert.equal(writes, 0, "nothing was pruned or written");
    // Once a read settles without the issue, its dismissal goes.
    await mount({ a: ready("a"), b: usage("rate-limited", "b") });
    assert.deepEqual(keys(), ["b:renewal-required"]);
    // A signed-out account is never waiting for a read, transient issue or not.
    await act(async () =>
      root.render(
        tree(
          relayFor({ b: usage("rate-limited", "b") }, [
            account(false, "b", "İş · Team"),
          ]),
          "tr",
        ),
      ),
    );
    assert.deepEqual(keys(), []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});
