import {
  BROWSERS,
  browserApps,
  type BrowserApp,
  type ExtensionInstance,
  type ExtensionMode,
  type ExtensionStatus,
  type ExtensionTarget,
} from "../../shared/browser-extension";
import type { Account } from "../../shared/types";
import { FORMAT_LOCALE, type Locale } from "../../shared/i18n/locales";
import type { T } from "../../shared/i18n/translate";
import { nameList } from "./proxy-ui";


/** The browsers Relay looks in, by name: "Chrome, Brave, … and Comet". */
const browserList = (apps: readonly BrowserApp[], t: T) => nameList(apps.map((app) => BROWSERS[app].name), t);

/** "Brave · Default": a browser's name and a profile's. Neither ever takes a suffix. */
export const instanceLabel = (i: ExtensionTarget & { name?: string }) =>
  `${BROWSERS[i.app].name} · ${i.name ?? i.profile}`;
/** An instance as a picker value; a folder never holds ":". */
export const instanceValue = (i: ExtensionTarget) => `${i.app}:${i.profile}`;

export function modeOptions(t: T): { value: ExtensionMode; label: string }[] {
  const labels: Record<ExtensionMode, string> = {
    off: t("extensionUi.doNotChange"),
    guide: t("extensionUi.onlyTellMe"),
    closed: t("extensionUi.ifTheBrowserIsClosed"),
    restart: t("extensionUi.quitAndReopenTheBrowser"),
  };
  // From the least to the most Relay does.
  return (["off", "guide", "closed", "restart"] as const).map((value) => ({
    value,
    label: labels[value],
  }));
}

/**
 * The sentence under the mode picker: what Relay does at a switch in that mode. On Linux a quit
 * cannot be held up by the browser's own prompts, which "restart" says.
 */
export function modeSentence(mode: ExtensionMode, t: T, platform?: string): string {
  switch (mode) {
    case "restart":
      return platform === "linux"
        ? t("extensionUi.atEachSwitchRelayPutsInLinux")
        : t("extensionUi.atEachSwitchRelayPutsIn");
    case "closed":
      return t("extensionUi.relayChangesThemOnlyWhenThe");
    case "guide":
      return t("extensionUi.relayDoesNotChangeTheBrowser");
    case "off":
      return t("extensionUi.relayDoesNotChangeTheExtension");
  }
}

/** Why the extension cannot be found: macOS keeps these browsers' data from Relay. */
export function deniedLine(denied: BrowserApp[], t: T): string {
  const names = denied.map((app) => BROWSERS[app].name).join(", ");
  return t("extensionUi.macosDoesNotLetRelayRead", { names });
}

/** What the card says about the instance Relay manages, or why it manages none. */
export function instanceLine(status: ExtensionStatus, t: T, platform?: string): string {
  if (!status.instances.length && status.denied?.length)
    return deniedLine(status.denied, t);
  if (!status.instances.length) {
    const browsers = browserList(browserApps(platform), t);
    return platform === "linux"
      ? t("extensionUi.noClaudeExtensionFoundOnThisComputerIn", { browsers })
      : t("extensionUi.noClaudeExtensionFoundOnThisMacIn", { browsers });
  }
  if (!status.target)
    return t("extensionUi.theClaudeExtensionIsInSeveral");
  return t("extensionUi.extensionInstalled", { instanceLabel: instanceLabel(status.target) });
}

/** The browser's own startup setting, and that Relay restores the session itself. */
export function startupLine(status: ExtensionStatus, t: T): string | undefined {
  if (!status.target || status.restoresTabs === undefined) return undefined;
  const name = BROWSERS[status.target.app].name;
  return status.restoresTabs
    ? t("extensionUi.opensTheLastTabsAgainAnd", { name })
    : t("extensionUi.opensANewTabPageSo", { name });
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
    title: t("extensionUi.reconnectTheExtensionTo", { accountName: account.name }),
    why: broken
      ? t("extensionUi.theExtensionCannotSignInWith", { accountName: account.name })
      : t("extensionUi.theExtensionIsOnButIts", { accountName: account.name }),
    steps: [
      // Never "log out": claude.ai's log out ends that login on the server, and Relay keeps a
      // copy of it for the other account; deleting the site's data only forgets it here.
      t("extensionUi.openClaudeAiInIfIt", { browser, accountName: account.name, as }),
      t("extensionUi.clickTheClaudeIconInThe", { browser }),
      t("extensionUi.relayFindsTheConnectionAndSaves"),
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
  language: Locale,
  /** The account the Claude app is on (its uuid), for the reconnect guide. */
  desktopUuid?: string,
  /** Relay's platform (`diagnostics.platform`): which browsers were looked in, and "Mac" or not. */
  platform?: string,
): ExtensionGuide {
  if (!status) return { tone: "off", label: t("common.checkInProgress") };
  if (status.setting.mode === "off")
    return {
      tone: "off",
      label: t("common.off"),
      detail: t("extensionUi.relayDoesNotChangeTheExtension"),
      action: "settings",
    };
  if (!status.instances.length && status.denied?.length)
    return {
      tone: "warn",
      label: t("extensionUi.macosBlocksAccess"),
      detail: deniedLine(status.denied, t),
      action: "settings",
    };
  if (!status.instances.length) {
    return {
      tone: "off",
      label:
        platform === "linux"
          ? t("extensionUi.noClaudeExtensionFoundOnThis")
          : t("extensionUi.noClaudeExtensionFoundOnThis2"),
      detail: t("extensionUi.lookedIn", { browsers: browserList(browserApps(platform), t) }),
    };
  }
  if (!status.target)
    return {
      tone: "warn",
      label: t("extensionUi.inSeveralBrowsersSelectOne"),
      action: "settings",
    };
  const where =
    status.picked === "recent"
      ? t("extensionUi.usedLast", { instance: instanceLabel(status.target) })
      : instanceLabel(status.target);
  const uuids = accountUuids(account);
  const saved = status.saved.find((s) => uuids.includes(s.accountUuid));
  const current = status.current;
  const here =
    current?.state === "signed-in" && !!current.accountUuid && uuids.includes(current.accountUuid);
  const reconnect = reconnectGuide(status, accounts, t, desktopUuid);
  if (reconnect && reconnect.account.id === account.id)
    return {
      tone: "crit",
      label: t("extensionUi.reconnectNeeded"),
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
      label: t("extensionUi.halfLinkedNoClaudeAiLogin"),
      detail: t("extensionUi.relaySavedTheExtensionSSign"),
      action: "check",
      where,
    };
  if (saved || here) {
    const date = saved
      ? new Date(saved.savedAt).toLocaleDateString(FORMAT_LOCALE[language], {
          day: "numeric",
          month: "short",
        })
      : undefined;
    return {
      tone: "ok",
      label: here ? t("extensionUi.linkedOnThisAccountNow") : t("extensionUi.linked"),
      detail: here
        ? undefined
        : t("extensionUi.savedTheExtensionFollowsWhenYou", { date }),
      where,
    };
  }
  // Relay keeps the extension's sign-in by account uuid; an account without one cannot be linked.
  if (!uuids.length)
    return {
      tone: "warn",
      label: t("extensionUi.saveTheClaudeAppSignIn"),
      detail: t("extensionUi.relayGetsTheAccountIdFrom"),
      where,
    };
  const email = account.desktop?.email ?? account.auth?.email;
  const signIn = email
    ? t("extensionUi.signInWith", { email })
    : t("extensionUi.signInWithThisAccount");
  const check = t("extensionUi.selectCheck");
  if (!current)
    return { tone: "off", label: t("common.checkInProgress"), where, action: "check" };
  if (current.state === "unreadable")
    return {
      tone: "crit",
      label: t("extensionUi.relayCannotReadTheExtensionSign"),
      detail: t("extensionUi.tryAgainInAFewSeconds"),
      where,
      action: "check",
    };
  if (current.state === "signed-out" && current.unopened)
    return {
      tone: "warn",
      label: t("extensionUi.theExtensionWasNeverOpened"),
      steps: [
        t("extensionUi.openTheExtensionInTheBrowser"),
        signIn,
        check,
      ],
      where,
      action: "check",
    };
  if (current.state === "signed-out")
    return {
      tone: "warn",
      label: t("extensionUi.theExtensionIsSignedOut"),
      steps: [
        t("extensionUi.openTheClaudeExtensionInThe"),
        signIn,
        check,
      ],
      detail: t("extensionUi.ifThisStaysAfterYouSign"),
      where,
      action: "check",
    };
  const on = current.accountUuid;
  const other = on ? accounts.find((a) => accountUuids(a).includes(on)) : undefined;
  // Signed in, but the extension's data names none of Relay's accounts: the user can say which.
  if (!other && !current.other)
    return {
      tone: "warn",
      label: t("extensionUi.relayCannotIdentifyTheExtensionAccount"),
      steps: [
        email
          ? t("extensionUi.makeSureTheExtensionIsSigned", { email })
          : t("extensionUi.makeSureTheExtensionIsSigned2"),
        t("extensionUi.selectLinkAsThisAccount"),
      ],
      detail: t("extensionUi.relayCannotReadTheAccountFrom"),
      where,
      action: "claim",
    };
  return {
    tone: "warn",
    label: other
      ? t("extensionUi.theExtensionIsOn", { otherName: other.name })
      : t("extensionUi.theExtensionIsOnAnotherClaude"),
    steps: [
      t("extensionUi.signOutInTheExtension"),
      signIn,
      check,
    ],
    detail: other
      ? t("extensionUi.relayKeepsTheSignInOf", { otherName: other.name })
      : t("extensionUi.theClaudeAiAccountInThe"),
    where,
    action: "check",
  };
}
