/**
 * The languages Relay speaks. English is the source; every other catalog translates its ids. Kept
 * free of Electron, React and the DOM so the renderer, main, the CLI and tests share it.
 */
export const LOCALES = [
  "en",
  "tr",
  "de",
  "fr",
  "es",
  "pt-BR",
  "it",
  "ja",
  "ko",
  "zh-Hans",
  "zh-Hant",
  "ru",
  "uk",
  "pl",
  "nl",
] as const;
export type Locale = (typeof LOCALES)[number];
/** The setting: a language, or whatever the system prefers. */
export type LanguagePref = "system" | Locale;

/** Each language in its own words, for the picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  tr: "Türkçe",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  ru: "Русский",
  uk: "Українська",
  pl: "Polski",
  nl: "Nederlands",
};

/**
 * The Intl locale behind each language's numbers and dates. English uses en-GB for day-month
 * dates; every clock in Relay is 24-hour.
 */
export const FORMAT_LOCALE: Record<Locale, string> = {
  en: "en-GB",
  tr: "tr-TR",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  "pt-BR": "pt-BR",
  it: "it-IT",
  ja: "ja-JP",
  ko: "ko-KR",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  ru: "ru-RU",
  uk: "uk-UA",
  pl: "pl-PL",
  nl: "nl-NL",
};

const isLocale = (value: string): value is Locale => (LOCALES as readonly string[]).includes(value);

/** The supported language a BCP 47 tag or a POSIX locale (`tr_TR.UTF-8`) means, if any. */
export function matchLocale(tag: string | undefined): Locale | undefined {
  if (!tag) return undefined;
  const clean = tag.split(".")[0].split("@")[0].replace(/_/g, "-").toLowerCase();
  if (!clean || clean === "c" || clean === "posix") return undefined;
  const [language, ...rest] = clean.split("-");
  if (language === "zh") {
    if (rest.includes("hant") || rest.some((r) => r === "tw" || r === "hk" || r === "mo")) return "zh-Hant";
    return "zh-Hans";
  }
  if (language === "pt") return "pt-BR";
  return isLocale(language) ? language : undefined;
}

/** A stored or passed preference, if it is one. */
export function parsePref(value: unknown): LanguagePref | undefined {
  return value === "system" || (typeof value === "string" && isLocale(value)) ? value : undefined;
}

/** The language to speak: an explicit choice, else the first supported system language, else English. */
export function resolveLocale(pref: LanguagePref | undefined, system: readonly (string | undefined)[]): Locale {
  if (pref && pref !== "system") return pref;
  for (const tag of system) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return "en";
}
