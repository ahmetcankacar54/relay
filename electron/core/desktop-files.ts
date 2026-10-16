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

interface SessionRecord {
  name: string;
  alias: string;
  obj: JsonObject;
  scope: Scope;
  isTarget: boolean;
}
const sessionKey = (cliSessionId: string, cwd: string) =>
  `${cliSessionId.toLowerCase()}|${path.resolve(cwd).normalize("NFC")}`;
/**
 * Desktop gives every account its own `local_<uuid>` alias for a conversation, and
 * it adopts transcripts started under another account as `local_<cliSessionId>`.
 * The same conversation therefore appears under different file names in different
 * accounts. Group records by file name, current CLI session and resumed lineage
 * (a stale alias whose current CLI id was later rotated into another record's
 * `priorCliSessionIds`). Each group must produce exactly one card per account.
 */
function groupSessions(records: SessionRecord[]) {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  const union = (a: string, b: string) => {
    for (const key of [a, b]) if (!parent.has(key)) parent.set(key, key);
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const record of records) {
    const file = `file:${record.alias}`;
    union(file, `cli:${sessionKey(record.obj.cliSessionId, record.obj.cwd)}`);
    for (const prior of record.obj.priorCliSessionIds ?? [])
      if (uuid.safeParse(prior).success)
        union(file, `cli:${sessionKey(prior, record.obj.cwd)}`);
  }
  const groups = new Map<string, SessionRecord[]>();
  for (const record of records) {
    const key = find(`file:${record.alias}`);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()];
}
/** The most recently active record is the live conversation; ties prefer the target. */
function newest(records: SessionRecord[]) {
  return [...records].sort(
    (a, b) =>
      b.obj.lastActivityAt - a.obj.lastActivityAt ||
      Number(b.isTarget) - Number(a.isTarget) ||
      Number(b.alias === b.obj.cliSessionId.toLowerCase()) -
        Number(a.alias === a.obj.cliSessionId.toLowerCase()) ||
      a.alias.localeCompare(b.alias),
  )[0];
}
async function readSessions(root: string, scope: Scope, isTarget: boolean) {
  const relative = scopePath("claude-code-sessions", scope);
  const records: SessionRecord[] = [];
  const deleted: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(await safeFile(root, relative));
  } catch (e: any) {
    if (e.code === "ENOENT") return { records, deleted };
    throw e;
  }
  for (const name of names) {
    const deletion = /^deleted_([a-f0-9-]{36})(?:\.json)?$/i.exec(name);
    if (deletion) deleted.push(deletion[1].toLowerCase());
    const local = /^local_([a-f0-9-]{36})\.json$/i.exec(name);
    if (!local) continue;
    let obj: JsonObject | null;
    try {
      obj = await readObject(root, `${relative}/${name}`);
    } catch {
      // A record Desktop is rewriting, or a format Relay does not understand, is
      // left exactly as it is. It must not block switching for every other one.
      continue;
    }
    if (
      !obj ||
      !uuid.safeParse(obj.cliSessionId).success ||
      typeof obj.cwd !== "string" ||
      !path.isAbsolute(obj.cwd) ||
      !Number.isFinite(obj.lastActivityAt)
    )
      continue;
    records.push({
      name,
      alias: local[1].toLowerCase(),
      obj,
      scope,
      isTarget,
    });
  }
  return { records, deleted };
}
/** Read-only duplicate report for one account's Code index (same conversation, several cards). */
export async function duplicateSessions(root: string, scope: Scope) {
  const { records } = await readSessions(root, scope, true);
  return groupSessions(records)
    .filter((group) => group.length > 1)
    .map((group) => group.map((record) => record.name).sort());
}

/** One conversation the merge carries into the target account. */
export interface CarriedConversation {
  /** The alias of the conversation's single card in the target after the merge. */
  targetAlias: string;
  /** Every record of the group, any account, including target cards the merge deletes. */
  members: { alias: string; accountUuid: string }[];
}

// Only local Code records travel. Remote connectors, permission grants, browser access,
// and server-owned project bindings must be established by the destination account.
export async function planHistory(
  root: string,
  target: Scope,
  sources: Scope[],
  options: { seenSpaceIds?: string[] } = {},
): Promise<Map<string, Buffer | null>> {
  return (await planHistoryDetailed(root, target, sources, options)).writes;
}

/** `planHistory`, plus the conversations the merge carries and the alias each ends with. */
export async function planHistoryDetailed(
  root: string,
  target: Scope,
  sources: Scope[],
  options: { seenSpaceIds?: string[] } = {},
): Promise<{
  writes: Map<string, Buffer | null>;
  conversations: CarriedConversation[];
}> {
  const writes = new Map<string, Buffer | null>();
  const conversations: CarriedConversation[] = [];
  const targetDir = scopePath("claude-code-sessions", target);
  const deleted = new Set<string>();
  const all: SessionRecord[] = [];
  const destination = await readSessions(root, target, true);
  all.push(...destination.records);
  destination.deleted.forEach((id) => deleted.add(id));
  for (const source of sources) {
    if (
      source.accountUuid === target.accountUuid &&
      source.orgId === target.orgId
    )
      continue;
    const found = await readSessions(root, source, false);
    all.push(...found.records);
    found.deleted.forEach((id) => deleted.add(id));
  }
  for (const group of groupSessions(all)) {
    // A conversation deleted under any of its aliases stays deleted; Relay does not
    // resurrect it through another alias and leaves the destination's files alone.
    if (group.some((record) => deleted.has(record.alias))) continue;
    const winner = newest(group);
    // The target ends with one card named after the winner: it is written below,
    // or the target already has it.
    conversations.push({
      targetAlias: winner.alias,
      members: group.map((record) => ({
        alias: record.alias,
        accountUuid: record.scope.accountUuid,
      })),
    });
    const existing = group.filter((record) => record.isTarget);
    const keep = existing.find((record) => record.alias === winner.alias);
    // Remove every other destination card of the same conversation. The kept
    // alias matches the most recent one, so a continuation reopens the same URL.
    for (const record of existing)
      if (record !== keep) writes.set(`${targetDir}/${record.name}`, null);
    if (winner.isTarget) continue;
    const relative = `${targetDir}/${keep?.name ?? winner.name}`;
    // Destination choices come from its record of this alias, otherwise from its
    // most recent card of the same conversation that is being replaced.
    const own = (keep ?? (existing.length ? newest(existing) : undefined))?.obj;
    const obj = { ...winner.obj };
    for (const [key, fallback] of Object.entries({
      remoteMcpServersConfig: [],
      enabledMcpTools: {},
      bridgeSessionIds: [],
      sessionPermissionUpdates: [],
      alwaysAllowedReasons: [],
      chromePermissionMode: "always_ask",
      bypassChosenInApp: false,
      remoteControlAutoEligible: false,
    }))
      obj[key] = own?.[key] ?? fallback;
    // The conversation keeps its mode (Manual, Auto, Plan, Accept edits) on the
    // other account. Bypass is an account-local decision and is never carried over.
    if (
      typeof obj.permissionMode !== "string" ||
      obj.permissionMode === "bypassPermissions"
    )
      obj.permissionMode =
        own?.permissionMode && own.permissionMode !== "bypassPermissions"
          ? own.permissionMode
          : "default";
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
  return { writes, conversations };
}
