import fs from "node:fs";
import path from "node:path";
import { BROWSERS, CLAUDE_EXTENSION_ID, type BrowserApp } from "../shared/browser-extension";
import type { SignIn } from "../shared/extension-auth";
import { StorageError, type ExtensionStorage } from "../electron/core/extension-storage";
import type { BrowserSystem } from "../electron/core/browser-system";

/** A stored sign-in for an account, as the extension keeps it: each value is JSON text. */
export function signInFor(accountUuid: string, n = 1): SignIn {
  return {
    accountUuid: JSON.stringify(accountUuid),
    accessToken: JSON.stringify(`ACCESS-SECRET-${n}`),
    refreshToken: JSON.stringify(`REFRESH-SECRET-${n}`),
    tokenExpiry: JSON.stringify(1_900_000_000_000 + n),
  };
}

/**
 * Browsers and the extension's storage in a temp folder: real files for what Relay reads
 * (`Local State`, the extension's folder, so backups copy something), a recorded `quit` and
 * `launch`, and a storage that, like LevelDB, refuses to open while the browser runs.
 */
export function extensionWorld(temp: string) {
  const support = path.join(temp, "home", "Library", "Application Support");
  const events: string[] = [];
  const state = {
    running: false,
    /** The browser ignores a quit request, as one with an open prompt would. */
    stuck: false,
    failLaunch: false,
    /** The LevelDB library can be loaded; false as in the CLI, which has no dependencies. */
    available: true,
    /** Makes the next write change the folder, then fail with this reason. */
    failWrite: undefined as undefined | "failed" | "mismatch",
  };
  /** Every dir the storage was used on, with whether the browser ran then. */
  const opened: { dir: string; running: boolean }[] = [];
  const stored = new Map<string, SignIn | undefined>();
  const system: BrowserSystem = {
    support,
    readText: (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    exists: (file) => fs.existsSync(file),
    readLink: () => undefined,
    alive: () => false,
    processes: async () =>
      state.running ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n" : "",
    quit: async (app) => {
      events.push(`quit:${app}`);
      if (!state.stuck) state.running = false;
    },
    launch: async (app) => {
      events.push(`launch:${app}`);
      if (state.failLaunch) throw new Error("open failed");
      state.running = true;
    },
    sleep: async () => {},
  };
  const storage: ExtensionStorage = {
    available: async () => state.available,
    read: async (dir) => {
      opened.push({ dir, running: state.running });
      if (state.running) throw new StorageError("locked", "locked");
      return structuredClone(stored.get(dir));
    },
    write: async (dir, signIn) => {
      opened.push({ dir, running: state.running });
      if (state.running) throw new StorageError("locked", "locked");
      if (state.failWrite) {
        // A half-done write: the folder changed, the sign-in did not.
        fs.writeFileSync(path.join(dir, "data.txt"), "HALF-WRITTEN");
        throw new StorageError(state.failWrite, "write failed");
      }
      stored.set(dir, structuredClone(signIn));
    },
  };
  /** Adds a profile with the extension's folder; returns that folder. */
  function install(app: BrowserApp, profile = "Default", name = profile): string {
    const data = path.join(support, BROWSERS[app].dataDir);
    fs.mkdirSync(data, { recursive: true });
    const file = path.join(data, "Local State");
    const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    local.profile ??= { info_cache: {} };
    local.profile.info_cache[profile] = { name };
    fs.writeFileSync(file, JSON.stringify(local));
    const dir = path.join(data, profile, "Local Extension Settings", CLAUDE_EXTENSION_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "data.txt"), "ORIGINAL");
    return dir;
  }
  return { support, system, storage, events, state, opened, stored, install };
}
