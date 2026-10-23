import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, type ReactElement } from "react";
import { LostFound, describe, weekLabel } from "../src/pages/usage/LostFound";
import { resetCollectionForTests } from "../src/data/lost-found-collection";
import { RelayContext, type Relay } from "../src/data/relay-context";
import { I18nContext, type Language } from "../src/data/i18n";
import { DEFAULT_SETTINGS, type Account, type RelayAPI } from "../shared/types";
import type { LostFoundCollection, LostItem } from "../shared/lost-found";
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

test("token and cost finds tell their money, and every moment the ledger can tell says what it used", () => {
  assert.equal(
    say({ kind: "chest", cost: 412.5, tokens: 2_100_000_000, times: 2.1 }).story,
    "Haftanın API karşılığı $412,50: önceki haftaların hepsinden yüksek, sıradan bir haftanın 2,1 katı, 2,1 milyar token.",
  );
  assert.equal(
    say({ kind: "piggy", accountId: "a", cost: 236.4, price: 200 }).story,
    "Bir hesabın o haftaki API karşılığı $236,40 oldu; planının aylık ücreti $200,00. Abonelik bedelini tek haftada çıkardı.",
  );
  assert.deepEqual(say({ kind: "piggy", accountId: "a", cost: 236.4, price: 200 }).accounts, ["a"]);
  assert.equal(
    say({ kind: "fan", families: ["Opus", "Sonnet", "Haiku"] }, "en").story,
    "That week you worked with 3 model families: Opus, Sonnet, Haiku.",
  );
  assert.equal(
    say({ kind: "tightrope", at: "2026-10-14T11:00:00Z", accountId: "a", percent: 98 }).story,
    "Bir 5 saatlik dönem limite takılmadan %98 doluluğa ulaştı.",
  );
  assert.equal(say({ kind: "lantern", hours: 9 }).story, "Cumartesi ve pazar toplam 9 saat çalıştın.");
  assert.equal(
    say({ kind: "hammock", date: "2026-10-14", activeDays: 5 }).when,
    "14 Ekim Çarşamba",
  );
  assert.equal(
    say({ kind: "scales", accountIds: ["a", "b"], low: 46, high: 54 }).story,
    "Hafta boyunca 2 hesap işi neredeyse eşit paylaştı: her biri %46 ile %54 arasında.",
  );
  const scroll = say({ kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16, spend: { tokens: 12_400_000, cost: 38.2 } });
  assert.match(scroll.spend!, /^12,4\sMn token · \$38,20 API karşılığı$/);
  assert.match(
    describe({ kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16, spend: { tokens: 12_400_000, cost: 38.2 } }, week, ZONE, t("en"), "en").spend!,
    /^12\.4m tokens · \$38\.20 API value$/,
  );
  // A chest already tells its money, so it has no second line.
  assert.equal(say({ kind: "chest", cost: 1, tokens: 1, times: 2, spend: { tokens: 1, cost: 1 } }).spend, undefined);
});

const hourglass = (minutes: number, at: string): LostItem => ({ kind: "hourglass", at, accountId: "a", minutes });
const scroll: LostItem = { kind: "scroll", at: "2026-10-16T08:00:00Z", hours: 16 };
const boomerang: LostItem = { kind: "boomerang", at: "2026-10-14T11:10:00Z", accountIds: ["a", "b"], minutes: 8 };
/** What the main process finds within reach: the hourglass in three weeks (silver), the scroll and a boomerang last week. */
const ANSWER: LostFoundCollection = {
  latest: "2026-10-12",
  oldest: "2026-07-27",
  found: {
    hourglass: [
      { start: "2026-10-12", end: "2026-10-18", item: hourglass(66, "2026-10-14T06:56:00Z") },
      { start: "2026-10-05", end: "2026-10-11", item: hourglass(90, "2026-10-07T06:56:00Z") },
      { start: "2026-09-28", end: "2026-10-04", item: hourglass(120, "2026-09-30T06:56:00Z") },
    ],
    scroll: [{ start: "2026-10-12", end: "2026-10-18", item: scroll }],
    boomerang: [{ start: "2026-10-12", end: "2026-10-18", item: boomerang }],
  },
};

function relayFor(api: Partial<RelayAPI>, list: Account[] = accounts): Relay {
  return { api, accounts: list, settings } as unknown as Relay;
}
const tree = (child: ReactElement, relay: Relay, language: Language = "tr") =>
  createElement(
    I18nContext.Provider,
    { value: { language, setLanguage() {}, t: t(language) } },
    createElement(RelayContext.Provider, { value: relay }, child),
  );

beforeEach(() => resetCollectionForTests());

/** The page drawn with `api` over a storage holding `stored`; returns its helpers and the storage. */
async function page(api: Partial<RelayAPI>, stored = new Map<string, string>(), list: Account[] = accounts) {
  const dom = fakeDom({
    localStorage: () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    }),
  });
  dom.install();
  readableText();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.container as unknown as Element);
  await act(async () => root.render(tree(createElement(LostFound), relayFor(api, list))));
  const container = dom.container as unknown as Fake;
  const attr = (n: Fake, name: string) => (n as { attributes?: Map<string, string> }).attributes?.get?.(name);
  const slot = (name: string) => find(container, (n) => attr(n, "data-slot") === name);
  const tile = (kind: string) => find(slot("lost-library")!, (n) => n.tagName === "li" && attr(n, "data-kind") === kind);
  const click = async (node: Fake | undefined) => {
    assert.ok(node);
    await act(async () => dom.dispatch(node, "click", { detail: 1 }));
  };
  const button = (inside: Fake, match: (text: string) => boolean) =>
    find(inside, (n) => n.tagName === "button" && match(textOf(n)));
  const done = async () => {
    await act(async () => root.unmount());
    dom.uninstall();
  };
  return { container, attr, slot, tile, click, button, stored, done };
}

test("the page opens like a game's achievements: progress, recent finds, next goals, every pin by category, and details", async () => {
  const view = await page({ lostFoundCollection: async () => ANSWER });
  try {
    const { container, slot, tile, attr } = view;
    // Three of twelve found: one silver, two bronze.
    assert.match(textOf(slot("lost-overview")!), /3\/19%16/);
    assert.match(textOf(slot("lost-overview")!), /0Altın1Gümüş2Bronz/);
    // The newest finds, most striking first within a week; the hourglass just reached silver.
    assert.match(
      textOf(slot("lost-recent")!),
      /Kum saatiGümüş seviyeye çıktı12–18 Eki.*Bumerang.*Yeni rozet.*Uzun parşömenYeni rozet/,
    );
    // The scroll and boomerang are two weeks from silver, the hourglass three from gold.
    assert.match(textOf(slot("lost-next")!), /Uzun parşömen.*Gümüş için 2 hafta daha.*Kum saati.*Altın için 3 hafta daha/);
    // Categories count what is found in them; locked pins say so, secret ones keep their name.
    assert.match(textOf(slot("lost-library")!), /Tempo ve rekorlar2\/4.*Gün ve saat0\/5.*Hesaplar arasında1\/6.*Token ve maliyet0\/4/);
    assert.match(textOf(tile("compass")!), /PusulaKilitli/);
    assert.match(textOf(tile("clocks")!), /Gizli rozetKilitli/);
    assert.equal(attr(tile("boomerang")!, "data-found"), "true");
    // The details open on the newest find, with its finishes and its whole history.
    const details = slot("lost-details")!;
    assert.equal(attr(details, "data-kind"), "hourglass");
    assert.match(textOf(details), /Kum saatiGümüş · 3 hafta/);
    assert.match(textOf(details), /Nasıl kazanılırBir 5 saatlik dönem, başlamasından en geç 2,5 saat sonra dolsun\./);
    assert.match(textOf(details), /Bronz✓ 1 haftaGümüş✓ 3 haftaAltın6 hafta/);
    assert.match(textOf(details), /İlk bulunduğu hafta28 Eyl – 4 EkiSon bulunduğu hafta12–18 Eki/);
    // The fastest window is the record, and three weeks of twelve read as now and then.
    assert.match(textOf(details), /Kişisel rekor1 sa 6 dk12–18 EkiSıklıkAra sıraSon 12 haftada 3 kez/);
    assert.match(textOf(details), /12–18 EkiRekorBir 5 saatlik dönem, başlamasından yalnızca 1 sa 6 dk sonra doldu\.Çarşamba 09:56·Kişisel/);
    // Milestones: the first pin is in, platinum is every pin.
    assert.match(
      textOf(slot("lost-milestones")!),
      /Kilometre taşları1\/5✓İlk rozet \(tamam\)○Her kategoriden bir rozet \(henüz değil\).*Platin: tüm rozetler \(henüz değil\)/,
    );
    assert.match(textOf(details), /5–11 Eki.*1 sa 30 dk.*28 Eyl – 4 Eki.*2 sa/);
    assert.doesNotMatch(textOf(container), /Önceki hafta|Rafa koy|Aynı haftadan/);
  } finally {
    await view.done();
  }
});

test("choosing a pin shows it: a found one with its story, a locked one with how to earn it, a secret one sealed", async () => {
  const view = await page({ lostFoundCollection: async () => ANSWER });
  try {
    const { slot, tile, click, attr } = view;
    await click(find(tile("boomerang")!, (n) => n.tagName === "button"));
    let details = slot("lost-details")!;
    assert.equal(attr(details, "data-kind"), "boomerang");
    // Found, the secret's condition is told; the story joins the accounts with arrows.
    assert.match(textOf(details), /Başka bir hesaba geç ve 15 dakika içinde ilk hesaba dön\./);
    assert.match(textOf(details), /Kişisel→Vertex→Kişisel/);
    await click(find(tile("compass")!, (n) => n.tagName === "button"));
    details = slot("lost-details")!;
    assert.match(textOf(details), /PusulaHenüz bulunmadıNasıl kazanılırBir haftada en az 20 saat çalış ve hiç limite takılma\./);
    assert.doesNotMatch(textOf(details), /Geçmiş/);
    await click(find(tile("clocks")!, (n) => n.tagName === "button"));
    details = slot("lost-details")!;
    assert.match(textOf(details), /^Gizli rozetHenüz bulunmadıNasıl kazanılırGizli rozet\. Panda ipucu vermiyor\.$/);
    // The recent strip and the next goals open their pin too.
    await click(view.button(slot("lost-next")!, (text) => text.startsWith("Uzun parşömen")));
    assert.equal(attr(slot("lost-details")!, "data-kind"), "scroll");
  } finally {
    await view.done();
  }
});

test("the filter narrows the pins to earned or locked ones", async () => {
  const view = await page({ lostFoundCollection: async () => ANSWER });
  try {
    const { slot, tile, click, button } = view;
    await click(button(slot("lost-library")!, (text) => text.startsWith("Kazanılan")));
    assert.ok(tile("hourglass"));
    assert.equal(tile("compass"), undefined);
    assert.doesNotMatch(textOf(slot("lost-library")!), /Gün ve saat/);
    await click(button(slot("lost-library")!, (text) => text.startsWith("Kilitli")));
    assert.equal(tile("hourglass"), undefined);
    assert.ok(tile("compass"));
  } finally {
    await view.done();
  }
});

test("finds are kept with their story and the account names of the day, and outlive the reach", async () => {
  const stored = new Map<string, string>();
  const first = await page({ lostFoundCollection: async () => ANSWER }, stored);
  await first.done();
  const kept = JSON.parse(stored.get("relay.lostfound.collection.v2")!);
  assert.deepEqual(kept.boomerang, [
    { start: "2026-10-12", end: "2026-10-18", item: boomerang, names: { a: "Kişisel", b: "Vertex" } },
  ]);
  // Later the weeks fall out of reach and Vertex is removed: the pins and their stories stay.
  resetCollectionForTests();
  const later = await page({ lostFoundCollection: async () => ({ ...ANSWER, found: {} }) }, stored, [a]);
  try {
    assert.match(textOf(later.slot("lost-overview")!), /3\/19/);
    await later.click(find(later.tile("boomerang")!, (n) => n.tagName === "button"));
    assert.match(textOf(later.slot("lost-details")!), /Kişisel→Vertex→Kişisel/);
  } finally {
    await later.done();
  }
});

test("an earlier version's weeks and shelf carry over; what cannot be told keeps only its week", async () => {
  const stored = new Map<string, string>([
    ["relay.lostfound.collection.v1", JSON.stringify({ feather: ["2026-07-20", "2026-07-13", "nope"], unicorn: ["2026-07-20"] })],
    [
      "relay.lostfound.shelf.v1",
      JSON.stringify([
        { id: "2026-07-20:feather", start: "2026-07-20", end: "2026-07-26", item: { kind: "feather", at: "2026-07-22T22:00:00Z", hours: 3 }, names: {} },
        { id: "x", start: "2026-07-06", end: "2026-07-12", item: { kind: "unicorn" } },
      ]),
    ],
  ]);
  const view = await page({ lostFoundCollection: async () => Promise.reject(new Error("kapalı")) }, stored);
  try {
    const { slot, tile, click } = view;
    assert.match(textOf(tile("feather")!), /Gece kuşu tüyüBronz · 2 hafta/);
    await click(find(tile("feather")!, (n) => n.tagName === "button"));
    const details = textOf(slot("lost-details")!);
    assert.match(details, /20–26 TemRekorO hafta gece yarısından sonra toplam 3 saat çalıştın\./);
    assert.match(details, /13–19 TemBu hafta bulundu; ayrıntısı eski bir sürümden kaldığı için yalnızca haftası biliniyor\./);
    // A failed answer leaves the kept finds on show and says the scan is over.
    assert.doesNotMatch(textOf(view.container), /haftaları tarıyor/);
  } finally {
    await view.done();
  }
});

test("with nothing found yet the panda says when the first pin will turn up", async () => {
  const view = await page({ lostFoundCollection: async () => ({ ...ANSWER, found: {} }) });
  try {
    assert.match(textOf(view.slot("lost-overview")!), /0\/19%0/);
    assert.match(textOf(view.slot("lost-recent")!), /Henüz rozet yok\./);
    assert.equal(view.slot("lost-next"), undefined);
  } finally {
    await view.done();
  }
});

test("the preload exposes the collection and the main process answers it", async () => {
  const fs = await import("node:fs/promises");
  const preload = await fs.readFile(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(preload, /lostFoundCollection: \(\) =>\s*ipcRenderer\.invoke\("relay:lost-found-collection"\)/);
  assert.match(main, /handle\("lost-found-collection", \(\) =>\s*lostFoundCollection\(lostFoundSource\(\)\)/);
  assert.doesNotMatch(main + preload, /relay:lost-found"|handle\("lost-found"/);
});
