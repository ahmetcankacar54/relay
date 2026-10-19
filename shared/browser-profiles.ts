/** The Claude browser extension ("Claude in Chrome"). */
export const CLAUDE_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
/** The Chromium browsers whose profiles Relay can open, on macOS. */
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
  }
> = {
  chrome: {
    name: "Chrome",
    bundleId: "com.google.Chrome",
    dataDir: "Google/Chrome",
  },
  brave: {
    name: "Brave",
    bundleId: "com.brave.Browser",
    dataDir: "BraveSoftware/Brave-Browser",
  },
  edge: {
    name: "Edge",
    bundleId: "com.microsoft.edgemac",
    dataDir: "Microsoft Edge",
  },
  chromium: {
    name: "Chromium",
    bundleId: "org.chromium.Chromium",
    dataDir: "Chromium",
  },
  vivaldi: {
    name: "Vivaldi",
    bundleId: "com.vivaldi.Vivaldi",
    dataDir: "Vivaldi",
  },
};
/** A profile folder Relay hands to the browser: "Default", "Profile 1" and the like. */
export const PROFILE_FOLDER = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
/** Profiles the browser keeps for itself; never a user's. */
const HIDDEN_FOLDERS = new Set(["Guest Profile", "System Profile"]);
/** The browser profile an account opens after a switch; `name` is its name when it was chosen. */
export interface AccountBrowser {
  app: BrowserApp;
  profile: string;
  name: string;
}
export interface BrowserProfile {
  profile: string;
  name: string;
  /** The Claude extension's folder exists there; says nothing of its sign-in. */
  extension: boolean;
}
export interface InstalledBrowser {
  app: BrowserApp;
  profiles: BrowserProfile[];
}
/**
 * "opened": Relay asked the browser to open it. "open": it already had a window.
 * "missing": the browser or the profile is gone. "failed": `open` failed.
 */
export type BrowserOpenResult = "opened" | "open" | "missing" | "failed";

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
 * `profile.last_active_profiles`: while the browser runs, the profiles with a window; after it
 * quits, the ones it will restore.
 */
export function lastActiveProfiles(localState: unknown): string[] {
  const list = record(record(localState)?.profile)?.last_active_profiles;
  return Array.isArray(list)
    ? list.filter((x): x is string => typeof x === "string")
    : [];
}

/** `open`'s arguments for a profile: a new launch, which a running browser hands to itself. */
export function openArgs(app: BrowserApp, profile: string): string[] {
  if (!PROFILE_FOLDER.test(profile))
    throw new Error("Invalid browser profile.");
  return [
    "-n",
    "-b",
    BROWSERS[app].bundleId,
    "--args",
    `--profile-directory=${profile}`,
  ];
}
