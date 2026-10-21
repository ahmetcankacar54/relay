/** The Claude browser extension ("Claude in Chrome"). */
export const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
/** The Chromium browsers Relay can keep the extension's sign-in for, on macOS. */
export const BROWSER_APPS = [
  "chrome",
  "brave",
  "edge",
  "chromium",
  "vivaldi",
] as const;
export type BrowserApp = (typeof BROWSER_APPS)[number];
export const BROWSERS: Record<
  BrowserApp,
  {
    name: string;
    bundleId: string;
    /** The user data folder, under ~/Library/Application Support. */
    dataDir: string;
    /** The main process's file name in Contents/MacOS. */
    executable: string;
  }
> = {
  chrome: {
    name: "Chrome",
    bundleId: "com.google.Chrome",
    dataDir: "Google/Chrome",
    executable: "Google Chrome",
  },
  brave: {
    name: "Brave",
    bundleId: "com.brave.Browser",
    dataDir: "BraveSoftware/Brave-Browser",
    executable: "Brave Browser",
  },
  edge: {
    name: "Edge",
    bundleId: "com.microsoft.edgemac",
    dataDir: "Microsoft Edge",
    executable: "Microsoft Edge",
  },
  chromium: {
    name: "Chromium",
    bundleId: "org.chromium.Chromium",
    dataDir: "Chromium",
    executable: "Chromium",
  },
  vivaldi: {
    name: "Vivaldi",
    bundleId: "com.vivaldi.Vivaldi",
    dataDir: "Vivaldi",
    executable: "Vivaldi",
  },
};
/** A profile folder: "Default", "Profile 1" and the like. */
export const PROFILE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** Profiles the browser keeps for itself; never a user's. */
const HIDDEN_FOLDERS = new Set(["Guest Profile", "System Profile"]);

/**
 * What Relay does with the extension's sign-in at a switch. "restart": it saves and puts the
 * sign-in in place, closing a running browser for a moment and opening it again. "closed":
 * only when the browser is already closed. "off": never.
 */
export const EXTENSION_MODES = ["restart", "closed", "off"] as const;
export type ExtensionMode = (typeof EXTENSION_MODES)[number];
/** The browser profile whose extension Relay manages. */
export interface ExtensionTarget {
  app: BrowserApp;
  profile: string;
}
export interface ExtensionSetting {
  mode: ExtensionMode;
  /** Chosen when several browser profiles have the extension; the only one is used without. */
  browser?: ExtensionTarget;
}
export const DEFAULT_EXTENSION: ExtensionSetting = { mode: "restart" };

/** A browser profile that has the Claude extension's storage. */
export interface ExtensionInstance extends ExtensionTarget {
  name: string;
}
export type ExtensionResult =
  | "switched"
  | "saved"
  | "unchanged"
  | "skipped"
  | "failed";
export type ExtensionReason =
  | "off"
  | "not-installed"
  | "choose-instance"
  | "unavailable"
  | "browser-running"
  | "browser-did-not-quit"
  | "unknown-account"
  | "no-saved-login"
  | "already-there"
  | "locked"
  | "unreadable"
  | "write-failed"
  | "verify-failed"
  | "restore-failed";
/**
 * What the last extension step did. "switched": the target's sign-in was put in place.
 * "saved": the extension's was kept and the target has none saved. "unchanged": nothing to
 * change. "skipped": it did not run (see `reason`). "failed": it ran and failed.
 */
export interface ExtensionOutcome {
  result: ExtensionResult;
  reason?: ExtensionReason;
  at: string;
  /** Relay quit the browser for the step. */
  restarted: boolean;
  /** Relay opened it again; false when it quit it and could not. */
  reopened?: boolean;
  /** The extension's sign-in was sealed into the vault. */
  saved: boolean;
}
/** What the settings card and the account sheet show. */
export interface ExtensionStatus {
  setting: ExtensionSetting;
  instances: ExtensionInstance[];
  /** The instance Relay manages: the chosen one, or the only one. */
  target?: ExtensionInstance;
  /** The browser's own startup setting brings tabs back; Relay restores them either way. */
  restoresTabs?: boolean;
  /** Sealed sign-ins, by the extension's account uuid (lower case). */
  saved: { accountUuid: string; savedAt: string }[];
  last?: ExtensionOutcome;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The user's profiles in a browser's `Local State`, from `profile.info_cache`: folder and name,
 * in the browser's own order. Nothing else in the file is used.
 */
export function localStateProfiles(
  localState: unknown,
): { profile: string; name: string }[] {
  const profile = record(record(localState)?.profile);
  const cache = record(profile?.info_cache);
  if (!cache) return [];
  const order = Array.isArray(profile?.profiles_order)
    ? profile.profiles_order.filter((x): x is string => typeof x === "string")
    : [];
  const folders = [
    ...new Set([...order.filter((x) => x in cache), ...Object.keys(cache)]),
  ];
  return folders.flatMap((folder) => {
    const entry = record(cache[folder]);
    if (
      !entry ||
      !PROFILE_FOLDER.test(folder) ||
      HIDDEN_FOLDERS.has(folder) ||
      entry.is_guest === true ||
      entry.is_ephemeral === true ||
      entry.is_omitted_from_profile_list === true
    )
      return [];
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim().slice(0, 100)
        : folder;
    return [{ profile: folder, name }];
  });
}

/**
 * Whether a profile's `Preferences` make the browser open the last session again:
 * `session.restore_on_startup` 1 ("continue where you left off") or 5. Absent is the default,
 * the new tab page.
 */
export function startupRestores(preferences: unknown): boolean {
  const value = record(record(preferences)?.session)?.restore_on_startup;
  return value === 1 || value === 5;
}

/** The instance Relay manages: the chosen one when it is found, else the only one found. */
export function chooseInstance(
  instances: ExtensionInstance[],
  chosen: ExtensionTarget | undefined,
): ExtensionInstance | undefined {
  const picked = chosen
    ? instances.find((i) => i.app === chosen.app && i.profile === chosen.profile)
    : undefined;
  return picked ?? (instances.length === 1 ? instances[0] : undefined);
}
