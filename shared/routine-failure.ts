type Words = readonly [tr: string, en: string];

/**
 * Why the keeper could not start an account's limit period, in words. The planning panel and the
 * notification main shows both read them.
 */
const ROUTINE_FAILURES: Record<string, Words> = {
  "routine-policy-unverified": [
    "yönetici politikası veya kimlik doğrulanamadı",
    "administrator policy or identity not verified",
  ],
  "routine-cli-unavailable": ["Claude CLI bulunamadı", "Claude CLI not found"],
  "routine-cli-unsupported": [
    "Claude CLI sürümü desteklenmiyor",
    "Claude CLI version not supported",
  ],
  "routine-credentials-unavailable": [
    "limit okuma girişinin süresi dolmuş",
    "usage sign-in expired",
  ],
  "routine-platform-unsupported": [
    "bu sistemde desteklenmiyor",
    "not supported on this system",
  ],
  "routine-settings-changed": ["ayarlar değişti", "settings changed"],
  interrupted: ["Relay kapandı", "Relay quit"],
};

/** The words for a keeper failure reason; undefined for a reason without a label. */
export const routineFailure = (reason: string | undefined): Words | undefined =>
  Object.hasOwn(ROUTINE_FAILURES, reason ?? "")
    ? ROUTINE_FAILURES[reason!]
    : undefined;

/** The notification when an account's limit period could not start; an unlabelled reason is left out. */
export function routineFailureNotice(
  name: string,
  reason: string,
  language: "tr" | "en",
): string {
  const words = routineFailure(reason);
  const why = words ? ` (${language === "en" ? words[1] : words[0]})` : "";
  return language === "en"
    ? `Could not start ${name}’s limit period${why}.`
    : `${name} hesabının limit dönemi başlatılamadı${why}.`;
}
