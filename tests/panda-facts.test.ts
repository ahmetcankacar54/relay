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
import type { TokenCounts, TokenUsageView } from "../shared/token-usage-view";

const counts = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): TokenCounts => ({
  input, output, cacheWrite, cacheRead, responses: 1,
});
const cell = (c: TokenCounts, estimated = false) => ({ ...c, estimated });
type ByRow = TokenUsageView["days"][number]["byRow"];
/** A three-day view ending on the 14th; `models` and `totals` as given. */
function viewOf(byDate: Record<string, ByRow>, extra: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    range: 7,
    days: ["2026-10-12", "2026-10-13", "2026-10-14"].map((date) => ({ date, byRow: byDate[date] ?? {} })),
    rows: [],
    totals: counts(0),
    models: [],
    progress: { percent: 100, complete: true },
    ...extra,
  };
}
const names = { a: "Kişisel", b: "Vertex" };
const TODAY = "2026-10-14";
const lines = (view: TokenUsageView, date: string) => pandaLines({ view, date, names, today: TODAY });
const keys = (view: TokenUsageView, date: string) => lines(view, date).map((l) => l.key);

test("shares under 10% keep one decimal, larger ones are whole, in each language's form", () => {
  assert.equal(formatShare(0.009, "tr"), "%0,9");
  assert.equal(formatShare(0.009, "en"), "0.9%");
  assert.equal(formatShare(0.061, "tr"), "%6,1");
  assert.equal(formatShare(0.93, "tr"), "%93");
  assert.equal(formatShare(0.9349, "en"), "93%");
  assert.equal(formatShare(0, "tr"), "%0");
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
  assert.deepEqual(readingTime(tokensFor(10)), { tr: "1 saat", en: "1 hour" });
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
  assert.equal(modelName("gpt"), "Gpt");
  assert.equal(modelName("2024"), "2024");
});

test("a cache-heavy day opens with the taken-apart peak, and a thin output gets its line", () => {
  const view = viewOf({ "2026-10-13": { a: cell(counts(10_000, 9_000, 61_000, 920_000)) } });
  const all = lines(view, "2026-10-13");
  assert.deepEqual(all.map((l) => l.key), ["cache", "carried", "output", "reading"]);
  assert.equal(all[0].tr, "Bu tepeyi söktüm: %92 önbellek okuması çıktı. Çoğunu daha önce görmüştük.");
  assert.equal(all[0].en, "I took this peak apart: 92% of it was cache reads. We’d seen most of it before.");
  assert.equal(all[1].tr, "Bu günü tek başına Kişisel taşıdı.");
  assert.equal(all[2].tr, "Claude’un kendi yazdığı kısım sadece %0,9; gerisi okuma ve hatırlama.");
  // In plus out (19 000) is under the smallest book: no comparison.
  assert.ok(!all.some((l) => l.key === "book-day"));
});

test("the day's comparison counts only input and output, and says Bugünün for today", () => {
  const view = viewOf({ [TODAY]: { a: cell(counts(500_000, 100_000, 0, 5_000_000)) } });
  const day = lines(view, TODAY).find((l) => l.key === "book-day")!;
  assert.match(day.tr, /^Bugünün girdi ve çıktısı (≈ [\d,]+ .+|aşağı yukarı bir .+ kadar) eder\.$/);
  assert.match(day.en, /^Today’s input and output come to (≈ [\d.]+× .+|about as much as .+)\.$/);
  const earlier = viewOf({ "2026-10-12": { a: cell(counts(500_000, 100_000)) } });
  assert.match(lines(earlier, "2026-10-12").find((l) => l.key === "book-day")!.tr, /^Bu günün girdi ve çıktısı/);
});

test("between once and twice a book the panda says about one; above it, how many times", () => {
  // 600 000 is at least once only for books up to 576k; force the Lord of the Rings by leaving nothing else in the band.
  const lotr = BOOKS.find((b) => b.en === "The Lord of the Rings")!;
  const once = lines(viewOf({ [TODAY]: { a: cell(counts(lotr.tokens * 1.5)) } }), TODAY)
    .find((l) => l.key === "book-day")!;
  const named = BOOKS.find((b) => once.tr.includes(b.tr))!;
  const times = (lotr.tokens * 1.5) / named.tokens;
  if (times < 2) assert.equal(once.tr, `Bugünün girdi ve çıktısı aşağı yukarı bir ${named.tr} kadar eder.`);
  else assert.match(once.tr, new RegExp(`≈ [\\d,]+ ${named.tr} eder\\.$`));
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

test("an estimated day says so; the range gets its book and its busiest model", () => {
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
  assert.deepEqual(all.map((l) => l.key), ["book-day", "carried", "estimated", "book-range", "model"]);
  assert.equal(all[2].tr, "Bu günü limit ölçümlerinden tahmin ettim; ≈ işaretleri ondan.");
  assert.match(all[3].tr, /^Bu 30 günde girdi ve çıktın (≈ [\d,]+ .+|aşağı yukarı bir .+ kadar)\.$/);
  assert.equal(all[4].tr, "Bu aralıkta en çok Opus 5.5 çalıştı: %64.");
  assert.equal(all[4].en, "Opus 5.5 did most of the work in this range: 64%.");
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
