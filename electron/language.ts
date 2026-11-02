/** The language the app's own surfaces speak: the language setting the renderer sends to main. */
export type AppLanguage = "tr" | "en";

/**
 * Picks the Turkish or the English copy for a language. Main's menus, dialogs, notifications and
 * the tray's fallback menu all choose their words through it.
 */
export const pick =
  (language: AppLanguage) =>
  (tr: string, en: string): string =>
    language === "en" ? en : tr;
