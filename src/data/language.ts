// Kept free of React and DOM globals so it can be unit tested under Node.
export type Language = "tr" | "en";
export const LANGUAGE_KEY = "relay-language";

export const parseLanguage = (value: string | null): Language =>
  value === "en" ? "en" : "tr";

/** A `storage` event from another Relay window (main window ↔ panel). */
export function languageFromStorage(event: {
  key: string | null;
  newValue: string | null;
}): Language | undefined {
  return event.key === LANGUAGE_KEY ? parseLanguage(event.newValue) : undefined;
}
