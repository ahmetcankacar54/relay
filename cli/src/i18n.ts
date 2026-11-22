import "../../shared/i18n/catalogs/all";
import { parsePref, resolveLocale, type Locale } from "../../shared/i18n/locales";
import { tFor, type T } from "../../shared/i18n/translate";

/**
 * The CLI's language: --lang, then RELAY_LANG (a locale or "system"), then the first supported
 * POSIX locale (LC_ALL, then LC_MESSAGES, then LANG), else English.
 */
export function pickLang(flag: string | undefined, env: NodeJS.ProcessEnv): Locale {
  return resolveLocale(
    parsePref(flag) ?? parsePref(env.RELAY_LANG) ?? "system",
    [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter((v): v is string => !!v).map((v) => v.split(".")[0]),
  );
}

export const translator = (locale: Locale): T => tFor(locale);
