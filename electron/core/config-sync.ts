import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ConfigSyncSettings } from "../../shared/types";

/**
 * Keeps Claude Code's own setup the same in every account's Relay profile at a switch.
 *
 * What differs per account today: each Relay account has its own Claude Code profile
 * (`<userData>/profiles/<id>`, the CLAUDE_CONFIG_DIR of `relay run`, Relay's terminals and early
 * start), so its user MCP servers (`mcpServers` in the profile's `.claude.json`), `skills/` and
 * `agents/`, `settings.json` and `CLAUDE.md` are its own. What is already global needs nothing:
 * the Claude app's `claude_desktop_config.json` (its `mcpServers`) is one file a switch never
 * swaps, and the plain `claude` in a terminal and the app's Code tab use `~/.claude` for every
 * account. So a switch carries the chosen items from the account being left to the one switched to.
 *
 * Items merge by name; one both sides have and that differs goes to the side whose copy is newer
 * by modification time. A copy the switched-to profile loses is saved first under
 * `<backups>/<timestamp>/` (the newest `CONFIG_SYNC_BACKUP_LIMIT` are kept). Nothing is ever
 * deleted by the merge, and nothing that signs an account in travels: `.credentials.json`, the
 * `.claude.json` keys besides `mcpServers`, settings keys outside the allow-list and the
 * account-local `env` variables stay with their account.
 */

/** How many backup folders `<userData>/config-sync-backups` keeps. */
export const CONFIG_SYNC_BACKUP_LIMIT = 10;

/** The settings.json keys that travel; anything else (apiKeyHelper, auth, oauth…) never does. */
export const SYNCED_SETTINGS_KEYS = [
  "permissions",
  "env",
  "hooks",
  "statusLine",
  "model",
] as const;

/** The folders whose entries travel by name with the `skills` choice. */
const ENTRY_FOLDERS = ["skills", "agents"] as const;

/** The name words that mark an `env` variable as a secret (see `accountLocalEnv`). */
const SECRET_WORDS = [
  "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "CREDENTIALS", "KEY", "APIKEY",
  "AUTH", "OAUTH", "COOKIE", "SESSION", "PAT",
];

/**
 * An `env` variable that belongs to its account: a secret, or what decides which account or
 * endpoint Claude Code talks to. It stays where it is and never travels. Judged by the name's
 * `_`-separated words, so `GITHUB_TOKEN` stays and `MAX_THINKING_TOKENS` travels.
 */
export function accountLocalEnv(name: string) {
  const upper = name.toUpperCase();
  return (
    upper.split("_").some((word) => SECRET_WORDS.includes(word)) ||
    upper === "ANTHROPIC_BASE_URL" ||
    upper === "CLAUDE_CONFIG_DIR"
  );
}

export interface ConfigSyncResult {
  /** MCP servers added to or replaced in the profile switched to. */
  mcpServers: number;
  /** Skill and agent entries added or replaced. */
  entries: number;
  /** settings.json keys added or replaced. */
  settings: number;
  claudeMd: boolean;
  /** The backup folder of this switch, when the profile switched to lost something. */
  backup?: string;
  /** The items that could not be read or written, by name; the rest still synced. */
  failed: string[];
}

export interface ConfigSyncOptions {
  /** The profile of the account being left. */
  from: string;
  /** The profile of the account switched to. */
  to: string;
  choice: ConfigSyncSettings;
  /** `<userData>/config-sync-backups`. */
  backups: string;
  now?: () => number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** The `code` of a Node file error, such as "ENOENT". */
const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? error.code : undefined;

/** A regular file's stat, or undefined when it is missing, a link or not a file. */
async function fileStat(file: string) {
  try {
    const stat = await fs.lstat(file);
    return stat.isFile() ? stat : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** The JSON object in `file`: undefined when it is missing, an error when it is not an object. */
async function readJsonObject(file: string): Promise<{ value: Json; mtime: number } | undefined> {
  const stat = await fileStat(file);
  if (!stat) {
    // A link or folder in its place is never read or replaced.
    if (await exists(file)) throw new Error("not-a-file");
    return undefined;
  }
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (!isObject(value)) throw new Error("not-an-object");
  return { value, mtime: stat.mtimeMs };
}

async function exists(file: string) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Writes through a temporary file, owner-only, so Claude Code never reads half a file. */
async function writeAtomic(file: string, data: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Claude Code's global config in a profile: the legacy `.config.json` when it exists, as Claude Code reads it. */
async function profileConfigFile(profile: string) {
  const legacy = path.join(profile, ".config.json");
  return (await fileStat(legacy)) ? legacy : path.join(profile, ".claude.json");
}

/** Files and links under `dir` with their bytes and the newest modification time anywhere in it. */
async function tree(root: string): Promise<{ files: Map<string, string>; mtime: number }> {
  const files = new Map<string, string>();
  let mtime = 0;
  const walk = async (relative: string) => {
    const full = path.join(root, relative);
    const stat = await fs.lstat(full);
    mtime = Math.max(mtime, stat.mtimeMs);
    if (stat.isSymbolicLink()) files.set(relative, `link:${await fs.readlink(full)}`);
    else if (stat.isFile()) files.set(relative, `file:${(await fs.readFile(full)).toString("base64")}`);
    else if (stat.isDirectory()) {
      if (relative) files.set(relative, "dir");
      for (const name of (await fs.readdir(full)).sort()) await walk(path.join(relative, name));
    }
  };
  await walk("");
  return { files, mtime };
}

/** The visible entries of a skills or agents folder; a hidden one, or a link, never travels. */
async function entries(dir: string): Promise<string[]> {
  try {
    const found = await fs.readdir(dir, { withFileTypes: true });
    return found
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isFile()))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * Carries the chosen items from `from` to `to` (see the file comment). Each item is done on its
 * own: one that fails is named in `failed`, and the others still sync.
 */
export async function syncProfileConfig(options: ConfigSyncOptions): Promise<ConfigSyncResult> {
  const { from, to, choice, backups } = options;
  const now = options.now ?? Date.now;
  const result: ConfigSyncResult = { mcpServers: 0, entries: 0, settings: 0, claudeMd: false, failed: [] };
  if (path.resolve(from) === path.resolve(to)) return result;
  let backupDir: string | undefined;
  /** This switch's backup folder, made on the first loss. */
  const backup = async () => {
    if (backupDir) return backupDir;
    await fs.mkdir(backups, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    for (let n = 0; ; n++) {
      const candidate = path.join(backups, n ? `${stamp}-${n}` : stamp);
      try {
        await fs.mkdir(candidate, { mode: 0o700 });
        backupDir = candidate;
        result.backup = candidate;
        return candidate;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
  };
  const attempt = async (name: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch {
      result.failed.push(name);
    }
  };

  if (choice.mcpServers)
    await attempt("mcpServers", async () => {
      const source = await readJsonObject(await profileConfigFile(from));
      const servers = source?.value.mcpServers;
      if (!source || !isObject(servers) || !Object.keys(servers).length) return;
      const file = await profileConfigFile(to);
      const target = (await readJsonObject(file)) ?? { value: {}, mtime: 0 };
      if (target.value.mcpServers !== undefined && !isObject(target.value.mcpServers)) return;
      const own = isObject(target.value.mcpServers) ? target.value.mcpServers : {};
      const next: Json = { ...own };
      const lost: Json = {};
      for (const [name, server] of Object.entries(servers)) {
        if (!(name in own)) next[name] = server;
        else if (isDeepStrictEqual(own[name], server) || target.mtime >= source.mtime) continue;
        else {
          lost[name] = own[name];
          next[name] = server;
        }
        result.mcpServers++;
      }
      if (!result.mcpServers) return;
      if (Object.keys(lost).length)
        await writeAtomic(path.join(await backup(), "mcpServers.json"), JSON.stringify(lost, null, 2));
      await writeAtomic(file, JSON.stringify({ ...target.value, mcpServers: next }, null, 2));
    });

  if (choice.skills)
    for (const folder of ENTRY_FOLDERS)
      await attempt(folder, async () => {
        const sourceDir = path.join(from, folder);
        const names = await entries(sourceDir);
        if (!names.length) return;
        const targetDir = path.join(to, folder);
        await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
        for (const name of names) {
          const source = path.join(sourceDir, name);
          const target = path.join(targetDir, name);
          const theirs = await tree(source);
          if (await exists(target)) {
            const stat = await fs.lstat(target);
            // A link the user made is theirs to keep.
            if (stat.isSymbolicLink()) continue;
            const ours = await tree(target);
            const same =
              ours.files.size === theirs.files.size &&
              [...ours.files].every(([key, value]) => theirs.files.get(key) === value);
            if (same || ours.mtime >= theirs.mtime) continue;
            const saved = path.join(await backup(), folder, name);
            await fs.mkdir(path.dirname(saved), { recursive: true, mode: 0o700 });
            await fs.cp(target, saved, { recursive: true, verbatimSymlinks: true });
          }
          const temporary = path.join(targetDir, `.${name}.${randomUUID()}.tmp`);
          try {
            await fs.cp(source, temporary, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
            await fs.rm(target, { recursive: true, force: true });
            await fs.rename(temporary, target);
          } finally {
            await fs.rm(temporary, { recursive: true, force: true });
          }
          result.entries++;
        }
      });

  if (choice.settings)
    await attempt("settings", async () => {
      const source = await readJsonObject(path.join(from, "settings.json"));
      if (!source) return;
      const file = path.join(to, "settings.json");
      const target = (await readJsonObject(file)) ?? { value: {}, mtime: 0 };
      const next: Json = { ...target.value };
      const lost: Json = {};
      const newer = source.mtime > target.mtime;
      for (const key of SYNCED_SETTINGS_KEYS) {
        let theirs = source.value[key];
        let ours = target.value[key];
        if (theirs === undefined) continue;
        /** The account-local `env` variables of the profile switched to: they stay whoever wins. */
        let kept: Json = {};
        if (key === "env") {
          if (!isObject(theirs) || (ours !== undefined && !isObject(ours))) continue;
          const own = isObject(ours) ? Object.entries(ours) : [];
          kept = Object.fromEntries(own.filter(([name]) => accountLocalEnv(name)));
          const ownTravelling = own.filter(([name]) => !accountLocalEnv(name));
          const travelling = Object.entries(theirs).filter(([name]) => !accountLocalEnv(name));
          if (!travelling.length) continue;
          theirs = Object.fromEntries(travelling);
          ours = ownTravelling.length ? Object.fromEntries(ownTravelling) : undefined;
        }
        if (ours !== undefined && (isDeepStrictEqual(ours, theirs) || !newer)) continue;
        if (ours !== undefined) lost[key] = ours;
        next[key] = isObject(theirs) && key === "env" ? { ...kept, ...theirs } : theirs;
        result.settings++;
      }
      if (!result.settings) return;
      if (Object.keys(lost).length)
        await writeAtomic(path.join(await backup(), "settings.json"), JSON.stringify(lost, null, 2));
      await writeAtomic(file, JSON.stringify(next, null, 2));
    });

  if (choice.claudeMd)
    await attempt("CLAUDE.md", async () => {
      const sourceFile = path.join(from, "CLAUDE.md");
      const source = await fileStat(sourceFile);
      if (!source) return;
      const file = path.join(to, "CLAUDE.md");
      const target = await fileStat(file);
      const text = await fs.readFile(sourceFile);
      if (target) {
        const own = await fs.readFile(file);
        if (own.equals(text) || target.mtimeMs >= source.mtimeMs) return;
        await writeAtomic(path.join(await backup(), "CLAUDE.md"), own);
      } else if (await exists(file)) return;
      await writeAtomic(file, text);
      result.claudeMd = true;
    });

  if (backupDir) await pruneConfigSyncBackups(backups);
  return result;
}

/**
 * Removes all but the newest `keep` backup folders, by name (each is named by its time). Never
 * throws: an old backup left behind costs a little disk, a failed switch far more.
 */
export async function pruneConfigSyncBackups(root: string, keep = CONFIG_SYNC_BACKUP_LIMIT): Promise<number> {
  try {
    const found = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    let removed = 0;
    for (const name of found.slice(keep)) {
      await fs.rm(path.join(root, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}
