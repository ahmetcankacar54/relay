import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RelayAPI } from "../../shared/types";
import { formatRich, loadCatalog, setPseudo, tFor, type MessageId, type Params, type T } from "../../shared/i18n/translate";
import { parsePref, resolveLocale, type LanguagePref, type Locale } from "../../shared/i18n/locales";
import { LANGUAGE_KEY, prefFromStorage } from "./language";

export type { Locale, LanguagePref, MessageId, T };
/** The language Relay speaks in this window. */
export type Language = Locale;

export interface I18n {
  language: Locale;
  pref: LanguagePref;
  setLanguage(pref: LanguagePref): void;
  t: T;
}
export const I18nContext = createContext<I18n | null>(null);

const resolve = (pref: LanguagePref) => resolveLocale(pref, navigator.languages ?? [navigator.language]);
/** The language "System" stands for in this window. */
export const systemLocale = () => resolve("system");
let booted: { pref: LanguagePref; locale: Locale } | undefined;

/**
 * Picks this window's language before the first render, so nothing paints in the wrong one: the
 * preference this window saved, else main's, resolved against the system languages.
 */
export async function bootI18n(api: RelayAPI) {
  if (import.meta.env.DEV) setPseudo(new URLSearchParams(location.search).has("pseudo"));
  const stored = parsePref(localStorage.getItem(LANGUAGE_KEY));
  const pref = stored ?? (await api.getLanguage().then((v) => v.pref, () => "system" as const));
  const locale = resolve(pref);
  await loadCatalog(locale);
  // Windows from before main kept the language hand it over once.
  if (stored) void api.setLanguage(stored).catch(() => {});
  booted = { pref, locale };
}

/** The language the window booted in, for code outside React (the error boundary). */
export const bootLocale = (): Locale => booted?.locale ?? "en";

/** A window without a provider (the switch window) speaks the language main sends with its view. */
export async function adoptLocale(locale: Locale) {
  await loadCatalog(locale);
  booted = { pref: booted?.pref ?? locale, locale };
}

export function I18nProvider({ api, children }: { api: RelayAPI; children: ReactNode }) {
  const [state, setState] = useState(() => booted ?? { pref: "system" as LanguagePref, locale: resolve("system") });
  const choose = (pref: LanguagePref, persist: boolean) => {
    const locale = resolve(pref);
    void loadCatalog(locale).then(() => {
      setState({ pref, locale });
      if (persist) {
        localStorage.setItem(LANGUAGE_KEY, pref);
        void api.setLanguage(pref).catch(() => {});
      }
    });
  };
  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);
  // The menu bar panel lives as long as Relay; follow changes made in the main window.
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      const next = prefFromStorage(event);
      if (next) choose(next, false);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  });
  const value = useMemo<I18n>(
    () => ({ language: state.locale, pref: state.pref, setLanguage: (pref) => choose(pref, true), t: tFor(state.locale) }),
    // `choose` only closes over `api`.
    [state, api],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n outside I18nProvider");
  return value;
}

/**
 * A message with markup: each `<tag>…</tag>` in it is drawn by `components[tag]`, so a sentence
 * with a bold name or a link stays one message for translators.
 */
export function Trans({
  id,
  params,
  components,
}: {
  id: MessageId;
  params?: Params;
  components: Record<string, (chunks: ReactNode[]) => ReactNode>;
}) {
  const { language } = useI18n();
  const parts = formatRich(language, id, { ...params, ...components });
  return <>{parts.map((part, i) => (typeof part === "string" ? part : <Fragment key={i}>{part as ReactNode}</Fragment>))}</>;
}
