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

/** The account's uuids (Desktop's and its own), lower case. */
export const accountUuids = (account: Account) =>
  [account.desktop?.accountUuid, account.auth?.accountUuid]
    .map(lower)
    .filter((value): value is string => !!value);

/**
 * Where an account stands with the browser extension, and what to do next. `steps` is the
 * sign-in to make in the browser, `check` that Relay should look again after it, `settings`
 * that the fix is on the Switching page.
 */
export interface ExtensionGuide {
  tone: "ok" | "warn" | "crit" | "off";
  label: string;
  detail?: string;
  steps?: string[];
  action?: "check" | "settings";
  /** The browser profile Relay manages, for the line under the status. */
  where?: string;
}

export function extensionGuide(
  account: Account,
  status: ExtensionStatus | undefined,
  accounts: Account[],
  t: T,
  language: "tr" | "en",
): ExtensionGuide {
  if (!status) return { tone: "off", label: t("Kontrol ediliyor…", "Checking…") };
  if (status.setting.mode === "off")
    return {
      tone: "off",
      label: t("Kapalı · Relay eklentiye dokunmaz.", "Off · Relay does not touch the extension."),
      action: "settings",
    };
  if (!status.instances.length)
    return {
      tone: "off",
      label: t(
        "Bu Mac'te Claude eklentisi bulunamadı.",
        "No Claude extension found on this Mac.",
      ),
      detail: t(
        "Chrome, Brave, Edge, Chromium ve Vivaldi'ye bakıldı.",
        "Looked in Chrome, Brave, Edge, Chromium and Vivaldi.",
      ),
    };
  if (!status.target)
    return {
      tone: "warn",
      label: t(
        "Eklenti birden çok tarayıcıda var; hangisini izleyeceğimi seç.",
        "The extension is in several browsers; choose the one to follow.",
      ),
      action: "settings",
    };
  const where =
    instanceLabel(status.target) +
    (status.picked === "recent" ? t(" (en son kullanılan)", " (used last)") : "");
  const uuids = accountUuids(account);
  const saved = status.saved.find((s) => uuids.includes(s.accountUuid));
  const current = status.current;
  const here = current?.state === "signed-in" && uuids.includes(current.accountUuid);
  if (saved || here) {
    const date = saved
      ? new Date(saved.savedAt).toLocaleDateString(language === "tr" ? "tr-TR" : "en-GB", {
          day: "numeric",
          month: "short",
        })
      : undefined;
    return {
      tone: "ok",
      label: here
        ? t("Bağlı · eklenti şu an bu hesapta", "Linked · the extension is on this account now")
        : t(`Bağlı · ${date} kaydedildi`, `Linked · saved ${date}`),
      detail: here
        ? undefined
        : t(
            "Bu hesaba geçince eklenti de bu hesaba döner.",
            "Switching to this account brings the extension along.",
          ),
      where,
    };
  }
  const email = account.desktop?.email ?? account.auth?.email;
  const signIn = email
    ? t(`${email} ile giriş yap.`, `Sign in with ${email}.`)
    : t("Bu hesapla giriş yap.", "Sign in with this account.");
  const check = t("“Kontrol et”e bas; Relay bağlar.", "Press “Check”; Relay links it.");
  if (!current)
    return { tone: "off", label: t("Kontrol ediliyor…", "Checking…"), where, action: "check" };
  if (current.state === "unreadable")
    return {
      tone: "crit",
      label: t("Eklentinin girişi okunamadı.", "Could not read the extension's sign-in."),
      detail: t(
        "Birkaç saniye sonra tekrar dene. Sürerse eklentinin yeni bir sürümü olabilir.",
        "Try again in a few seconds. If it persists, the extension may have changed.",
      ),
      where,
      action: "check",
    };
  if (current.state === "signed-out")
    return {
      tone: "warn",
      label: t("Bağlı değil · eklentide giriş yok", "Not linked · the extension is signed out"),
      steps: [
        t("Tarayıcıda Claude eklentisini aç.", "Open the Claude extension in the browser."),
        signIn,
        check,
      ],
      detail: t(
        "Giriş yaptığın hâlde bu yazı kalıyorsa Relay eklentinin girişini tanıyamıyor demektir.",
        "If this stays after you signed in, Relay cannot recognise the extension's sign-in.",
      ),
      where,
      action: "check",
    };
  const on = current.accountUuid;
  const other = accounts.find((a) => accountUuids(a).includes(on));
  return {
    tone: "warn",
    label: other
      ? t(
          `Bağlı değil · eklenti şu an ${other.name} hesabında`,
          `Not linked · the extension is on ${other.name} now`,
        )
      : t(
          "Bağlı değil · eklenti Relay'de olmayan bir hesapta",
          "Not linked · the extension is on an account Relay does not have",
        ),
    steps: [
      t(
        "Tarayıcıda Claude eklentisini aç ve çıkış yap.",
        "Open the Claude extension in the browser and sign out.",
      ),
      signIn,
      check,
    ],
    detail: other
      ? t(
          `${other.name} için kayıt Relay'de duruyor; ona geçince eklenti geri döner.`,
          `${other.name}'s sign-in stays saved in Relay; switching to it brings the extension back.`,
        )
      : undefined,
    where,
    action: "check",
  };
}
