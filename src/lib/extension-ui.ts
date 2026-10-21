import {
  BROWSERS,
  EXTENSION_MODES,
  type ExtensionInstance,
  type ExtensionMode,
  type ExtensionStatus,
  type ExtensionTarget,
} from "../../shared/browser-extension";
import type { Account } from "../../shared/types";

type T = (tr: string, en: string) => string;

/** "Brave · Default": a browser's name and a profile's. Neither ever takes a suffix. */
export const instanceLabel = (i: ExtensionTarget & { name?: string }) =>
  `${BROWSERS[i.app].name} · ${i.name ?? i.profile}`;
/** An instance as a picker value; a folder never holds ":". */
export const instanceValue = (i: ExtensionTarget) => `${i.app}:${i.profile}`;

export function modeOptions(t: T): { value: ExtensionMode; label: string }[] {
  const labels: Record<ExtensionMode, string> = {
    restart: t("Tarayıcıyı kapatıp yeniden aç", "Quit and reopen the browser"),
    closed: t("Yalnızca tarayıcı kapalıysa", "Only when the browser is closed"),
    off: t("Kapalı", "Off"),
  };
  return EXTENSION_MODES.map((value) => ({ value, label: labels[value] }));
}

/** The sentence under the mode picker: what Relay does at a switch in that mode. */
export function modeSentence(mode: ExtensionMode, t: T): string {
  switch (mode) {
    case "restart":
      return t(
        "Relay her geçişte eklentinin girişini kaydeder ve yeni hesabınkini yerine koyar. Açık bir tarayıcıyı kısa süreliğine kapatıp sekmeleriyle yeniden açar.",
        "Relay saves the extension's sign-in and puts the new account's in place on every switch. A running browser is closed for a moment and opened again with its tabs.",
      );
    case "closed":
      return t(
        "Relay eklentinin girişini yalnızca tarayıcı kapalıyken değiştirir. Eklentinin hesabı izlemesini istiyorsan geçişten önce tarayıcıyı kapat.",
        "Relay changes the extension's sign-in only when the browser is closed. Close it before a switch if you want it to follow.",
      );
    case "off":
      return t("Relay eklentiye hiç dokunmaz.", "Relay never touches the extension.");
  }
}

/** What the card says about the instance Relay manages, or why it manages none. */
export function instanceLine(status: ExtensionStatus, t: T): string {
  if (!status.instances.length)
    return t(
      "Bu bilgisayarda Claude eklentisi bulunamadı (Chrome, Brave, Edge, Chromium, Vivaldi).",
      "No Claude extension found on this Mac (Chrome, Brave, Edge, Chromium, Vivaldi).",
    );
  if (!status.target)
    return t(
      "Claude eklentisi birden çok tarayıcı profilinde var. Birini seç.",
      "The Claude extension is in several browser profiles. Choose one.",
    );
  return t(
    `${instanceLabel(status.target)} · eklenti yüklü`,
    `${instanceLabel(status.target)} · extension installed`,
  );
}

/** The browser's own startup setting, and that Relay restores the session itself. */
export function startupLine(status: ExtensionStatus, t: T): string | undefined {
  if (!status.target || status.restoresTabs === undefined) return undefined;
  const name = BROWSERS[status.target.app].name;
  return status.restoresTabs
    ? t(
        `${name} kendi ayarında önceki oturumu açıyor; Relay de oturumu kendisi geri yükler.`,
        `${name} opens the last session by its own setting, and Relay restores the session itself too.`,
      )
    : t(
        `${name} kendi ayarında yeni sekme sayfasını açıyor; sekmelerin geri gelmesi için Relay oturumu kendisi geri yükler. Gizli sekmeler geri gelmez.`,
        `${name} opens the new tab page by its own setting, so Relay restores the session itself to bring the tabs back. Private tabs do not come back.`,
      );
}

/** The instance a picker value names, among those found. */
export function instanceFromValue(
  instances: ExtensionInstance[],
  value: string,
): ExtensionInstance | undefined {
  return instances.find((i) => instanceValue(i) === value);
}

const lower = (value: string | undefined) => value?.toLowerCase();

/** The account's row in the sheet: whether its extension sign-in is saved, and why not. */
export function rowStatus(
  account: Account,
  status: ExtensionStatus | undefined,
  t: T,
  language: "tr" | "en",
): { tone: "ok" | "warn" | "off"; label: string } {
  if (!status) return { tone: "off", label: "…" };
  if (status.setting.mode === "off")
    return {
      tone: "off",
      label: t("Kapalı · Relay eklentiye dokunmaz.", "Off · Relay does not touch the extension."),
    };
  if (!status.instances.length)
    return {
      tone: "off",
      label: t(
        "Bu bilgisayarda Claude eklentisi bulunamadı.",
        "No Claude extension found on this Mac.",
      ),
    };
  const uuids = [account.desktop?.accountUuid, account.auth?.accountUuid].map(lower);
  const saved = status.saved.find((s) => uuids.includes(s.accountUuid));
  if (!saved)
    return {
      tone: "warn",
      label: t(
        "Henüz kayıtlı değil. Eklentiye bu hesapla bir kez giriş yap; Relay bir sonraki geçişte kaydeder.",
        "Not saved yet. Sign in to the extension once with this account; Relay saves it at the next switch.",
      ),
    };
  const date = new Date(saved.savedAt).toLocaleDateString(
    language === "tr" ? "tr-TR" : "en-GB",
    { day: "numeric", month: "short" },
  );
  return {
    tone: "ok",
    label: t(`Giriş kayıtlı · ${date}`, `Sign-in saved · ${date}`),
  };
}
