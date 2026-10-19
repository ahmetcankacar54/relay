import test from "node:test";
import assert from "node:assert/strict";
import {
  BOOKS,
  busiestDay,
  dayParts,
  formatShare,
  modelName,
  pandaLines,
  pickBook,
  readingTime,
} from "../src/pages/usage/panda-facts";
import type { TokenCounts, TokenRow, TokenUsageView } from "../shared/token-usage-view";

const counts = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): TokenCounts => ({
  input, output, cacheWrite, cacheRead, responses: 1,
});
const cell = (c: TokenCounts, estimated = false) => ({ ...c, estimated });
type ByRow = TokenUsageView["days"][number]["byRow"];
const row = (key: string, kind: TokenRow["kind"] = "account"): TokenRow => ({ key, kind, estimated: false, totals: counts(0) });
/** A three-day view ending on the 14th, with accounts a and b; `models` and `totals` as given. */
function viewOf(byDate: Record<string, ByRow>, extra: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    range: 7,
    days: ["2026-10-12", "2026-10-13", "2026-10-14"].map((date) => ({ date, byRow: byDate[date] ?? {} })),
    rows: [row("a"), row("b")],
    totals: counts(0),
    models: [],
    progress: { percent: 100, complete: true },
    ...extra,
  };
}
const names = { a: "Kişisel", b: "Vertex" };
const TODAY = "2026-10-14";
const lines = (view: TokenUsageView, date: string) => pandaLines({ view, date, accountNames: names, today: TODAY });
const keys = (view: TokenUsageView, date: string) => lines(view, date).map((l) => l.key);

test("shares under 10% keep one decimal, larger ones are whole, in each language's form", () => {
  assert.equal(formatShare(0.009, "tr"), "%0,9");
  assert.equal(formatShare(0.009, "en"), "0.9%");
  assert.equal(formatShare(0.061, "tr"), "%6,1");
  assert.equal(formatShare(0.93, "tr"), "%93");
  assert.equal(formatShare(0.9349, "en"), "93%");
  assert.equal(formatShare(0, "tr"), "%0");
  // A sliver is never shown as nothing.
  assert.equal(formatShare(0.0004, "tr"), "<%0,1");
  assert.equal(formatShare(0.0004, "en"), "<0.1%");
});

test("a book is one the value is 1 to 1,000 times, varied by the seed, else the largest under it", () => {
  // 1.3 million tokens is at least once every book up to Shakespeare and at most 1,000 times the Little Prince.
  const picks = new Set(Array.from({ length: 40 }, (_, i) => pickBook(1_300_000, `seed ${i}`)?.en));
  assert.ok(picks.size > 3);
  for (const pick of picks) {
    const book = BOOKS.find((b) => b.en === pick)!;
    assert.ok(1_300_000 >= book.tokens && 1_300_000 / book.tokens <= 1_000, pick);
  }
  assert.equal(pickBook(1_300_000, "same")?.en, pickBook(1_300_000, "same")?.en);
  // 100 billion is over 1,000 times every book: the largest under it, Wikipedia.
  assert.equal(pickBook(100_000_000_000, "x")?.en, "English Wikipedia");
  assert.equal(pickBook(21_999, "x"), undefined);
  assert.equal(pickBook(22_000, "x")?.tr, "Küçük Prens");
});

test("reading time grows from hours to days, months and years", () => {
  // 1.3 tokens a word, 238 words a minute.
  const tokensFor = (minutes: number) => minutes * 238 * 1.3;
  assert.deepEqual(readingTime(tokensFor(0.2)), { tr: "1 dakika", en: "1 minute" });
  assert.deepEqual(readingTime(tokensFor(10)), { tr: "10 dakika", en: "10 minutes" });
  assert.deepEqual(readingTime(tokensFor(70)), { tr: "1 saat", en: "1 hour" });
  assert.deepEqual(readingTime(tokensFor(43 * 60)), { tr: "43 saat", en: "43 hours" });
  assert.deepEqual(readingTime(tokensFor(3 * 24 * 60)), { tr: "3 gün", en: "3 days" });
  assert.deepEqual(readingTime(tokensFor(7 * 30 * 24 * 60)), { tr: "7 ay", en: "7 months" });
  assert.deepEqual(readingTime(tokensFor(3 * 365 * 24 * 60)), { tr: "3 yıl", en: "3 years" });
});

test("model ids read as family and version, without a date", () => {
  assert.equal(modelName("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelName("claude-opus-4"), "Opus 4");
  assert.equal(modelName("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelName("claude-haiku-4-5"), "Haiku 4.5");
  assert.equal(modelName("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
  assert.equal(modelName("gpt"), "Gpt");
  assert.equal(modelName("2024"), "2024");
});

/** A view of one day per total, ending on the 14th, every day's tokens cache reads. */
function daysOf(totals: number[]): TokenUsageView {
  const end = Date.parse(`${TODAY}T12:00:00Z`);
  return viewOf({}, {
    days: totals.map((total, i) => ({
      date: new Date(end - (totals.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      byRow: (total ? { a: cell(counts(0, 0, 0, total)) } : {}) as ByRow,
    })),
  });
}
const rankOf = (totals: number[], day: number) => {
  const view = daysOf(totals);
  return lines(view, view.days[day].date).find((l) => l.key === "rank");
};

test("a day says what Claude wrote, in pages and a book, and what it read, in reading time", () => {
  const view = viewOf({ [TODAY]: { a: cell(counts(50_000, 650_000, 0, 2_899_950_000)) } });
  const all = lines(view, TODAY);
  // The cache share is the same nearly every day, so it is no line.
  assert.deepEqual(all.map((l) => l.key), ["wrote", "read", "carried"]);
  // 650 000 tokens are 1,000 pages of 500 words.
  assert.match(all[0].tr, /^Claude bugün ≈ 1\.000 sayfa yazdı; (≈ [\d,]+ .+|aşağı yukarı bir .+) kadar\.$/);
  assert.match(all[0].en, /^Claude wrote ≈ 1,000 pages today, (≈ [\d.]+× .+|about one .+)\.$/);
  // 2.9 billion tokens at 238 words a minute.
  assert.equal(all[1].tr, "Claude bugün 2,9 milyar token okudu; bir insan durmadan okusa 18 yıl sürerdi.");
  assert.equal(all[1].en, "Claude read 2.9 billion tokens today; a person reading nonstop would need 18 years.");
  const earlier = viewOf({ "2026-10-12": { a: cell(counts(500_000, 100_000)) } });
  const past = lines(earlier, "2026-10-12");
  assert.match(past[0].tr, /^Claude bu gün ≈ 150 sayfa yazdı/);
  assert.match(past[1].tr, /^Claude bu gün 500 bin token okudu;/);
  assert.match(past[1].en, /^Claude read 500 thousand tokens this day;/);
  // Under a page of output there is nothing to say about writing.
  assert.deepEqual(keys(viewOf({ [TODAY]: { a: cell(counts(1_000, 649)) } }), TODAY), ["read", "carried"]);
});

test("between once and twice a book the panda says about one; above it, how many times", () => {
  const lotr = BOOKS.find((b) => b.en === "The Lord of the Rings")!;
  const wrote = lines(viewOf({ [TODAY]: { a: cell(counts(0, lotr.tokens * 1.5)) } }), TODAY)
    .find((l) => l.key === "wrote")!;
  const named = [...BOOKS].reverse().find((b) => wrote.tr.includes(b.tr))!;
  const times = (lotr.tokens * 1.5) / named.tokens;
  if (times < 2) assert.match(wrote.tr, new RegExp(`; aşağı yukarı bir ${named.tr} kadar\\.$`));
  else assert.match(wrote.tr, new RegExp(`; ≈ [\\d,]+ ${named.tr} kadar\\.$`));
});

test("a day is placed among the range's active days: top three, busy, ordinary or quiet", () => {
  // The ordinary day is the median active day: 400 here.
  const week = [100, 200, 300, 400, 500, 600, 2_400];
  assert.deepEqual(rankOf(week, 6), {
    key: "rank",
    tr: "Bu 7 günün en yoğun günü: sıradan bir gününün 6 katı.",
    en: "The busiest of these 7 days: 6× an ordinary day.",
  });
  assert.equal(rankOf(week, 5)!.tr, "Bu 7 günün en yoğun 2. günü: sıradan bir gününün 1,5 katı.");
  assert.equal(rankOf(week, 5)!.en, "The second busiest of these 7 days: 1.5× an ordinary day.");
  assert.equal(rankOf(week, 4)!.en, "The third busiest of these 7 days: 1.3× an ordinary day.");
  assert.equal(rankOf(week, 3)!.tr, "Sıradan bir gün; ne fazla ne az.");
  assert.equal(rankOf(week, 0)!.tr, "Sakin bir gün: sıradan bir gününün dörtte birinden az.");
  assert.equal(rankOf(week, 0)!.en, "A quiet day: less than a quarter of an ordinary day.");
  // Busy but fourth: the median of nine days is 10.
  const busy = [10, 10, 10, 10, 10, 20, 30, 40, 50];
  assert.equal(rankOf(busy, 5)!.tr, "Yoğun bir gün: sıradan bir gününün 2 katı.");
  // Days alike do not claim to be the busiest.
  assert.equal(rankOf([100, 100, 100, 100, 100], 0)!.tr, "Sıradan bir gün; ne fazla ne az.");
  assert.equal(rankOf([1, 100, 100, 100, 100], 0)!.tr, "Sakin bir gün: sıradan bir gününün onda birinden az.");
  // With fewer than five active days there is nothing to compare with.
  assert.equal(rankOf([0, 0, 100, 200, 300, 400], 5), undefined);
});

test("the account that carried most of a shared day is named with its share; an even day names nobody", () => {
  const shared = viewOf({ [TODAY]: { a: cell(counts(940_000)), b: cell(counts(60_000)) } });
  assert.equal(
    lines(shared, TODAY).find((l) => l.key === "carried")!.tr,
    "Bu günün yükünü büyük ölçüde Kişisel çekti: %94.",
  );
  assert.equal(
    lines(shared, TODAY).find((l) => l.key === "carried")!.en,
    "Kişisel pulled most of this day: 94%.",
  );
  const even = viewOf({ [TODAY]: { a: cell(counts(550_000)), b: cell(counts(450_000)) } });
  assert.ok(!keys(even, TODAY).includes("carried"));
});

test("nobody carries a day when the range has one row, or when the top row is no account", () => {
  // An account filter leaves one row: every day would be carried alone.
  const filtered = viewOf({ [TODAY]: { a: cell(counts(940_000)) } }, { rows: [row("a")] });
  assert.ok(!keys(filtered, TODAY).includes("carried"));
  const unknown = viewOf(
    { [TODAY]: { unknown: cell(counts(940_000)), a: cell(counts(60_000)) } },
    { rows: [row("a"), row("unknown", "unknown")] },
  );
  assert.ok(!keys(unknown, TODAY).includes("carried"));
});

test("an estimated day says so; the range says how much Claude wrote and its busiest model", () => {
  const view = viewOf(
    { "2026-10-13": { a: cell(counts(900_000, 100_000), true) } },
    {
      range: 30,
      totals: counts(30_000_000, 3_000_000, 0, 0),
      models: [
        { model: "claude-opus-5-5", totals: counts(640, 0) },
        { model: "claude-sonnet-5-5", totals: counts(360, 0) },
      ],
    },
  );
  const all = lines(view, "2026-10-13");
  assert.deepEqual(all.map((l) => l.key), ["wrote", "read", "carried", "estimated", "range-wrote", "model"]);
  assert.equal(all[3].tr, "Bu günü limit ölçümlerinden tahmin ettim; ≈ işaretleri ondan.");
  assert.match(all[4].tr, /^Bu 30 günde Claude ≈ 4\.600 sayfa yazdı; (≈ [\d,]+ .+|aşağı yukarı bir .+) kadar\.$/);
  assert.match(all[4].en, /^Over these 30 days Claude wrote ≈ 4,600 pages, /);
  assert.equal(all[5].tr, "Bu aralıkta en çok Opus 5.5 çalıştı: %64.");
  assert.equal(all[5].en, "Opus 5.5 worked the most in this range: 64%.");
});

test("an empty day only dozes", () => {
  const view = viewOf({ [TODAY]: { a: cell(counts(5)) } });
  assert.deepEqual(lines(view, "2026-10-12"), [
    { key: "empty", tr: "Bu gün boş. Ben de biraz kestirdim.", en: "Nothing here. I had a little nap too." },
  ]);
});

test("the day's parts sum every row, and the busiest day counts all four kinds", () => {
  const view = viewOf({
    "2026-10-12": { a: cell(counts(1, 2, 3, 4)), b: cell(counts(11, 0, 0, 0), true) },
    "2026-10-13": { a: cell(counts(0, 0, 0, 30)) },
    [TODAY]: { a: cell(counts(5)) },
  });
  const parts = dayParts({ view, date: "2026-10-12" });
  assert.deepEqual(parts.kinds, { input: 12, output: 2, cacheWrite: 3, cacheRead: 4 });
  assert.equal(parts.total, 21);
  assert.equal(parts.estimated, true);
  assert.deepEqual(parts.rows.map((r) => r.key), ["b", "a"]);
  assert.equal(busiestDay(view), "2026-10-13");
  assert.equal(busiestDay(viewOf({})), undefined);
});
