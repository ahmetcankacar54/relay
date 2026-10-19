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
/** A printed page: about 500 words. */
const TOKENS_PER_PAGE = 500 * TOKENS_PER_WORD;
/** The top row carries the day from this share. */
const CARRIED_SHARE = 0.6;
/** A day is ranked against the range's ordinary day only with this many active days. */
const MIN_ACTIVE_DAYS = 5;

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

/** A share of a whole: one decimal under 10 ("%0,9"), whole above ("%82"), "<%0,1" for a sliver. */
export function formatShare(share: number, language: Language) {
  const percent = share * 100;
  if (percent >= 10 || percent === 0) return formatPercent(percent, language);
  if (percent < 0.1) return language === "tr" ? "<%0,1" : "<0.1%";
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

/** "≈ 12 Hobbit kadar" / "≈ 12× The Hobbit", or "about one …" between 1 and 2. */
function bookAmount(tokens: number, book: Book) {
  const times = tokens / book.tokens;
  return times < 2
    ? {
        tr: `aşağı yukarı bir ${book.tr} kadar`,
        en: `about one ${book.en}`,
      }
    : {
        tr: `≈ ${formatTimes(times, "tr")} ${book.tr} kadar`,
        en: `≈ ${formatTimes(times, "en")}× ${book.en}`,
      };
}

/** "6.600" pages: two significant digits, at least one. */
function formatPages(tokens: number, language: Language) {
  return new Intl.NumberFormat(locale(language), {
    maximumSignificantDigits: 2,
  }).format(Math.max(1, tokens / TOKENS_PER_PAGE));
}

/** "2,9 milyar" / "2.9 billion": a count spelled out for a sentence. */
export function formatCount(value: number, language: Language) {
  return new Intl.NumberFormat(locale(language), {
    notation: "compact",
    compactDisplay: "long",
    maximumFractionDigits: 1,
  }).format(value);
}

/** How much less than an ordinary day a quiet one is, in words. */
function quietFraction(ratio: number) {
  if (ratio <= 0.1)
    return { tr: "onda birinden az", en: "less than a tenth of" };
  if (ratio <= 0.25)
    return { tr: "dörtte birinden az", en: "less than a quarter of" };
  if (ratio <= 1 / 3)
    return { tr: "üçte birinden az", en: "less than a third of" };
  return { tr: "yarısından az", en: "less than half of" };
}

const ORDINAL_EN = ["", "", "second ", "third "];

/**
 * Where the day stands among the range's active days: its rank when it is one of the three busiest, else
 * how it compares with an ordinary day (the median active day). Undefined with too few active days.
 */
function rankLine(
  view: TokenUsageView,
  date: string,
  total: number,
): PandaLine | undefined {
  const totals = view.days
    .map((day) =>
      Object.values(day.byRow).reduce((sum, cell) => sum + kindsTotal(cell), 0),
    )
    .filter((value) => value > 0)
    .sort((a, b) => b - a);
  if (totals.length < MIN_ACTIVE_DAYS) return undefined;
  const ordinary = totals[Math.floor(totals.length / 2)];
  const ratio = total / ordinary;
  const rank = totals.indexOf(total) + 1;
  const times = { tr: formatTimes(ratio, "tr"), en: formatTimes(ratio, "en") };
  const range = view.range;
  // A top-three day is named only when it stands out, so days alike do not all claim to be the busiest.
  if (rank >= 1 && rank <= 3 && ratio >= 1.2)
    return {
      key: "rank",
      tr: `Bu ${range} günün en yoğun ${rank === 1 ? "" : `${rank}. `}günü: sıradan bir gününün ${times.tr} katı.`,
      en: `The ${ORDINAL_EN[rank]}busiest of these ${range} days: ${times.en}× an ordinary day.`,
    };
  if (ratio >= 1.5)
    return {
      key: "rank",
      tr: `Yoğun bir gün: sıradan bir gününün ${times.tr} katı.`,
      en: `A busy day: ${times.en}× an ordinary day.`,
    };
  if (ratio < 0.5) {
    const fraction = quietFraction(ratio);
    return {
      key: "rank",
      tr: `Sakin bir gün: sıradan bir gününün ${fraction.tr}.`,
      en: `A quiet day: ${fraction.en} an ordinary day.`,
    };
  }
  return {
    key: "rank",
    tr: "Sıradan bir gün; ne fazla ne az.",
    en: "An ordinary day, no more and no less.",
  };
}

/** How long a person would read `tokens` without stopping: minutes, hours, days, months or years. */
export function readingTime(tokens: number) {
  const minutes = tokens / TOKENS_PER_WORD / WORDS_PER_MINUTE;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30;
  const unit =
    hours < 1
      ? { n: Math.max(1, Math.round(minutes)), tr: "dakika", en: "minute" }
      : days < 2
        ? { n: Math.round(hours), tr: "saat", en: "hour" }
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

/** "claude-opus-5-5" → "Opus 5.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5"; a date is dropped; anything else as it is. */
export function modelName(model: string) {
  const parts = model.replace(/^claude-/, "").split("-");
  const family = parts.findIndex((part) => /^[a-z]+$/i.test(part));
  if (family < 0) return model;
  const numbers = (list: string[]) =>
    list.filter((part) => /^\d{1,2}$/.test(part));
  const after = numbers(parts.slice(family + 1));
  const version = after.length ? after : numbers(parts.slice(0, family));
  const name = parts[family][0].toUpperCase() + parts[family].slice(1);
  return version.length ? `${name} ${version.join(".")}` : name;
}

export interface DayInput {
  view: TokenUsageView;
  date: string;
  /** The display names of the rows that are accounts, by row key; only an account carries a day. */
  accountNames: Record<string, string>;
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
  const { view, date, accountNames, today } = input;
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
  const isToday = date === today;
  const rank = rankLine(view, date, total);
  if (rank) lines.push(rank);
  // What Claude wrote: its output, in pages and in a book.
  if (kinds.output >= TOKENS_PER_PAGE) {
    const book = pickBook(kinds.output, `${date}:wrote`);
    const amount = book && bookAmount(kinds.output, book);
    lines.push({
      key: "wrote",
      tr: `Claude ${isToday ? "bugün" : "bu gün"} ≈ ${formatPages(kinds.output, "tr")} sayfa yazdı${amount ? `; ${amount.tr}` : ""}.`,
      en: `Claude wrote ≈ ${formatPages(kinds.output, "en")} pages ${isToday ? "today" : "this day"}${amount ? `, ${amount.en}` : ""}.`,
    });
  }
  // What it read to do so: everything it was given, cached or not.
  const read = kinds.input + kinds.cacheWrite + kinds.cacheRead;
  if (read > 0) {
    const time = readingTime(read);
    lines.push({
      key: "read",
      tr: `Claude ${isToday ? "bugün" : "bu gün"} ${formatCount(read, "tr")} token okudu; bir insan durmadan okusa ${time.tr} sürerdi.`,
      en: `Claude read ${formatCount(read, "en")} tokens ${isToday ? "today" : "this day"}; a person reading nonstop would need ${time.en}.`,
    });
  }
  // Only an account carries a day, and only when the range has more than one row to choose from.
  const top = rows[0];
  const carrier =
    top && view.rows.length > 1 ? accountNames[top.key] : undefined;
  if (carrier && rows.length === 1)
    lines.push({
      key: "carried",
      tr: `Bu günü tek başına ${carrier} taşıdı.`,
      en: `${carrier} carried this day alone.`,
    });
  else if (carrier && share(top.total) >= CARRIED_SHARE)
    lines.push({
      key: "carried",
      tr: `Bu günün yükünü büyük ölçüde ${carrier} çekti: ${formatShare(share(top.total), "tr")}.`,
      en: `${carrier} pulled most of this day: ${formatShare(share(top.total), "en")}.`,
    });
  if (estimated)
    lines.push({
      key: "estimated",
      tr: "Bu günü limit ölçümlerinden tahmin ettim; ≈ işaretleri ondan.",
      en: "I worked this day out from limit readings; that is what the ≈ marks mean.",
    });
  const rangeWrote = view.totals.output;
  if (rangeWrote >= TOKENS_PER_PAGE) {
    const book = pickBook(rangeWrote, `${date}:range`);
    const amount = book && bookAmount(rangeWrote, book);
    lines.push({
      key: "range-wrote",
      tr: `Bu ${view.range} günde Claude ≈ ${formatPages(rangeWrote, "tr")} sayfa yazdı${amount ? `; ${amount.tr}` : ""}.`,
      en: `Over these ${view.range} days Claude wrote ≈ ${formatPages(rangeWrote, "en")} pages${amount ? `, ${amount.en}` : ""}.`,
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
      en: `${name} worked the most in this range: ${formatShare(part, "en")}.`,
    });
  }
  return lines;
}
