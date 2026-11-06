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
          "Code geçmişi bağlı tüm hesaplar arasında ortak.",
          "All connected accounts share Code history.",
        ),
      };
    case "selected":
      return {
        note: t(
          "Code geçmişi yalnızca Ayarlar → Geçiş’te seçtiğin hesaplar arasında ortak.",
          "Only the accounts you select in Settings → Switching share Code history.",
        ),
      };
    case "off":
      return {
        note: t(
          "Code geçmişi hesaplar arasında paylaşılmıyor.",
          "Accounts do not share Code history.",
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
                "Kişisel hesaplar yerel Code geçmişini paylaşır.",
                "Personal accounts share their local Code history.",
              )
            : t(
                "Boş bırakırsan bu şirket hesabı ayrı tutulur.",
                "Leave blank to keep this work account separate.",
              ),
      };
  }
}
