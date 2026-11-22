// What the panda says about a token day (docs/superpowers/specs/2026-10-19-panda-explains-design.md).
// A Turkish line never puts a suffix on a number or a name.
import type {
  TokenCounts,
  TokenUsageView,
} from "../../../shared/token-usage-view";
import { formatPercent } from "@/lib/meter";
import type { Language, MessageId, T } from "@/data/i18n";
import { FORMAT_LOCALE } from "../../../shared/i18n/locales";

/** A book and roughly how many tokens it is: about 1.3 tokens per English word; the ≈ ones are estimated from page counts. */
export interface Book {
  name: MessageId;
  tokens: number;
}

export const BOOKS: readonly Book[] = [
  { name: "pandaFacts.theLittlePrince", tokens: 22_000 },
  { name: "pandaFacts.animalFarm", tokens: 39_000 },
  // ≈ from its page count.
  { name: "pandaFacts.madonnaInAFurCoat", tokens: 90_000 },
  { name: "pandaFacts.theHobbit", tokens: 123_000 },
  { name: "pandaFacts.crimeAndPunishment", tokens: 274_000 },
  // ≈ from its page count.
  { name: "pandaFacts.theDisconnected", tokens: 400_000 },
  { name: "pandaFacts.theLordOfTheRings", tokens: 576_000 },
  { name: "pandaFacts.warAndPeace", tokens: 730_000 },
  { name: "pandaFacts.shakespeareSCompleteWorks", tokens: 1_150_000 },
  { name: "pandaFacts.theHarryPotterSeries", tokens: 1_410_000 },
  { name: "pandaFacts.englishWikipedia", tokens: 6_900_000_000 },
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
  text: string;
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
  const tenths = new Intl.NumberFormat(FORMAT_LOCALE[language], {
    style: "percent",
    maximumFractionDigits: 1,
  });
  return percent < 0.1 ? `<${tenths.format(0.001)}` : tenths.format(share);
}

/** How many times: one decimal under 10 ("3,1"), whole above ("44"). */
function formatTimes(times: number, language: Language) {
  return new Intl.NumberFormat(FORMAT_LOCALE[language], {
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

/** "≈ 12 Hobbit kadar" / "≈ 12× The Hobbit", or "about as much as …" between 1 and 2. */
function bookAmount(tokens: number, book: Book, t: T, language: Language) {
  const times = tokens / book.tokens;
  return times < 2
    ? t("pandaFacts.aboutAsMuchAs", { book: t(book.name) })
    : t("pandaFacts.timesBook", {
        times: formatTimes(times, language),
        book: t(book.name),
      });
}

/** "6.600" pages: two significant digits, at least one. */
function formatPages(tokens: number, language: Language) {
  return new Intl.NumberFormat(FORMAT_LOCALE[language], {
    maximumSignificantDigits: 2,
  }).format(Math.max(1, tokens / TOKENS_PER_PAGE));
}

/** "2,9 milyar" / "2.9 billion": a count spelled out for a sentence. */
export function formatCount(value: number, language: Language) {
  return new Intl.NumberFormat(FORMAT_LOCALE[language], {
    notation: "compact",
    compactDisplay: "long",
    maximumFractionDigits: 1,
  }).format(value);
}

/** How much less than an ordinary day a quiet one is: the `fraction` of "pandaFacts.aQuietDay". */
function quietFraction(ratio: number) {
  if (ratio <= 0.1) return "tenth";
  if (ratio <= 0.25) return "quarter";
  if (ratio <= 1 / 3) return "third";
  return "half";
}

/**
 * Where the day stands among the range's active days: its rank when it is one of the three busiest, else
 * how it compares with an ordinary day (the median active day). Undefined with too few active days.
 */
function rankLine(
  view: TokenUsageView,
  date: string,
  total: number,
  t: T,
  language: Language,
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
  const times = formatTimes(ratio, language);
  const range = view.range;
  // A top-three day is named only when it stands out, so days alike do not all claim to be the busiest.
  if (rank === 1 && ratio >= 1.2)
    return { key: "rank", text: t("pandaFacts.theBusiestOfTheseDays", { range, times }) };
  if (rank >= 2 && rank <= 3 && ratio >= 1.2)
    return { key: "rank", text: t("pandaFacts.theNthBusiestOfTheseDays", { rank, range, times }) };
  if (ratio >= 1.5)
    return { key: "rank", text: t("pandaFacts.aBusyDay", { times }) };
  if (ratio < 0.5)
    return { key: "rank", text: t("pandaFacts.aQuietDay", { fraction: quietFraction(ratio) }) };
  return { key: "rank", text: t("pandaFacts.anOrdinaryDay") };
}

/** How long a person would read `tokens` without stopping: minutes, hours, days, months or years. */
export function readingTime(tokens: number, t: T) {
  const minutes = tokens / TOKENS_PER_WORD / WORDS_PER_MINUTE;
  const hours = minutes / 60;
  const days = hours / 24;
  const months = days / 30;
  const unit =
    hours < 1
      ? { count: Math.max(1, Math.round(minutes)), unit: "minute" }
      : days < 2
        ? { count: Math.round(hours), unit: "hour" }
        : days < 60
          ? { count: Math.round(days), unit: "day" }
          : months < 24
            ? { count: Math.round(months), unit: "month" }
            : { count: Math.round(months / 12), unit: "year" };
  return t("pandaFacts.readingTime", unit);
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
export function pandaLines(input: DayInput, t: T, language: Language): PandaLine[] {
  const { view, date, accountNames, today } = input;
  const { kinds, rows, estimated, total } = dayParts(input);
  if (total === 0)
    return [{ key: "empty", text: t("pandaFacts.nothingHereIHadALittle") }];
  const lines: PandaLine[] = [];
  const share = (value: number, of = total) => value / of;
  const when = date === today ? "today" : "past";
  const rank = rankLine(view, date, total, t, language);
  if (rank) lines.push(rank);
  // What Claude wrote: its output, in pages and in a book.
  if (kinds.output >= TOKENS_PER_PAGE) {
    const book = pickBook(kinds.output, `${date}:wrote`);
    const pages = formatPages(kinds.output, language);
    lines.push({
      key: "wrote",
      text: book
        ? t("pandaFacts.claudeWrotePagesAmount", { when, pages, amount: bookAmount(kinds.output, book, t, language) })
        : t("pandaFacts.claudeWrotePages", { when, pages }),
    });
  }
  // What it read to do so: everything it was given, cached or not.
  const read = kinds.input + kinds.cacheWrite + kinds.cacheRead;
  if (read > 0) {
    lines.push({
      key: "read",
      text: t("pandaFacts.claudeReadTokens", { when, count: formatCount(read, language), time: readingTime(read, t) }),
    });
  }
  // Only an account carries a day, and only when the range has more than one row to choose from.
  const top = rows[0];
  const carrier =
    top && view.rows.length > 1 ? accountNames[top.key] : undefined;
  if (carrier && rows.length === 1)
    lines.push({ key: "carried", text: t("pandaFacts.carriedThisDayAlone", { carrier }) });
  else if (carrier && share(top.total) >= CARRIED_SHARE)
    lines.push({
      key: "carried",
      text: t("pandaFacts.pulledMostOfThisDay", { carrier, share: formatShare(share(top.total), language) }),
    });
  if (estimated)
    lines.push({ key: "estimated", text: t("pandaFacts.iEstimatedThisDayFromLimit") });
  const rangeWrote = view.totals.output;
  if (rangeWrote >= TOKENS_PER_PAGE) {
    const book = pickBook(rangeWrote, `${date}:range`);
    const pages = formatPages(rangeWrote, language);
    lines.push({
      key: "range-wrote",
      text: book
        ? t("pandaFacts.overTheseDaysClaudeWroteAmount", { range: view.range, pages, amount: bookAmount(rangeWrote, book, t, language) })
        : t("pandaFacts.overTheseDaysClaudeWrote", { range: view.range, pages }),
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
      text: t("pandaFacts.workedTheMostInThisRange", { model: name, share: formatShare(part, language) }),
    });
  }
  return lines;
}
