import {
  BROWSERS,
  type AccountBrowser,
  type BrowserApp,
  type BrowserOpenResult,
  type InstalledBrowser,
} from "../../../shared/browser-profiles";
import type { Account } from "../../../shared/types";

type T = (tr: string, en: string) => string;

/** "Brave · Work": a browser's name and a profile's. Neither ever takes a suffix. */
export const browserLabel = (app: BrowserApp, name: string) =>
  `${BROWSERS[app].name} · ${name}`;
/** A profile as a picker value; a folder never holds ":". */
export const browserValue = (b: { app: BrowserApp; profile: string }) =>
  `${b.app}:${b.profile}`;

export interface BrowserOption {
  value: string;
  app: BrowserApp;
  profile: string;
  label: string;
  /** Another account uses it: one extension signs in to one account. */
  disabled: boolean;
}

/** Every listed profile, marked when it lacks the extension or another account uses it. */
export function browserOptions(
  account: Account,
  accounts: Account[],
  browsers: InstalledBrowser[],
  t: T,
): BrowserOption[] {
  return browsers.flatMap((b) =>
    b.profiles.map((p) => {
      const user = accounts.find(
        (a) =>
          a.id !== account.id &&
          a.browser?.app === b.app &&
          a.browser.profile === p.profile,
      );
      return {
        value: browserValue({ app: b.app, profile: p.profile }),
        app: b.app,
        profile: p.profile,
        label: [
          browserLabel(b.app, p.name),
          !p.extension && t("eklenti yok", "no extension"),
          user && t(`${user.name} kullanıyor`, `used by ${user.name}`),
        ]
          .filter(Boolean)
          .join(" · "),
        disabled: !!user,
      };
    }),
  );
}

/** The account's profile as the browser lists it now; undefined until listed or when gone. */
function listed(
  choice: AccountBrowser,
  browsers: InstalledBrowser[] | undefined,
) {
  return browsers
    ?.find((b) => b.app === choice.app)
    ?.profiles.find((p) => p.profile === choice.profile);
}

/** The account's chosen profile, named as the browser names it now. */
export function chosenLabel(
  account: Account,
  browsers: InstalledBrowser[] | undefined,
): string | undefined {
  const choice = account.browser;
  return (
    choice &&
    browserLabel(choice.app, listed(choice, browsers)?.name ?? choice.name)
  );
}

/** The row's status. `browsers` is undefined until they are listed. */
export function browserStatus(
  account: Account,
  browsers: InstalledBrowser[] | undefined,
  t: T,
): { tone: "ok" | "warn" | "off"; label: string } {
  const choice = account.browser;
  if (!choice)
    return {
      tone: "off",
      label: t(
        "Seçilmedi · geçişten sonra tarayıcıda bir şey açılmaz.",
        "Not set · nothing opens in the browser after a switch.",
      ),
    };
  const label = chosenLabel(account, browsers)!;
  const found = listed(choice, browsers);
  if (browsers && !found)
    return {
      tone: "warn",
      label: t(
        `Bu profil artık tarayıcıda yok: ${label}.`,
        `The browser no longer has this profile: ${label}.`,
      ),
    };
  if (found && !found.extension)
    return {
      tone: "warn",
      label: t(
        `${label} · bu profilde Claude eklentisi yüklü değil.`,
        `${label} · the Claude extension is not installed in this profile.`,
      ),
    };
  return {
    tone: "ok",
    label: t(
      `${label} · geçişten sonra kapalıysa açılır.`,
      `${label} · opened after a switch if it is closed.`,
    ),
  };
}

/** What "Open now" did. */
export function openResultText(
  result: BrowserOpenResult | "none",
  label: string,
  t: T,
): string | undefined {
  switch (result) {
    case "opened":
      return t(
        `Tarayıcı profili açıldı: ${label}.`,
        `Opened the browser profile ${label}.`,
      );
    case "open":
      return t(
        `Bu profil zaten açık: ${label}.`,
        `This profile is already open: ${label}.`,
      );
    case "missing":
      return t(
        `Bu profil artık tarayıcıda yok: ${label}.`,
        `The browser no longer has this profile: ${label}.`,
      );
    case "failed":
      return t(
        `Tarayıcı profili açılamadı: ${label}.`,
        `Could not open the browser profile ${label}.`,
      );
    case "none":
      return undefined;
  }
}
