// Kept free of React and DOM globals so it can be unit tested under Node.
import { parsePref, type LanguagePref } from "../../shared/i18n/locales";

/** This window's saved language preference (shared by the main window and the panel). */
export const LANGUAGE_KEY = "relay-language";

/** A `storage` event from another Relay window (main window ↔ panel). */
export function prefFromStorage(event: { key: string | null; newValue: string | null }): LanguagePref | undefined {
  return event.key === LANGUAGE_KEY ? parsePref(event.newValue) : undefined;
}
