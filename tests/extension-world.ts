import fs from "node:fs";
import path from "node:path";
import { BROWSERS, CLAUDE_EXTENSION_ID, type BrowserApp } from "../shared/browser-extension";
import type { SignIn } from "../shared/extension-auth";
import { StorageError, type ExtensionStorage } from "../electron/core/extension-storage";
import type { BrowserSystem } from "../electron/core/browser-system";
import {
  CookieStoreError,
  type CookieSnapshot,
  type CookieStorage,
} from "../electron/core/cookie-store";

/** A browser profile's claude.ai login as the cookie database holds it; `n` tells copies apart. */
export function loginFor(accountUuid: string, n = 1, createdMs = 1_700_000_000_000): CookieSnapshot {
  const row = (name: string, host: string, value: string) => ({
    creation_utc: BigInt(createdMs + 11_644_473_600_000) * 1000n,
    host_key: host,
    top_frame_site_key: "",
    name,
    encrypted_value: new Uint8Array(Buffer.from(`v10${value}-${accountUuid}-${n}`)),
  });
  return {
    version: "24",
    columns: ["creation_utc", "host_key", "top_frame_site_key", "name", "encrypted_value"],
    rows: [
      row("sessionKey", ".claude.ai", "SESSION-SECRET"),
      row("__Host-sessionBinding", "claude.ai", "BINDING-SECRET"),
    ],
    unlisted: [],
  };
}

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
    /** SQLite can be loaded; false where `node:sqlite` is missing. */
    cookiesAvailable: true,
    /** Makes the next cookie write change the cookie file, then fail with this reason. */
    failCookieWrite: undefined as undefined | CookieStoreError["reason"],
  };
  /** The login each profile folder's cookie database holds; undefined reads as logged out. */
  const web = new Map<string, CookieSnapshot | undefined>();
  /** Every dir the storage was used on, with whether the browser ran then. */
  const opened: { dir: string; running: boolean }[] = [];
  const stored = new Map<string, SignIn | undefined>();
  /** When each extension folder was last written; unset folders read as unknown. */
  const modified = new Map<string, number>();
  /** A copy Relay made of an extension folder names its source; it opens while the browser runs. */
  const sourceOf = (dir: string) => {
    try {
      const source = fs.readFileSync(path.join(dir, "source.txt"), "utf8");
      return source === dir ? undefined : source;
    } catch {
      return undefined;
    }
  };
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
    modifiedAt: (dir) => modified.get(dir),
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
      const source = sourceOf(dir);
      if (source) return Object.entries(stored.get(source) ?? {});
      opened.push({ dir, running: state.running });
      if (state.running) throw new StorageError("locked", "locked");
      return Object.entries(stored.get(dir) ?? {});
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
  /** A copy of the cookie files names its source profile; it opens while the browser runs. */
  const cookieSourceOf = (dir: string) => {
    try {
      const source = fs.readFileSync(path.join(dir, "Cookies"), "utf8");
      return source === dir ? undefined : source;
    } catch {
      return undefined;
    }
  };
  const cookies: CookieStorage = {
    available: async () => state.cookiesAvailable,
    read: async (dir) => {
      const source = cookieSourceOf(dir);
      if (!source) {
        opened.push({ dir, running: state.running });
        if (state.running) throw new CookieStoreError("locked", "locked");
      }
      return (
        structuredClone(web.get(source ?? dir)) ?? {
          version: "24",
          columns: ["creation_utc", "host_key", "top_frame_site_key", "name", "encrypted_value"],
          rows: [],
          unlisted: [],
        }
      );
    },
    write: async (dir, snapshot) => {
      opened.push({ dir, running: state.running });
      if (state.running) throw new CookieStoreError("locked", "locked");
      if (state.failCookieWrite) {
        // A half-done write: the cookie file changed, the login did not.
        fs.writeFileSync(path.join(dir, "Cookies"), "HALF-WRITTEN");
        throw new CookieStoreError(state.failCookieWrite, "write failed");
      }
      web.set(dir, structuredClone(snapshot));
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
    fs.writeFileSync(path.join(dir, "source.txt"), dir);
    const profileDir = path.join(data, profile);
    fs.writeFileSync(path.join(profileDir, "Cookies"), profileDir);
    fs.writeFileSync(path.join(profileDir, "Device Bound Sessions"), "DBSC");
    return dir;
  }
  return { support, system, storage, cookies, web, events, state, opened, stored, modified, install };
}
