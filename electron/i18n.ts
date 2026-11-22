import "../shared/i18n/catalogs/all";
import type { Locale } from "../shared/i18n/locales";
import { tFor, type MessageId, type Params } from "../shared/i18n/translate";

/** The language main's own surfaces speak: menus, dialogs, notifications, the tray and the widget. */
let appLocale: Locale = "en";
let translate = tFor(appLocale);

export const getAppLocale = () => appLocale;

/** Switches main's language; true when it changed. */
export function setAppLocale(locale: Locale) {
  if (locale === appLocale) return false;
  appLocale = locale;
  translate = tFor(locale);
  return true;
}

/** Main's copy in the app's language. */
export const say = (id: MessageId, params?: Params) => translate(id, params);
