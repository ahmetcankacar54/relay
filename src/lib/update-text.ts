import type { UpdateState } from "../../shared/types";
import type { T } from "@/data/i18n";

/** The install action's busy key. */
export const UPDATE_INSTALL_KEY = "update-install";

/** Whether the update asks for attention: ready, on its way, installing, or to be fetched by hand. */
export function updateShown(update: UpdateState | undefined): update is UpdateState & { version: string } {
  return (
    !!update?.version &&
    (update.status === "ready" ||
      update.status === "downloading" ||
      update.status === "installing" ||
      update.status === "manual")
  );
}

/** The update in one line. */
export function updateTitle(update: UpdateState & { version: string }, t: T): string {
  const v = update.version;
  switch (update.status) {
    case "downloading":
      return t("updateText.relayDownloaded", { v, round: Math.round((update.progress ?? 0) * 100) });
    case "installing":
      return t("updateText.relayInstallInProgressRelayOpens", { v });
    case "manual":
      return t("updateText.relayIsAvailable", { v });
    default:
      return t("updateText.relayIsReady", { v });
  }
}

/** What to know under the line: why it must be downloaded by hand, or what Update does. */
export function updateHint(update: UpdateState, t: T): string {
  if (update.status === "manual")
    switch (update.manualReason) {
      case "location":
        return t("updateText.relayRunsFromTheDiskImage");
      case "not-writable":
        return t("updateText.relayCannotReplaceItsOwnFiles");
      case "not-appimage":
        return t("updateText.relayDoesNotRunAsAn");
      default:
        return t("updateText.noAutomaticUpdateForThisComputer");
    }
  if (update.status === "ready")
    return t("updateText.updateQuitsRelayAndOpensThe");
  return "";
}
