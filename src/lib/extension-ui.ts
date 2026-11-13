import {
  BROWSERS,
  browserNames,
  type BrowserApp,
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
    off: t("Dokunma", "Do not change"),
    guide: t("Sadece haber ver", "Only tell me"),
    closed: t("Tarayıcı kapalıysa", "If the browser is closed"),
    restart: t("Tarayıcıyı kapatıp aç", "Quit and reopen the browser"),
  };
  // From the least to the most Relay does.
  return (["off", "guide", "closed", "restart"] as const).map((value) => ({
    value,
    label: labels[value],
  }));
}

/** The sentence under the mode picker: what Relay does at a switch in that mode. */
export function modeSentence(mode: ExtensionMode, t: T): string {
  const web = t(
    "Relay bu profildeki claude.ai oturumunu da değiştirir; claude.ai sekmeleri yeni hesapta açılır. Gündelik claude.ai hesabını korumak için eklentiyi ayrı bir tarayıcı profilinde kullan.",
    "Relay also changes the claude.ai login in this browser profile, so claude.ai tabs open on the new account. To keep your everyday claude.ai account, use the extension in a separate browser profile.",
  );
  switch (mode) {
    case "restart":
      return `${t(
        "Relay her geçişte eklenti girişini ve claude.ai oturumunu yeni hesabınkiyle değiştirir. Açık tarayıcı kısa süre kapanıp sekmeleriyle yeniden açılır.",
        "At each switch, Relay puts in the extension sign-in and claude.ai login of the new account. An open browser closes for a moment and opens again with its tabs.",
      )} ${web}`;
    case "closed":
      return `${t(
        "Relay bunları yalnızca tarayıcı kapalıyken değiştirir. Eklentinin de aynı hesaba geçmesini istiyorsan geçişten önce tarayıcıyı kapat.",
        "Relay changes them only when the browser is closed. For the extension to follow, close the browser before a switch.",
      )} ${web}`;
    case "guide":
      return t(
        "Geçişte Relay tarayıcıda ve eklentide hiçbir şeyi değiştirmez. Eklenti başka bir hesapta kalırsa menü çubuğu panelinde “Geçir” çıkar.",
        "Relay does not change the browser or the extension at a switch. If the extension stays on another account, the menu bar panel shows “Switch”.",
      );
    case "off":
      return t("Relay eklentiye dokunmaz.", "Relay does not change the extension.");
  }
}

/** Why the extension cannot be found: macOS keeps these browsers' data from Relay. */
export function deniedLine(denied: BrowserApp[], t: T): string {
  const names = denied.map((app) => BROWSERS[app].name).join(", ");
  return t(
    `macOS, Relay’in ${names} verilerini okumasına izin vermiyor. Sistem Ayarları › Gizlilik ve Güvenlik › Tam Disk Erişimi’nde Relay’i aç, sonra Relay’i yeniden başlat.`,
    `macOS does not let Relay read the data of ${names}. Turn on Relay in System Settings › Privacy & Security › Full Disk Access, then restart Relay.`,
  );
}

/** What the card says about the instance Relay manages, or why it manages none. */
export function instanceLine(status: ExtensionStatus, t: T): string {
  if (!status.instances.length && status.denied?.length)
    return deniedLine(status.denied, t);
  if (!status.instances.length)
    return t(
      `Bu bilgisayarda Claude eklentisi bulunamadı (${browserNames("ve")}).`,
      `No Claude extension found on this Mac (${browserNames("and")}).`,
    );
  if (!status.target)
    return t(
      "Claude eklentisi birden çok tarayıcı profilinde var. Birini seç.",
      "The Claude extension is in several browser profiles. Select one.",
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
        `${name} önceki sekmeleri yeniden açar; Relay de geri yükler.`,
        `${name} opens the last tabs again, and Relay also restores them.`,
      )
    : t(
        `${name} yeni sekme sayfasıyla açılır; Relay sekmeleri kendisi geri yükler. Gizli sekmeler geri gelmez.`,
        `${name} opens a new tab page, so Relay restores the tabs. Private tabs do not come back.`,
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
 * The accounts that have a complete pair saved (the extension's hints and the browser profile's
 * claude.ai login), by name, and those that have only one half. Only a complete pair can be put
 * in place by the modes that write to the browser.
 */
export function pairedAccounts(
  status: ExtensionStatus,
  accounts: Account[],
): { paired: string[]; half: string[] } {
  const hints = new Set(status.saved.map((x) => x.accountUuid.toLowerCase()));
  const logins = new Set((status.cookiesSaved ?? []).map((x) => x.accountUuid.toLowerCase()));
  const paired: string[] = [];
  const half: string[] = [];
  for (const account of accounts) {
    const uuids = accountUuids(account);
    const h = uuids.some((u) => hints.has(u));
    const l = uuids.some((u) => logins.has(u));
    if (h && l) paired.push(account.name);
    else if (h || l) half.push(account.name);
  }
  return { paired, half };
}

/**
 * What reconnecting the extension to an account takes, when its sign-in there failed: the
 * extension is on the account but recorded that its sign-in expired, or Relay saw it fail with the
 * claude.ai login a step put in place (`broken`) and forgot that login. Undefined otherwise. The
 * extension signs in through the browser's claude.ai login, so that login comes first.
 */
export interface ReconnectGuide {
  account: Account;
  title: string;
  why: string;
  steps: string[];
  /** A claude.ai login of the account is saved: syncing may be enough, before the steps. */
  canSync: boolean;
}

export function reconnectGuide(
  status: ExtensionStatus | undefined,
  accounts: Account[],
  t: T,
  /** The account the Claude app is on (its uuid): the extension should end up there. */
  desktopUuid?: string,
): ReconnectGuide | undefined {
  if (!status?.target || status.setting.mode === "off") return undefined;
  const current = status.current;
  const byUuid = (uuid: string) => accounts.find((a) => accountUuids(a).includes(uuid));
  const expiredOn =
    current?.state === "signed-in" && current.expired && current.accountUuid
      ? byUuid(current.accountUuid)
      : undefined;
  const brokenOn = status.broken ? byUuid(status.broken.accountUuid) : undefined;
  const onDesktop = desktopUuid ? byUuid(desktopUuid.toLowerCase()) : undefined;
  // The Claude app's account comes first: the next switch puts the extension there anyway, so
  // reconnecting it to an account the app has left only sets up another expiry (seen
  // 2026-11-13, when the guide named the extension's account while the app was on another).
  const account =
    brokenOn && onDesktop && brokenOn.id === onDesktop.id
      ? brokenOn
      : expiredOn && onDesktop && expiredOn.id !== onDesktop.id && (brokenOn?.id === onDesktop.id || !brokenOn)
        ? onDesktop
        : (expiredOn ?? brokenOn);
  if (!account) return undefined;
  // Once the extension is on this account again without a failure, nothing is left to do.
  if (
    !expiredOn &&
    current?.state === "signed-in" &&
    current.accountUuid &&
    accountUuids(account).includes(current.accountUuid)
  )
    return undefined;
  const uuids = accountUuids(account);
  const broken = !!brokenOn && brokenOn.id === account.id;
  const browser = BROWSERS[status.target.app].name;
  const email = account.desktop?.email ?? account.auth?.email;
  const as = email ?? account.name;
  return {
    account,
    title: t(
      `Eklentiyi ${account.name} hesabına yeniden bağla`,
      `Reconnect the extension to ${account.name}`,
    ),
    why: broken
      ? t(
          `Eklenti, ${account.name} için kayıtlı claude.ai oturumuyla giriş yapamadı; oturum başka bir hesabın ya da süresi dolmuş. Relay onu sildi. Claude’un tarayıcı araçları sen yeniden bağlayana kadar çalışmaz.`,
          `The extension cannot sign in with the saved claude.ai login of ${account.name}. The login is for another account, or it expired. Relay removed it. Claude’s browser tools do not work until you reconnect.`,
        )
      : t(
          `Eklenti ${account.name} hesabında ama girişi düşmüş; Claude’un tarayıcı araçları çalışmaz.`,
          `The extension is on ${account.name}, but its sign-in expired. Claude’s browser tools do not work.`,
        ),
    steps: [
      // Never "log out": claude.ai's log out ends that login on the server, and Relay keeps a
      // copy of it for the other account; deleting the site's data only forgets it here.
      t(
        `${browser}’da claude.ai’yi aç. Açılan hesap ${account.name} değilse çıkış yapma (çıkış, Relay’in diğer hesap için sakladığı girişi de bitirir): adres çubuğundaki site simgesinden claude.ai’nin site verilerini sil, sayfayı yenile, ${as} ile giriş yap.`,
        `Open claude.ai in ${browser}. If it is not on ${account.name}, do not log out (that also ends the login Relay keeps for the other account): delete claude.ai’s site data from the site icon in the address bar, reload, and log in with ${as}.`,
      ),
      t(
        `${browser}’ın araç çubuğundaki Claude simgesine tıkla, “Log in”e bas.`,
        `Click the Claude icon in the ${browser} toolbar. Then click “Log in”.`,
      ),
      t(
        "Relay bağlantıyı kendisi görür ve girişi saklar.",
        "Relay finds the connection and saves the sign-in.",
      ),
    ],
    canSync:
      !broken && !!status.cookiesSaved?.some((s) => uuids.includes(s.accountUuid)),
  };
}

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
  action?: "check" | "settings" | "claim";
  /** The browser profile Relay manages, shown muted beside the status. */
  where?: string;
}

export function extensionGuide(
  account: Account,
  status: ExtensionStatus | undefined,
  accounts: Account[],
  t: T,
  language: "tr" | "en",
  /** The account the Claude app is on (its uuid), for the reconnect guide. */
  desktopUuid?: string,
): ExtensionGuide {
  if (!status) return { tone: "off", label: t("Kontrol ediliyor…", "Check in progress…") };
  if (status.setting.mode === "off")
    return {
      tone: "off",
      label: t("Kapalı", "Off"),
      detail: t("Relay eklentiye dokunmaz.", "Relay does not change the extension."),
      action: "settings",
    };
  if (!status.instances.length && status.denied?.length)
    return {
      tone: "warn",
      label: t("macOS erişime izin vermiyor", "macOS blocks access"),
      detail: deniedLine(status.denied, t),
      action: "settings",
    };
  if (!status.instances.length)
    return {
      tone: "off",
      label: t(
        "Bu Mac’te Claude eklentisi bulunamadı.",
        "No Claude extension found on this Mac.",
      ),
      detail: t(`Bakılan tarayıcılar: ${browserNames("ve")}.`, `Looked in ${browserNames("and")}.`),
    };
  if (!status.target)
    return {
      tone: "warn",
      label: t("Birden çok tarayıcıda var, birini seç", "In several browsers. Select one"),
      action: "settings",
    };
  const where =
    instanceLabel(status.target) +
    (status.picked === "recent" ? t(" (en son kullanılan)", " (used last)") : "");
  const uuids = accountUuids(account);
  const saved = status.saved.find((s) => uuids.includes(s.accountUuid));
  const current = status.current;
  const here =
    current?.state === "signed-in" && !!current.accountUuid && uuids.includes(current.accountUuid);
  const reconnect = reconnectGuide(status, accounts, t, desktopUuid);
  if (reconnect && reconnect.account.id === account.id)
    return {
      tone: "crit",
      label: t("Yeniden bağlanmalı", "Reconnect needed"),
      detail: reconnect.why,
      steps: reconnect.steps,
      where,
      action: "settings",
    };
  // A switch puts back both halves, the extension's sign-in and the claude.ai login: with only
  // the first saved it would change nothing, so the account is not linked yet.
  const loginSaved = !!status.cookiesSaved?.some((s) => uuids.includes(s.accountUuid));
  if (saved && !loginSaved && !here)
    return {
      tone: "warn",
      label: t("Yarım bağlı: claude.ai girişi kayıtlı değil", "Half linked: no claude.ai login saved"),
      detail: t(
        "Relay eklentinin girişini sakladı ama bu hesabın claude.ai girişini saklamadı; bu hesaba geçişte eklenti yerinde kalır. Tarayıcıda claude.ai’ye ve eklentiye bu hesapla giriş yapıp “Kontrol et”e bas.",
        "Relay saved the extension’s sign-in but not this account’s claude.ai login, so a switch to this account leaves the extension where it is. Sign in to claude.ai and the extension with this account in the browser, then select “Check”.",
      ),
      action: "check",
      where,
    };
  if (saved || here) {
    const date = saved
      ? new Date(saved.savedAt).toLocaleDateString(language === "tr" ? "tr-TR" : "en-GB", {
          day: "numeric",
          month: "short",
        })
      : undefined;
    return {
      tone: "ok",
      label: here ? t("Bağlı, şu an bu hesapta", "Linked, on this account now") : t("Bağlı", "Linked"),
      detail: here
        ? undefined
        : t(
            `Kayıt: ${date}. Bu hesaba geçince eklenti de bu hesaba geçer.`,
            `Saved ${date}. The extension follows when you switch to this account.`,
          ),
      where,
    };
  }
  // Relay keeps the extension's sign-in by account uuid; an account without one cannot be linked.
  if (!uuids.length)
    return {
      tone: "warn",
      label: t("Önce Claude uygulaması girişini kaydet", "Save the Claude app sign-in first"),
      detail: t(
        "Relay hesabın kimliğini Claude uygulaması girişinden öğrenir. Sonra eklentiye bu hesapla giriş yapıp “Kontrol et”e bas.",
        "Relay gets the account ID from the Claude app sign-in. Then sign in to the extension with this account and select “Check”.",
      ),
      where,
    };
  const email = account.desktop?.email ?? account.auth?.email;
  const signIn = email
    ? t(`${email} ile giriş yap.`, `Sign in with ${email}.`)
    : t("Bu hesapla giriş yap.", "Sign in with this account.");
  const check = t("“Kontrol et”e bas.", "Select “Check”.");
  if (!current)
    return { tone: "off", label: t("Kontrol ediliyor…", "Check in progress…"), where, action: "check" };
  if (current.state === "unreadable")
    return {
      tone: "crit",
      label: t("Eklentinin girişi okunamadı.", "Relay cannot read the extension sign-in."),
      detail: t(
        "Birkaç saniye sonra tekrar dene. Sürerse eklentinin yeni bir sürümü olabilir.",
        "Try again in a few seconds. If the problem continues, a new extension version can be the cause.",
      ),
      where,
      action: "check",
    };
  if (current.state === "signed-out" && current.unopened)
    return {
      tone: "warn",
      label: t("Eklenti hiç açılmamış", "The extension was never opened"),
      steps: [
        t("Eklentiyi tarayıcıda bir kez aç.", "Open the extension in the browser once."),
        signIn,
        check,
      ],
      where,
      action: "check",
    };
  if (current.state === "signed-out")
    return {
      tone: "warn",
      label: t("Eklentide giriş yok", "The extension is signed out"),
      steps: [
        t("Tarayıcıda Claude eklentisini aç.", "Open the Claude extension in the browser."),
        signIn,
        check,
      ],
      detail: t(
        "Giriş yaptığın hâlde bu yazı kalıyorsa Relay eklentinin girişini tanıyamıyor demektir.",
        "If this stays after you sign in, Relay cannot identify the extension sign-in.",
      ),
      where,
      action: "check",
    };
  const on = current.accountUuid;
  const other = on ? accounts.find((a) => accountUuids(a).includes(on)) : undefined;
  // Signed in, but the extension's data names none of Relay's accounts: the user can say which.
  if (!other && !current.other)
    return {
      tone: "warn",
      label: t("Eklentideki hesap tanınamadı", "Relay cannot identify the extension account"),
      steps: [
        email
          ? t(
              `Eklentide ${email} ile giriş yaptığından emin ol.`,
              `Make sure the extension is signed in with ${email}.`,
            )
          : t(
              "Eklentide bu hesapla giriş yaptığından emin ol.",
              "Make sure the extension is signed in with this account.",
            ),
        t("“Bu hesap olarak bağla”ya bas.", "Select “Link as this account”."),
      ],
      detail: t(
        "Relay eklentideki hesabı okuyamıyor; bir kez sen söyle. Sonra Relay bunu hatırlar.",
        "Relay cannot read the account from the extension, so tell it once. After that, Relay remembers it.",
      ),
      where,
      action: "claim",
    };
  return {
    tone: "warn",
    label: other
      ? t(`Eklenti ${other.name} hesabında`, `The extension is on ${other.name}`)
      : t("Eklenti başka bir claude.ai hesabında", "The extension is on another claude.ai account"),
    steps: [
      t("Eklentide çıkış yap.", "Sign out in the extension."),
      signIn,
      check,
    ],
    detail: other
      ? t(
          `${other.name} için kayıt Relay’de duruyor; o hesaba geçince eklenti de geri gelir.`,
          `Relay keeps the sign-in of ${other.name}. When you switch to it, the extension follows.`,
        )
      : t(
          "Eklentideki claude.ai hesabı Relay’deki hiçbir hesaba ait değil. Tarayıcıdaki claude.ai oturumunu kontrol et; eklenti onun hesabını kullanır.",
          "The claude.ai account in the extension is not in Relay. Check the claude.ai login in the browser. The extension uses that account.",
        ),
    where,
    action: "check",
  };
}
