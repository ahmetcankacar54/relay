// Real catalogs for tests: render in Turkish or English exactly as the app does.
import "../shared/i18n/catalogs/all";
import { tFor } from "../shared/i18n/translate";
import type { Locale } from "../shared/i18n/locales";
import type { I18n } from "../src/data/i18n";

export const testT = (locale: Locale) => tFor(locale);
export const i18nValue = (locale: Locale): I18n => ({ language: locale, pref: locale, setLanguage() {}, t: tFor(locale) });
