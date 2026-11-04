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
        `Downloading Relay ${v}… ${Math.round((update.progress ?? 0) * 100)}%`,
      );
    case "installing":
      return t(
        `Relay ${v} kuruluyor; birazdan yeniden açılacak.`,
        `Installing Relay ${v}; it opens again in a moment.`,
      );
    case "manual":
      return t(`Relay ${v} çıktı.`, `Relay ${v} is out.`);
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
          "Relay disk görüntüsünden çalışıyor; önce Uygulamalar klasörüne taşı.",
          "Relay runs from the disk image; move it to Applications first.",
        );
      case "not-writable":
        return t(
          "Relay kendi klasörünü değiştiremiyor; sayfadan indirip kur.",
          "Relay cannot replace itself in its folder; download it from the page.",
        );
      case "not-appimage":
        return t(
          "Relay AppImage olarak çalışmıyor; sayfadan indirip kur.",
          "Relay is not running as an AppImage; download it from the page.",
        );
      default:
        return t(
          "Bu bilgisayar için otomatik güncelleme yok; sayfadan indirip kur.",
          "There is no automatic update for this computer; download it from the page.",
        );
    }
  if (update.status === "ready")
    return t(
      "Güncelle’ye basınca Relay kapanır, yeni sürüm birkaç saniyede açılır. Ayarların ve girişlerin kalır.",
      "Update quits Relay and opens the new version in a few seconds. Your settings and sign-ins stay.",
    );
  return "";
}
