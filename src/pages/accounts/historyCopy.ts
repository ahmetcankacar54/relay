import type { RelaySettings } from "../../../shared/types";
import type { T } from "../../../shared/i18n/translate";


/**
 * What the add-account dialog says about Code history, by the current sharing mode. Only
 * "same-group" has a group to name; in every other mode the group is ignored, so no field.
 */
export function historyCopy(
  mode: RelaySettings["desktopHistoryTransfer"],
  kind: "personal" | "work",
  t: T,
): { groupPlaceholder?: string; note: string } {
  switch (mode) {
    case "all":
      return {
        note: t("historyCopy.allConnectedAccountsShareCodeHistory"),
      };
    case "selected":
      return {
        note: t("historyCopy.onlyTheAccountsYouSelectIn"),
      };
    case "off":
      return {
        note: t("historyCopy.accountsDoNotShareCodeHistory"),
      };
    case "same-group":
      return {
        groupPlaceholder: t("historyCopy.workAccountsInTheSameGroup"),
        note:
          kind === "personal"
            ? t("historyCopy.personalAccountsShareTheirLocalCode")
            : t("historyCopy.leaveBlankToKeepThisWork"),
      };
  }
}
