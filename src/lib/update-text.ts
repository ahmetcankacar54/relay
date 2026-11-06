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
      return t(
        `Relay ${v} indiriliyor… %${Math.round((update.progress ?? 0) * 100)}`,
        `Relay ${v}: ${Math.round((update.progress ?? 0) * 100)}% downloaded`,
      );
    case "installing":
      return t(
        `Relay ${v} kuruluyor; birazdan yeniden açılır.`,
        `Relay ${v} install in progress. Relay opens again soon.`,
      );
    case "manual":
      return t(`Relay ${v} çıktı.`, `Relay ${v} is available.`);
    default:
      return t(`Relay ${v} hazır.`, `Relay ${v} is ready.`);
  }
}

/** What to know under the line: why it must be downloaded by hand, or what Update does. */
export function updateHint(update: UpdateState, t: T): string {
  if (update.status === "manual")
    switch (update.manualReason) {
      case "location":
        return t(
          "Relay disk görüntüsünden çalışıyor. Önce Uygulamalar klasörüne taşı.",
          "Relay runs from the disk image. Move it to Applications first.",
        );
      case "not-writable":
        return t(
          "Relay kendi klasörünü değiştiremiyor. Sayfadan indirip kur.",
          "Relay cannot replace its own files. Download the new version from the page.",
        );
      case "not-appimage":
        return t(
          "Relay AppImage olarak çalışmıyor. Sayfadan indirip kur.",
          "Relay does not run as an AppImage. Download the new version from the page.",
        );
      default:
        return t(
          "Bu bilgisayar için otomatik güncelleme yok. Sayfadan indirip kur.",
          "No automatic update for this computer. Download the new version from the page.",
        );
    }
  if (update.status === "ready")
    return t(
      "Güncelle’ye basınca Relay kapanır, yeni sürüm birkaç saniyede açılır.",
      "“Update” quits Relay and opens the new version in a few seconds.",
    );
  return "";
}
