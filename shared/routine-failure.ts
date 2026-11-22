import type { Locale } from "./i18n/locales";
import { tFor, type MessageId } from "./i18n/translate";

/**
 * Why the keeper could not start an account's limit period, in words. The planning panel and the
 * notification main shows both read them.
 */
const ROUTINE_FAILURES: Record<string, MessageId> = {
  "routine-policy-unverified": "routineFailure.administratorPolicyOrIdentityNot",
  "routine-policy-check-failed": "routineFailure.administratorPolicyCheckFailedRelay",
  "routine-cli-unavailable": "routineFailure.claudeCliNotFound",
  "routine-cli-unsupported": "routineFailure.claudeCliVersionNotSupported",
  "routine-credentials-unavailable": "routineFailure.usageSignInExpired",
  "routine-platform-unsupported": "routineFailure.notSupportedOnThisSystem",
  "routine-settings-changed": "routineFailure.settingsChanged",
  interrupted: "routineFailure.relayQuit",
};

/** The message for a keeper failure reason; undefined for a reason without a label. */
export const routineFailure = (reason: string | undefined): MessageId | undefined =>
  Object.hasOwn(ROUTINE_FAILURES, reason ?? "")
    ? ROUTINE_FAILURES[reason!]
    : undefined;

/** The notification when an account's limit period could not start; an unlabelled reason is left out. */
export function routineFailureNotice(
  name: string,
  reason: string,
  language: Locale,
): string {
  const t = tFor(language);
  const words = routineFailure(reason);
  return words
    ? t("routineFailure.limitPeriodDidNotStartReason", { name, reason: t(words) })
    : t("routineFailure.limitPeriodDidNotStart", { name });
}
