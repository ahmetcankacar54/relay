import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const uuid = z.uuid();
export type JsonObject = Record<string, any>;
export async function safeFile(root: string, relative: string) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep))
    throw new Error("Invalid Desktop path.");
  for (let p = target; ; p = path.dirname(p)) {
    try {
      if ((await fs.lstat(p)).isSymbolicLink())
        throw new Error("Desktop data cannot contain symbolic links.");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
    if (p === path.resolve(root)) break;
  }
  return target;
}
export async function readBytes(
  root: string,
  relative: string,
): Promise<Buffer | null> {
  const file = await safeFile(root, relative);
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024)
      throw new Error("Unsupported Desktop file size or type.");
    return await fs.readFile(file);
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
export async function readObject(
  root: string,
  relative: string,
): Promise<JsonObject | null> {
  const data = await readBytes(root, relative);
  if (!data) return null;
  const obj = JSON.parse(data.toString("utf8"));
  if (!obj || typeof obj !== "object" || Array.isArray(obj))
    throw new Error("Unsupported Desktop data format.");
  return obj;
}
export async function writeBytes(
  root: string,
  relative: string,
  data: Buffer | null,
) {
  const file = await safeFile(root, relative);
  if (data === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + ".relay-" + randomUUID();
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export const jsonBytes = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2));
export const AUTH_KEYS = [
  "oauth:tokenCache",
  "oauth:tokenCacheV2",
  "lastKnownAccountUuid",
] as const;
export const COOKIE_FILES = [
  "Cookies",
  "Cookies-journal",
  "Cookies-wal",
  "Cookies-shm",
  "Network/Cookies",
  "Network/Cookies-journal",
  "Network/Cookies-wal",
  "Network/Cookies-shm",
];
export function identity(config: JsonObject | null): string | undefined {
  if (
    !config ||
    !uuid.safeParse(config.lastKnownAccountUuid).success ||
    typeof config["oauth:tokenCacheV2"] !== "string" ||
    !config["oauth:tokenCacheV2"]
  )
    return;
  return config.lastKnownAccountUuid;
}
export async function directories(root: string, relative: string) {
  const dir = await safeFile(root, relative);
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && uuid.safeParse(e.name).success)
      .map((e) => e.name);
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
export interface Scope {
  accountUuid: string;
  orgId: string;
}
export const scopePath = (kind: string, s: Scope) =>
  `${kind}/${uuid.parse(s.accountUuid)}/${uuid.parse(s.orgId)}`;

// Only local Code records travel. Remote connectors, permission grants, browser access,
// and server-owned project bindings must be established by the destination account.
export async function planHistory(
  root: string,
  target: Scope,
  sources: Scope[],
  options: { seenSpaceIds?: string[] } = {},
): Promise<Map<string, Buffer>> {
  const writes = new Map<string, Buffer>();
  const targetDir = scopePath("claude-code-sessions", target);
  const scopes = [
    target,
    ...sources.filter(
      (s) => s.accountUuid !== target.accountUuid || s.orgId !== target.orgId,
    ),
  ];
  const deleted = new Set<string>();
  const records = new Map<string, { obj: JsonObject; scope: Scope }>();
  for (const scope of scopes) {
    const relative = scopePath("claude-code-sessions", scope);
    let names: string[];
    try {
      names = await fs.readdir(await safeFile(root, relative));
    } catch (e: any) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const name of names) {
      const deletion = /^deleted_([a-f0-9-]{36})(?:\.json)?$/i.exec(name);
      if (deletion) deleted.add(deletion[1].toLowerCase());
      if (!/^local_[a-f0-9-]{36}\.json$/i.test(name)) continue;
      const obj = await readObject(root, `${relative}/${name}`);
      if (
        !obj ||
        !uuid.safeParse(obj.cliSessionId).success ||
        typeof obj.cwd !== "string" ||
        !path.isAbsolute(obj.cwd) ||
        !Number.isFinite(obj.lastActivityAt)
      )
        throw new Error(
          "Unrecognized Code session format. No Desktop files changed.",
        );
      const current = records.get(name);
      if (!current || obj.lastActivityAt > current.obj.lastActivityAt)
        records.set(name, { obj, scope });
    }
  }
  for (const [name, record] of records) {
    if (deleted.has(name.slice(6, -5).toLowerCase()) || record.scope === target)
      continue;
    const relative = `${targetDir}/${name}`;
    const own = await readObject(root, relative);
    const obj = { ...record.obj };
    for (const [key, fallback] of Object.entries({
      remoteMcpServersConfig: [],
      enabledMcpTools: {},
      bridgeSessionIds: [],
      sessionPermissionUpdates: [],
      alwaysAllowedReasons: [],
      permissionMode: "default",
      chromePermissionMode: "always_ask",
      bypassChosenInApp: false,
      remoteControlAutoEligible: false,
    }))
      obj[key] = own?.[key] ?? fallback;
    // Context can include account-specific instructions; regenerate it in Claude.
    delete obj.promptAppendSnapshot;
    delete obj.pendingSystemReminder;
    delete obj.steeredByRemoteClient;
    delete obj.error;
    delete obj.errorAt;
    delete obj.priorErrorMark;
    // Archive/pin/focus choices are local to the destination, while conversation
    // content and CLI lineage follow the newest session record.
    for (const key of [
      "archived",
      "isArchived",
      "archivedAt",
      "pinned",
      "isPinned",
      "lastFocusedAt",
    ])
      if (own && key in own) obj[key] = own[key];
    writes.set(relative, jsonBytes(obj));
  }
  const targetSpaces = `${scopePath("local-agent-mode-sessions", target)}/spaces.json`;
  const own = await readObject(root, targetSpaces);
  if (own && !Array.isArray(own.spaces))
    throw new Error("Unrecognized project format.");
  const spaces: JsonObject[] = structuredClone(own?.spaces ?? []);
  const validSpace = (space: unknown): space is JsonObject =>
    !!space &&
    typeof space === "object" &&
    !Array.isArray(space) &&
    typeof (space as JsonObject).id === "string" &&
    !!(space as JsonObject).id &&
    (space as JsonObject).id.length <= 2048 &&
    typeof (space as JsonObject).name === "string";
  if (spaces.some((space) => !validSpace(space)))
    throw new Error("Unrecognized project record.");
  const positions = new Map(spaces.map((space, index) => [space.id, index]));
  const seen = new Set(options.seenSpaceIds ?? []);
  const updatedAt = (space: JsonObject) =>
    Number.isFinite(space.updatedAt) ? space.updatedAt : 0;
  let changed = false;
  for (const source of sources) {
    const obj = await readObject(
      root,
      `${scopePath("local-agent-mode-sessions", source)}/spaces.json`,
    );
    if (obj && !Array.isArray(obj.spaces))
      throw new Error("Unrecognized project format.");
    for (const space of obj?.spaces ?? []) {
      if (!validSpace(space)) throw new Error("Unrecognized project record.");
      const position = positions.get(space.id);
      if (
        (position !== undefined &&
          updatedAt(space) <= updatedAt(spaces[position])) ||
        (position === undefined && seen.has(space.id))
      )
        continue;
      // Refresh local project changes while retaining the destination's own
      // server bindings. A missing previously seen project stays deleted.
      const copy = { ...space };
      delete copy.projects;
      delete copy.migration;
      if (position !== undefined) {
        for (const key of ["projects", "migration"])
          if (key in spaces[position]) copy[key] = spaces[position][key];
        spaces[position] = copy;
      } else {
        positions.set(space.id, spaces.length);
        spaces.push(copy);
      }
      changed = true;
    }
  }
  if (changed) writes.set(targetSpaces, jsonBytes({ ...own, spaces }));
  return writes;
}
