import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { LostFound, describe, weekLabel } from "../src/pages/usage/LostFound";
import { resetShelfForTests } from "../src/data/lost-found-shelf";
import { resetCollectionForTests } from "../src/data/lost-found-collection";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type RelayAPI } from "../shared/types";
import type { LostFoundWeek, LostItem } from "../shared/lost-found";
import { fakeDom, find, readableText, textOf, type Fake } from "./fake-dom";

const ZONE = "Europe/Istanbul";
const NOW = Date.parse("2026-10-19T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const a: Account = { id: "a", name: "Kişisel", kind: "personal", group: "personal", color: "olive", createdAt: iso(NOW) };
const b: Account = { ...a, id: "b", name: "Vertex" };
const accounts = [a, b];
const settings = { ...DEFAULT_SETTINGS, planning: { ...DEFAULT_SETTINGS.planning, timeZone: ZONE } };
const t = (language: Language) => (tr: string, en: string) => (language === "tr" ? tr : en);
const week = { start: "2026-10-12", end: "2026-10-18" };
const say = (item: LostItem, language: Language = "tr") => describe(item, week, ZONE, t(language), language);

test("week labels name the month once within it, and both months across two", () => {
  assert.equal(weekLabel("2026-10-12", "2026-10-18", "tr"), "12–18 Eki");
  assert.equal(weekLabel("2026-10-12", "2026-10-18", "en"), "12–18 Oct");
  assert.equal(weekLabel("2026-09-28", "2026-10-04", "tr"), "28 Eyl – 4 Eki");
});

test("every item tells what happened, when and to whom, with the panda's word, in both languages", () => {
  // 09:56 in Istanbul.
  const hourglass = say({ kind: "hourglass", at: "2026-10-14T06:56:00Z", accountId: "a", minutes: 66 });
  assert.deepEqual(hourglass, {
    title: "Kum saati",
    story: "Bir 5 saatlik dönem, başlamasından yalnızca 1 sa 6 dk sonra doldu.",
    when: "Çarşamba 09:56",
    accounts: ["a"],
    quip: "Kumu bu kadar hızlı akan bir saat görmedim.",
  });
  assert.equal(
    say({ kind: "hourglass", at: "2026-10-14T06:56:00Z", minutes: 66 }, "en").story,
    "A five-hour window ran out just 1 h 6 min after it began.",
  );

  const boomerang = say({ kind: "boomerang", at: "2026-10-14T11:10:00Z", accountIds: ["a", "b"], minutes: 8 });
  assert.equal(boomerang.story, "Başladığın hesaba 8 dakika içinde geri döndün.");
  assert.deepEqual(boomerang.accounts, ["a", "b", "a"]);

  const trophy = say({ kind: "trophy", date: "2026-10-14", tokens: 2_958_000_000, times: 4.3 });
  assert.equal(trophy.story, "Son 30 günün en yoğun günü: sıradan bir günün 4,3 katı, 3 milyar token.");
  assert.equal(trophy.when, "14 Ekim Çarşamba");
  assert.equal(
    say({ kind: "trophy", date: "2026-10-14", tokens: 2_958_000_000, times: 4.3 }, "en").story,
    "The busiest of the last 30 days: 4.3× an ordinary day, 3 billion tokens.",
  );

  // 11:00 to 03:00 the next day in Istanbul.
  const scroll = say({ kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16 });
  assert.equal(scroll.story, "16 saat aralıksız çalıştın.");
  assert.equal(scroll.when, "Cuma 11:00 → Cumartesi 03:00");

  const scarf = say({ kind: "scarf", date: "2026-10-14", accountIds: ["b", "a", "c"] });
  assert.equal(scarf.title, "Üç renkli atkı");
  assert.equal(scarf.story, "Aynı gün 3 hesabın her biri iş başındaydı.");
  assert.equal(say({ kind: "scarf", date: "2026-10-14", accountIds: ["b", "a", "c", "d"] }, "en").title, "Four-colour scarf");

  const together = say({ kind: "clocks", at: "2026-10-16T14:10:00Z", accountIds: ["a", "b"], gapMinutes: 0, count: 3 });
  assert.equal(together.story, "İki hesabın 5 saatlik dönemi aynı anda yenilendi. O hafta 3 kez oldu.");
  assert.equal(
    say({ kind: "clocks", at: "2026-10-16T14:10:00Z", accountIds: ["a", "b"], gapMinutes: 1, count: 2 }, "en").story,
    "Two accounts’ five-hour windows reset 1 minute apart. It happened twice that week.",
  );
  const apart = say({ kind: "clocks", at: "2026-10-16T14:10:00Z", accountIds: ["a", "b"], gapMinutes: 6, count: 1 }, "en");
  assert.equal(apart.story, "Two accounts’ five-hour windows reset 6 minutes apart.");

  assert.equal(
    say({ kind: "spare", accountIds: ["b"], hits: 2 }).story,
    "Bir hesap bütün hafta kenarda bekledi; bu arada 2 kez limite takıldın.",
  );
  assert.equal(
    say({ kind: "spare", accountIds: ["a", "b"], hits: 1 }, "en").story,
    "Some accounts sat out the whole week while you hit a limit once.",
  );
  assert.equal(say({ kind: "spare", accountIds: ["b"], hits: 2 }).when, "12–18 Eki");

  // 04:00 in Istanbul.
  const feather = say({ kind: "feather", at: "2026-10-18T01:00:00Z", hours: 17 });
  assert.equal(feather.story, "O hafta gece yarısından sonra toplam 17 saat çalıştın.");
  assert.equal(feather.when, "En geç: Pazar 04:00–05:00");
  assert.equal(say({ kind: "feather", at: "2026-10-18T01:00:00Z", hours: 1 }, "en").story, "That week you worked 1 hour after midnight in all.");
  assert.equal(
    say({ kind: "boomerang", at: "2026-10-14T11:10:00Z", accountIds: ["a", "b"], minutes: 1 }, "en").story,
    "You were back on the account you started with within 1 minute.",
  );
});

const WEEK: LostFoundWeek = {
  start: "2026-10-12",
  end: "2026-10-18",
  latest: "2026-10-12",
  oldest: "2026-07-27",
  items: [
    { kind: "hourglass", at: "2026-10-14T06:56:00Z", accountId: "a", minutes: 66 },
    { kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16 },
  ],
};
const OLDER: LostFoundWeek = { ...WEEK, start: "2026-10-05", end: "2026-10-11", items: [] };

function relayFor(api: Partial<RelayAPI>): Relay {
  return { api, accounts, settings } as unknown as Relay;
}
const tree = (child: ReactElement, relay: Relay, language: Language = "tr") =>
  createElement(
    I18nContext.Provider,
    { value: { language, setLanguage() {}, t: t(language) } },
    createElement(RelayContext.Provider, { value: relay }, child),
  );

beforeEach(() => {
  resetShelfForTests();
  resetCollectionForTests();
});

test("the new finds tell their story in both languages", () => {
  const baton = { kind: "baton" as const, at: "2026-10-14T08:04:00Z", accountIds: ["a", "b"] as [string, string], minutes: 4, count: 3 };
  assert.equal(say(baton).story, "Bir hesap limite takılınca öbür hesap 4 dakika içinde devraldı. O hafta 3 kez oldu.");
  assert.equal(say({ ...baton, minutes: 0, count: 1 }, "en").story, "An account hit its limit and another took over at once.");
  assert.equal(say(baton).when, "Çarşamba 11:04");
  assert.equal(say({ kind: "tally", hours: 31 }).story, "Haftanın yedi gününün her birinde çalıştın; toplam 31 saat.");
  assert.equal(say({ kind: "tally", hours: 31 }).when, "12–18 Eki");
  assert.equal(say({ kind: "compass", hours: 24 }, "en").story, "That week you worked 24 hours and never hit a limit.");
  // 05:00 in Istanbul.
  const tea = say({ kind: "teaglass", at: "2026-10-15T02:00:00Z", hours: 1 }, "en");
  assert.equal(tea.story, "That week you worked 1 hour between 05:00 and 08:00 in all.");
  assert.equal(tea.when, "Earliest: Thursday 05:00–06:00");
  assert.equal(say({ kind: "teaglass", at: "2026-10-15T02:00:00Z", hours: 3 }).title, "Sabah çayı");
});

test("the bureau shows last week's most striking find, its other finds, other weeks and a shelf that keeps", async () => {
  const stored = new Map<string, string>();
  const dom = fakeDom({
    localStorage: () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    }),
  });
  dom.install();
  readableText();
  const asked: { weekStart?: string }[] = [];
  const api = {
    lostFound: async (input: { weekStart?: string }) => {
      asked.push(input);
      return input.weekStart === "2026-10-05" ? OLDER : WEEK;
    },
  } as unknown as RelayAPI;
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(LostFound), relayFor(api))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake, name: string) => (n as { attributes?: Map<string, string> }).attributes?.get?.(name);
    const slot = (name: string) => find(container, (n) => attr(n, "data-slot") === name);
    const button = (match: (text: string, node: Fake) => boolean) =>
      find(container, (n) => n.tagName === "button" && match(textOf(n), n));
    const click = async (node: Fake | undefined) => {
      assert.ok(node);
      await act(async () => dom.dispatch(node, "click", { detail: 1 }));
    };
    assert.deepEqual(asked, [{}]);
    assert.match(textOf(slot("lost-item")), /Kum saati.*1 sa 6 dk sonra doldu.*Çarşamba 09:56.*Kişisel/);
    assert.match(textOf(container), /12–18 Eki/);
    // The newest week has no next one.
    assert.equal(attr(button((_, n) => attr(n, "aria-label") === "Sonraki hafta")!, "disabled"), "");

    // The week's other find.
    await click(button((text) => text.endsWith("Uzun parşömen")));
    // Its first find earns the bronze pin.
    assert.match(textOf(slot("lost-item")), /^Uzun parşömenBronz · 1 haftaİlk kez bulundu16 saat aralıksız çalıştın\./);
    assert.equal(attr(find(slot("lost-item")!, (n) => attr(n, "data-slot") === "lost-pin")!, "data-kind"), "scroll");

    // Kept, it stays on the shelf, in storage, and opens from there.
    await click(button((text) => text === "Rafa koy"));
    assert.equal(JSON.parse(stored.get("relay.lostfound.shelf.v1")!)[0].id, "2026-10-12:scroll");
    assert.ok(slot("lost-shelf"));
    // The same button now says it is kept, and pressing it again would take it off.
    assert.equal(attr(button((text) => text === "Rafta ✓")!, "aria-pressed"), "true");

    // The week before: an empty drawer.
    await click(button((_, n) => attr(n, "aria-label") === "Önceki hafta"));
    assert.deepEqual(asked.at(-1), { weekStart: "2026-10-05" });
    assert.match(textOf(container), /Bu hafta çekmece boş/);
    assert.match(textOf(container), /O haftanın ardından kalanlar\./);

    // The shelf still opens the kept scroll, named as from the shelf, and can let it go.
    await click(find(slot("lost-shelf")!, (n) => n.tagName === "button"));
    assert.match(textOf(slot("lost-item")), /Raftan · 12–18 Eki/);
    await click(button((text) => text === "Rafta ✓"));
    assert.equal(slot("lost-shelf"), undefined);
    assert.deepEqual(JSON.parse(stored.get("relay.lostfound.shelf.v1")!), []);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("a failed fetch says so", async () => {
  const dom = fakeDom();
  dom.install();
  readableText();
  const api = { lostFound: async () => Promise.reject(new Error("kapalı")) } as unknown as RelayAPI;
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(LostFound), relayFor(api))));
    assert.match(textOf(dom.container), /Eşyalar alınamadı\. kapalı/);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the preload exposes the bureau and the main process answers it", async () => {
  const fs = await import("node:fs/promises");
  const preload = await fs.readFile(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(preload, /lostFound: \(input\) => ipcRenderer\.invoke\("relay:lost-found", input\)/);
  assert.match(main, /handle\("lost-found", \(input\) => \{\s*const \{ weekStart \} = lostFoundInput\.parse\(input\);/);
  assert.match(preload, /lostFoundCollection: \(\) =>\s*ipcRenderer\.invoke\("relay:lost-found-collection"\)/);
  assert.match(main, /handle\("lost-found-collection", \(\) =>\s*lostFoundCollection\(lostFoundSource\(\)\)/);
});

test("kept items from another version that cannot be told are left off the shelf", async () => {
  const stored = new Map<string, string>([
    [
      "relay.lostfound.shelf.v1",
      JSON.stringify([
        { id: "2026-10-12:unicorn", start: "2026-10-12", end: "2026-10-18", item: { kind: "unicorn" }, names: {} },
        { id: "2026-10-12:scroll", start: "2026-10-12", item: { kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16 } },
        { id: "2026-10-12:hourglass", start: "2026-10-12", end: "2026-10-18", item: { kind: "hourglass", at: "2026-10-14T06:56:00Z", minutes: 66 }, names: {} },
      ]),
    ],
  ]);
  const dom = fakeDom({
    localStorage: () => ({ getItem: (key: string) => stored.get(key) ?? null, setItem() {} }),
  });
  dom.install();
  readableText();
  const api = { lostFound: async () => ({ ...WEEK, items: [] }) } as unknown as RelayAPI;
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(LostFound), relayFor(api))));
    const shelf = find(dom.container as unknown as Fake, (n) => (n as { attributes?: Map<string, string> }).attributes?.get?.("data-slot") === "lost-shelf");
    assert.ok(shelf);
    assert.equal(textOf(shelf), "RafKum saati, 12–18 Eki");
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});

test("the collection shows every pin: found ones in their finish, the rest with how to find them, secrets sealed", async () => {
  // Six weeks of night hours kept from before the reach make the feather gold.
  const older = ["2026-07-20", "2026-07-13", "2026-07-06", "2026-06-29", "2026-06-22"];
  const stored = new Map<string, string>([
    ["relay.lostfound.collection.v1", JSON.stringify({ feather: older, teaglass: ["2026-07-20"], unicorn: ["2026-07-20"], scroll: ["nope"] })],
  ]);
  const dom = fakeDom({
    localStorage: () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    }),
  });
  dom.install();
  readableText();
  const asked: { weekStart?: string }[] = [];
  const api = {
    lostFound: async (input: { weekStart?: string }) => {
      asked.push(input);
      return input.weekStart === "2026-10-05" ? { ...OLDER, items: [WEEK.items[1]] } : WEEK;
    },
    lostFoundCollection: async () => ({
      latest: "2026-10-12",
      oldest: "2026-07-27",
      found: { hourglass: ["2026-10-12"], scroll: ["2026-10-12", "2026-10-05"], feather: ["2026-08-03"] },
    }),
  } as unknown as RelayAPI;
  try {
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(dom.container as unknown as Element);
    await act(async () => root.render(tree(createElement(LostFound), relayFor(api))));
    const container = dom.container as unknown as Fake;
    const attr = (n: Fake, name: string) => (n as { attributes?: Map<string, string> }).attributes?.get?.(name);
    const tile = (kind: string) => find(container, (n) => n.tagName === "li" && attr(n, "data-kind") === kind);
    const button = (match: (text: string) => boolean) =>
      find(container, (n) => n.tagName === "button" && match(textOf(n)));
    await act(async () => dom.dispatch(button((text) => text.startsWith("Koleksiyon"))!, "click", { detail: 1 }));
    assert.match(textOf(container), /4 \/ 12rozet bulundu/);
    assert.match(textOf(container), /Altın 1 · Gümüş 0 · Bronz 3/);
    assert.match(textOf(tile("feather")!), /Gece kuşu tüyüAltın · 6 haftaEn üst seviye/);
    assert.match(textOf(tile("scroll")!), /Uzun parşömenBronz · 2 haftaGümüş için 1 hafta daha/);
    assert.match(textOf(tile("compass")!), /PusulaBir haftada en az 20 saat çalış ve hiç limite takılma\./);
    assert.equal(attr(tile("compass")!, "data-found"), "false");
    // A secret kind keeps its name and its object to itself until found.
    assert.match(textOf(tile("clocks")!), /^Gizli rozetGizli rozet\. Panda ipucu vermiyor\.$/);
    // What the main process found is kept, with the older weeks and without what cannot be read.
    assert.deepEqual(JSON.parse(stored.get("relay.lostfound.collection.v1")!), {
      hourglass: ["2026-10-12"],
      scroll: ["2026-10-12", "2026-10-05"],
      feather: ["2026-08-03", ...older],
      teaglass: ["2026-07-20"],
    });
    // A tea glass found only out of reach has no week to open; the scroll opens its newest week.
    assert.equal(find(tile("teaglass")!, (n) => n.tagName === "button"), undefined);
    assert.ok(find(tile("feather")!, (n) => n.tagName === "button"));
    await act(async () => dom.dispatch(find(tile("scroll")!, (n) => n.tagName === "button")!, "click", { detail: 1 }));
    assert.deepEqual(asked.at(-1), { weekStart: "2026-10-12" });
    assert.match(textOf(container), /Uzun parşömenBronz · 2 hafta16 saat aralıksız çalıştın\./);
    await act(async () => root.unmount());
  } finally {
    dom.uninstall();
  }
});
