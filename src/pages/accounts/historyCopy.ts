import type { RelaySettings } from "../../../shared/types";

type T = (tr: string, en: string) => string;

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
        note: t(
          "Code geçmişi bağlı tüm hesaplar arasında ortak. Geçiş sayfasından değiştirebilirsin.",
          "Code history is shared across every connected account. You can change this on the Switching page.",
        ),
      };
    case "selected":
      return {
        note: t(
          "Code geçmişi yalnızca Geçiş sayfasında seçtiğin hesaplar arasında ortak.",
          "Code history is shared only between the accounts you pick on the Switching page.",
        ),
      };
    case "off":
      return {
        note: t(
          "Code geçmişi hesaplar arasında paylaşılmıyor.",
          "Code history is not shared between accounts.",
        ),
      };
    case "same-group":
      return {
        groupPlaceholder: t(
          "Aynı gruptaki şirket hesapları Code geçmişini paylaşır",
          "Work accounts in the same group share Code history",
        ),
        note:
          kind === "personal"
            ? t(
                "Kişisel hesapların Code geçmişi aynı grupta korunur.",
                "Personal accounts share their local Code history.",
              )
            : t(
                "Boş bırakırsan bu şirket hesabı ayrı tutulur.",
                "Leave blank to keep this work account separate.",
              ),
      };
  }
}
