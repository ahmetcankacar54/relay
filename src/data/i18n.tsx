import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RelayAPI } from "../../shared/types";
export type Language = "tr" | "en";
export type T = (tr: string, en: string) => string;
export const I18nContext = createContext<{ language: Language; setLanguage(l: Language): void; t: T } | null>(null);
export function I18nProvider({ api, children }: { api: RelayAPI; children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() =>
    localStorage.getItem("relay-language") === "en" ? "en" : "tr",
  );
  useEffect(() => {
    localStorage.setItem("relay-language", language);
    document.documentElement.lang = language;
    void api.setTrayLanguage(language).catch(() => {});
  }, [api, language]);
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
