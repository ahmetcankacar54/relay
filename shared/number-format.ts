// Number formats shared by the renderer and main (the widget file), in the reader's language.
import { FORMAT_LOCALE, type Locale } from "./i18n/locales";

const locale = (language: Locale) => FORMAT_LOCALE[language];

const tokenFormats = new Map<Locale, Intl.NumberFormat>();
/** A token count in compact units: "1,2 Mn" / "1.2m", "326 B" / "326k". */
export function formatTokens(value: number, language: Locale) {
  let f = tokenFormats.get(language);
  if (!f) {
    f = new Intl.NumberFormat(locale(language), {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    tokenFormats.set(language, f);
  }
  return f.format(value);
}

const costFormats = new Map<string, Intl.NumberFormat>();
/** An API value in US dollars: "$444,56" / "$444.56", compact from $10,000 ("$12,3 B"). */
export function formatCost(value: number, language: Locale) {
  const compact = Math.abs(value) >= 10_000;
  const key = `${language}:${compact}`;
  let f = costFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale(language), {
      style: "currency",
      currency: "USD",
      currencyDisplay: "narrowSymbol",
      ...(compact
        ? { notation: "compact", maximumFractionDigits: 1 }
        : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    });
    costFormats.set(key, f);
  }
  return f.format(value);
}

const changeFormats = new Map<Locale, Intl.NumberFormat>();
/** A signed change: "+%57,2" / "+57.2%", "−%3" / "−3%". */
export function formatChange(change: number, language: Locale) {
  let f = changeFormats.get(language);
  if (!f) {
    f = new Intl.NumberFormat(locale(language), {
      style: "percent",
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    });
    changeFormats.set(language, f);
  }
  return f.format(change);
}
