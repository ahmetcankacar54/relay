import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RelayAPI } from "../../shared/types";
import { LANGUAGE_KEY, languageFromStorage, parseLanguage, type Language } from "./language";
export type { Language };
export type T = (tr: string, en: string) => string;
export const I18nContext = createContext<{ language: Language; setLanguage(l: Language): void; t: T } | null>(null);
export function I18nProvider({ api, children }: { api: RelayAPI; children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => parseLanguage(localStorage.getItem(LANGUAGE_KEY)));
  useEffect(() => {
    localStorage.setItem(LANGUAGE_KEY, language);
    document.documentElement.lang = language;
    void api.setTrayLanguage(language).catch(() => {});
  }, [api, language]);
  // The menu bar panel lives as long as Relay; follow changes made in the main window.
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      const next = languageFromStorage(event);
      if (next) setLanguage(next);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  const value = useMemo(
    () => ({ language, setLanguage, t: ((tr, en) => (language === "tr" ? tr : en)) as T }),
    [language],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}
