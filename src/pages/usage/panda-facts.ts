// What the panda says about a token day (docs/superpowers/specs/2026-10-19-panda-explains-design.md).
// Every line is written in both languages; a Turkish line never puts a suffix on a number or a name.
import type {
  TokenCounts,
  TokenUsageView,
} from "../../../shared/token-usage-view";
import { formatPercent } from "@/lib/meter";
import type { Language } from "@/data/i18n";
import { locale } from "./format";

/** A book and roughly how many tokens it is: about 1.3 tokens per English word; the ≈ ones are estimated from page counts. */
export interface Book {
  tr: string;
  en: string;
  tokens: number;
}

export const BOOKS: readonly Book[] = [
  { tr: "Küçük Prens", en: "The Little Prince", tokens: 22_000 },
  { tr: "Hayvan Çiftliği", en: "Animal Farm", tokens: 39_000 },
  // ≈ from its page count.
  { tr: "Kürk Mantolu Madonna", en: "Madonna in a Fur Coat", tokens: 90_000 },
  { tr: "Hobbit", en: "The Hobbit", tokens: 123_000 },
  { tr: "Suç ve Ceza", en: "Crime and Punishment", tokens: 274_000 },
  // ≈ from its page count.
  { tr: "Tutunamayanlar", en: "The Disconnected", tokens: 400_000 },
  {
    tr: "Yüzüklerin Efendisi",
    en: "The Lord of the Rings",
    tokens: 576_000,
  },
  { tr: "Savaş ve Barış", en: "War and Peace", tokens: 730_000 },
  {
    tr: "Shakespeare’in bütün eserleri",
    en: "Shakespeare’s complete works",
    tokens: 1_150_000,
  },
  {
    tr: "Harry Potter serisi",
    en: "the Harry Potter series",
    tokens: 1_410_000,
  },
  { tr: "İngilizce Vikipedi", en: "English Wikipedia", tokens: 6_900_000_000 },
];

/** A comparison names a book the value is at least once and at most this many times. */
const BOOK_BAND = 1_000;
const TOKENS_PER_WORD = 1.3;
const WORDS_PER_MINUTE = 238;
/** Cache reads from this share of the day make the panda's first line. */
const CACHE_LINE_SHARE = 0.5;
/** The top row carries the day from this share. */
const CARRIED_SHARE = 0.6;
/** Output below this share is worth a line. */
const OUTPUT_LINE_SHARE = 0.05;

export interface PandaLine {
  key: string;
  tr: string;
  en: string;
}

export type DayKinds = Pick<
  TokenCounts,
  "input" | "output" | "cacheWrite" | "cacheRead"
>;

export const kindsTotal = (c: DayKinds) =>
  c.input + c.output + c.cacheWrite + c.cacheRead;

/** A share of a whole: one decimal under 10 ("%0,9"), whole above ("%82"). */
export function formatShare(share: number, language: Language) {
  const percent = share * 100;
  if (percent >= 10 || percent === 0) return formatPercent(percent, language);
  const n = new Intl.NumberFormat(locale(language), {
    maximumFractionDigits: 1,
  }).format(percent);
  return language === "tr" ? `%${n}` : `${n}%`;
}

/** How many times: one decimal under 10 ("3,1"), whole above ("44"). */
function formatTimes(times: number, language: Language) {
  return new Intl.NumberFormat(locale(language), {
    maximumFractionDigits: times < 10 ? 1 : 0,
  }).format(times);
}

/** A small stable number from text, to vary the book without randomness. */
function seedOf(text: string) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

/** The book a value is compared with; undefined below the smallest. */
export function pickBook(tokens: number, seed: string): Book | undefined {
  const within = BOOKS.filter(
    (book) => tokens >= book.tokens && tokens / book.tokens <= BOOK_BAND,
  );
  if (within.length) return within[seedOf(seed) % within.length];
  return [...BOOKS].reverse().find((book) => tokens >= book.tokens);
}

/** "≈ 3,1 Tutunamayanlar" / "≈ 3.1× The Disconnected", or "about one …" between 1 and 2. */
function bookAmount(tokens: number, book: Book) {
  const times = tokens / book.tokens;
  return times < 2
    ? {
        tr: `aşağı yukarı bir ${book.tr} kadar`,
        en: `about as much as ${book.en}`,
      }
    : {
        tr: `≈ ${formatTimes(times, "tr")} ${book.tr}`,
        en: `≈ ${formatTimes(times, "en")}× ${book.en}`,
      };
}

/** How long a person would read `tokens` without stopping: hours, days, months or years. */
export function readingTime(tokens: number) {
  const minutes = tokens / TOKENS_PER_WORD / WORDS_PER_MINUTE;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30;
  const unit =
    days < 2
      ? { n: Math.max(1, Math.round(hours)), tr: "saat", en: "hour" }
      : days < 60
        ? { n: Math.round(days), tr: "gün", en: "day" }
        : months < 24
          ? { n: Math.round(months), tr: "ay", en: "month" }
          : { n: Math.round(months / 12), tr: "yıl", en: "year" };
  const n = (language: Language) =>
    new Intl.NumberFormat(locale(language)).format(unit.n);
  return {
    tr: `${n("tr")} ${unit.tr}`,
    en: `${n("en")} ${unit.en}${unit.n === 1 ? "" : "s"}`,
  };
}

/** "claude-opus-5-5" → "Opus 5.5"; a date suffix is dropped; anything else as it is. */
export function modelName(model: string) {
  const parts = model.replace(/^claude-/, "").split("-");
  const family = parts.findIndex((part) => /^[a-z]+$/i.test(part));
  if (family < 0) return model;
  const version = parts
    .slice(family + 1)
    .filter((part) => /^\d{1,2}$/.test(part));
  const name = parts[family][0].toUpperCase() + parts[family].slice(1);
  return version.length ? `${name} ${version.join(".")}` : name;
}

export interface DayInput {
  view: TokenUsageView;
  date: string;
  /** Each row's display name, by row key. */
  names: Record<string, string>;
  /** Today in the planning zone, for "Bugünün". */
  today: string;
}

/** The day's four kinds summed over its rows, each row's total, and whether any of it was estimated. */
export function dayParts({ view, date }: Pick<DayInput, "view" | "date">) {
  const day = view.days.find((d) => d.date === date);
  const kinds: DayKinds = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const rows: { key: string; total: number }[] = [];
  let estimated = false;
  for (const [key, cell] of Object.entries(day?.byRow ?? {})) {
    kinds.input += cell.input;
    kinds.output += cell.output;
    kinds.cacheWrite += cell.cacheWrite;
    kinds.cacheRead += cell.cacheRead;
    const total = kindsTotal(cell);
    if (total > 0) rows.push({ key, total });
    estimated ||= cell.estimated && total > 0;
  }
  rows.sort((a, b) => b.total - a.total);
  return { kinds, rows, estimated, total: kindsTotal(kinds) };
}

/** The range's busiest day by all four kinds; undefined when the range has no tokens. */
export function busiestDay(view: TokenUsageView) {
  let best: { date: string; total: number } | undefined;
  for (const day of view.days) {
    const total = Object.values(day.byRow).reduce(
      (sum, cell) => sum + kindsTotal(cell),
      0,
    );
    if (total > 0 && (!best || total > best.total))
      best = { date: day.date, total };
  }
  return best?.date;
}

/** Everything the panda can say about a day, in the order it says it. */
export function pandaLines(input: DayInput): PandaLine[] {
  const { view, date, names, today } = input;
  const { kinds, rows, estimated, total } = dayParts(input);
  if (total === 0)
    return [
      {
        key: "empty",
        tr: "Bu gün boş. Ben de biraz kestirdim.",
        en: "Nothing here. I had a little nap too.",
      },
    ];
  const lines: PandaLine[] = [];
  const share = (value: number, of = total) => value / of;
  const cache = share(kinds.cacheRead);
  if (cache >= CACHE_LINE_SHARE)
    lines.push({
      key: "cache",
      tr: `Bu tepeyi söktüm: ${formatShare(cache, "tr")} önbellek okuması çıktı. Çoğunu daha önce görmüştük.`,
      en: `I took this peak apart: ${formatShare(cache, "en")} of it was cache reads. We’d seen most of it before.`,
    });
  const said = kinds.input + kinds.output;
  const book = pickBook(said, `${date}:day`);
  if (book) {
    const amount = bookAmount(said, book);
    lines.push({
      key: "book-day",
      tr: `${date === today ? "Bugünün" : "Bu günün"} girdi ve çıktısı ${amount.tr} eder.`,
      en: `${date === today ? "Today’s" : "This day’s"} input and output come to ${amount.en}.`,
    });
  }
  const top = rows[0];
  if (top && rows.length === 1)
    lines.push({
      key: "carried",
      tr: `Bu günü tek başına ${names[top.key] ?? top.key} taşıdı.`,
      en: `${names[top.key] ?? top.key} carried this day alone.`,
    });
  else if (top && share(top.total) >= CARRIED_SHARE)
    lines.push({
      key: "carried",
      tr: `Bu günün yükünü büyük ölçüde ${names[top.key] ?? top.key} çekti: ${formatShare(share(top.total), "tr")}.`,
      en: `${names[top.key] ?? top.key} pulled most of this day: ${formatShare(share(top.total), "en")}.`,
    });
  const output = share(kinds.output);
  if (output < OUTPUT_LINE_SHARE)
    lines.push({
      key: "output",
      tr: `Claude’un kendi yazdığı kısım sadece ${formatShare(output, "tr")}; gerisi okuma ve hatırlama.`,
      en: `Claude itself wrote only ${formatShare(output, "en")}; the rest was reading and remembering.`,
    });
  if (kinds.cacheRead > 0) {
    const time = readingTime(kinds.cacheRead);
    lines.push({
      key: "reading",
      tr: `Önbellekten okunanı bir insan durmadan okusa ${time.tr} sürerdi.`,
      en: `A person reading the cache reads nonstop would need ${time.en}.`,
    });
  }
  if (estimated)
    lines.push({
      key: "estimated",
      tr: "Bu günü limit ölçümlerinden tahmin ettim; ≈ işaretleri ondan.",
      en: "I worked this day out from limit readings; that is what the ≈ marks mean.",
    });
  const rangeSaid = view.totals.input + view.totals.output;
  const rangeBook = pickBook(rangeSaid, `${date}:range`);
  if (rangeBook) {
    const amount = bookAmount(rangeSaid, rangeBook);
    lines.push({
      key: "book-range",
      tr: `Bu ${view.range} günde girdi ve çıktın ${amount.tr}.`,
      en: `Your input and output over these ${view.range} days: ${amount.en}.`,
    });
  }
  const models = view.models
    .map((m) => ({ model: m.model, total: kindsTotal(m.totals) }))
    .filter((m) => m.total > 0);
  const all = models.reduce((sum, m) => sum + m.total, 0);
  if (models.length && all > 0) {
    const name = modelName(models[0].model);
    const part = share(models[0].total, all);
    lines.push({
      key: "model",
      tr: `Bu aralıkta en çok ${name} çalıştı: ${formatShare(part, "tr")}.`,
      en: `${name} did most of the work in this range: ${formatShare(part, "en")}.`,
    });
  }
  return lines;
}
