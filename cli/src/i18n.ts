export type Lang = "tr" | "en";
export type Translate = (tr: string, en: string) => string;

const asLang = (value: string | undefined): Lang | undefined =>
  value === "tr" || value === "en" ? value : undefined;

/**
 * The CLI's language: --lang, then RELAY_LANG, then the locale (LC_ALL, then LC_MESSAGES, then
 * LANG; a value starting with "tr" is Turkish), else English.
 */
export function pickLang(flag: string | undefined, env: NodeJS.ProcessEnv): Lang {
  const chosen = asLang(flag) ?? asLang(env.RELAY_LANG);
  if (chosen) return chosen;
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) => !!value);
  return locale?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function translator(lang: Lang): Translate {
  return (tr, en) => (lang === "tr" ? tr : en);
}
