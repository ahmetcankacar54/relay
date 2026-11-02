import type { CarriedConversation, Scope } from "./desktop-files";

// Claude Desktop keeps each account's Code sidebar organization in its shared Local Storage,
// per `<accountUuid>/<orgId>` scope, and keeps it more than once (found 2026-10-19):
// - `dframe-store` (zustand persist, version 1): `state.customGroupsByScope[scope]` holds the
//   custom groups, `{groups: [{id, name}], assignments: {"code:local_<alias>": groupId},
//   order: {groupId: ["code:local_<alias>", ...]}}`, and `state.codeSidebarByScope[scope]` the
//   sections, `{sections: [{id, kind, v: 2, name, order, members?, ...}]}`; a "manual" section's
//   id is its group's id.
// - `LSS-persisted.dframe-group-scopes` and `LSS-persisted.dframe-code-sections`: the same two
//   maps under `value`. They can lag behind `dframe-store`, which is what the sidebar shows.
// The Pinned section is the global `LSS-persisted.starred-local-code-sessions`, keyed by alias.
// Relay only reads these, from a copy, and never writes them: see
// docs/superpowers/specs/2026-10-19-sidebar-organization-design.md.

/** Why the sidebar step stops: Desktop's storage has a shape Relay does not know. */
export class UnsupportedSidebar extends Error {
  constructor(what: string) {
    super(`unsupported Desktop sidebar format: ${what}`);
  }
}

/** One custom ("manual") section of an account's Code sidebar. */
export interface SidebarSection {
  id: string;
  /** As the user named it, trimmed. May be empty. */
  name: string;
  /** The aliases filed in it, lower case, in sidebar order. */
  members: string[];
}

/** An account's custom sections, in sidebar order. */
export type SidebarLayout = SidebarSection[];

/** What Relay read of Claude's sidebar storage. */
export interface SidebarStorage {
  /** The custom sections of `scope`; none when Desktop has none for it. */
  layout(scope: Scope): SidebarLayout;
  /** The pinned sessions' aliases, lower case. Pins are not per account. */
  starred: Set<string>;
}

type Json = Record<string, unknown>;
const STORE_VERSION = 1;
const SECTION_VERSION = 2;
const CODE_KEY =
  /^code:local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const PIN =
  /^(?:code:)?local_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const ANY_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON object in `raw[key]`, undefined when the key is absent. */
function parsed(raw: Record<string, string>, key: string): Json | undefined {
  if (!Object.hasOwn(raw, key)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw[key]);
  } catch {
    throw new UnsupportedSidebar(`${key} is not JSON`);
  }
  if (!isObject(value)) throw new UnsupportedSidebar(`${key} is not an object`);
  return value;
}

/** An optional map inside an object: absent is empty, anything but an object is refused. */
function map(owner: Json | undefined, key: string, where: string): Json {
  const value = owner?.[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw new UnsupportedSidebar(`${where}.${key}`);
  return value;
}

/** The value a `LSS-persisted.*` key wraps, `{value, tabId, timestamp}`. */
function persisted(raw: Record<string, string>, key: string): Json {
  const outer = parsed(raw, key);
  if (!outer) return {};
  return map(outer, "value", key);
}

/** The entry for `scope` in a map keyed by `<accountUuid>/<orgId>`, compared in lower case. */
function scoped(entries: Json, scope: Scope, where: string): Json | undefined {
  const want = `${scope.accountUuid}/${scope.orgId}`.toLowerCase();
  const key = Object.keys(entries).find((k) => k.toLowerCase() === want);
  if (key === undefined) return undefined;
  const entry = entries[key];
  if (!isObject(entry)) throw new UnsupportedSidebar(`${where} entry`);
  return entry;
}

interface Group {
  id: string;
  name: string;
}

/** A scope's custom groups, `{groups, assignments, order}`. */
function groupsOf(entry: Json | undefined, where: string) {
  if (!entry) return { groups: [] as Group[], assignments: {}, order: {} };
  const groups = entry.groups ?? [];
  if (
    !Array.isArray(groups) ||
    !groups.every(
      (g) =>
        isObject(g) && typeof g.id === "string" && typeof g.name === "string",
    )
  )
    throw new UnsupportedSidebar(`${where}.groups`);
  const assignments = map(entry, "assignments", where);
  if (!Object.values(assignments).every((g) => typeof g === "string"))
    throw new UnsupportedSidebar(`${where}.assignments`);
  const order = map(entry, "order", where);
  if (
    !Object.values(order).every(
      (list) => Array.isArray(list) && list.every((k) => typeof k === "string"),
    )
  )
    throw new UnsupportedSidebar(`${where}.order`);
  return {
    groups: groups as Group[],
    assignments: assignments as Record<string, string>,
    order: order as Record<string, string[]>,
  };
}

interface Section {
  id: string;
  kind: string;
  name: string;
  order?: number;
  members?: string[];
}

/** A scope's sections; a version other than 2 is refused, not guessed at. */
function sectionsOf(entry: Json | undefined, where: string): Section[] {
  if (!entry) return [];
  const sections = entry.sections ?? [];
  if (!Array.isArray(sections))
    throw new UnsupportedSidebar(`${where}.sections`);
  for (const s of sections)
    if (
      !isObject(s) ||
      typeof s.id !== "string" ||
      typeof s.kind !== "string" ||
      (s.name !== undefined && typeof s.name !== "string") ||
      (s.v !== undefined && s.v !== SECTION_VERSION) ||
      (s.order !== undefined && typeof s.order !== "number") ||
      (s.members !== undefined &&
        !(
          Array.isArray(s.members) &&
          s.members.every((m) => typeof m === "string")
        ))
    )
      throw new UnsupportedSidebar(`${where}.sections entry`);
  return sections.map((s: Json) => ({
    id: s.id as string,
    kind: s.kind as string,
    name: (s.name as string | undefined) ?? "",
    ...(typeof s.order === "number" ? { order: s.order } : {}),
    ...(s.members ? { members: s.members as string[] } : {}),
  }));
}

/** The alias in a `code:local_<alias>` key, lower case; undefined for anything else. */
const codeAlias = (key: string) => CODE_KEY.exec(key)?.[1].toLowerCase();

/**
 * Reads the raw values of `SIDEBAR_KEYS` the helper found. A missing key reads as no
 * organization. Throws `UnsupportedSidebar` on any shape Relay does not know, so nothing is
 * planned from a guess.
 */
export function readSidebarStorage(
  raw: Record<string, string>,
): SidebarStorage {
  const store = parsed(raw, "dframe-store");
  if (store && store.version !== STORE_VERSION)
    throw new UnsupportedSidebar("dframe-store version");
  const state = store ? map(store, "state", "dframe-store") : {};
  const storeGroups = map(state, "customGroupsByScope", "dframe-store");
  const storeSections = map(state, "codeSidebarByScope", "dframe-store");
  const lssGroups = persisted(raw, "LSS-persisted.dframe-group-scopes");
  const lssSections = persisted(raw, "LSS-persisted.dframe-code-sections");
  const starredRaw = parsed(raw, "LSS-persisted.starred-local-code-sessions");
  const starredList = starredRaw?.value ?? [];
  if (!Array.isArray(starredList))
    throw new UnsupportedSidebar("LSS-persisted.starred-local-code-sessions");
  const starred = new Set<string>();
  for (const id of starredList) {
    if (typeof id !== "string") throw new UnsupportedSidebar("pinned entry");
    const alias = PIN.exec(id)?.[1];
    if (alias) starred.add(alias.toLowerCase());
    // A pin that names a session in a form Relay does not know is refused: read as unpinned,
    // the recipe would move it, and moving unpins it on every account. A pin of another kind,
    // with no session id in it, is not a local session's.
    else if (ANY_UUID.test(id)) throw new UnsupportedSidebar("pinned entry");
  }

  return {
    starred,
    layout(scope) {
      // `dframe-store` is what the sidebar shows. The LSS copies can lag behind it, keeping a
      // group the user deleted or filings the user undid, so they count only for a scope
      // `dframe-store` does not have at all.
      const storeEntry = scoped(storeGroups, scope, "customGroupsByScope");
      const groups = storeEntry
        ? groupsOf(storeEntry, "customGroupsByScope")
        : groupsOf(
            scoped(lssGroups, scope, "dframe-group-scopes"),
            "dframe-group-scopes",
          );
      const sectionsEntry =
        scoped(storeSections, scope, "codeSidebarByScope") ??
        scoped(lssSections, scope, "dframe-code-sections");
      const sections = sectionsOf(sectionsEntry, "sections");

      const byId = new Map<
        string,
        { id: string; name: string; order: number; index: number }
      >();
      const add = (id: string, name: string, order = Infinity) => {
        if (!byId.has(id))
          byId.set(id, { id, name: name.trim(), order, index: byId.size });
      };
      for (const s of sections)
        if (s.kind === "manual") add(s.id, s.name, s.order);
      for (const g of groups.groups) add(g.id, g.name);
      // A section without a name of its own shows its group's.
      for (const g of groups.groups) {
        const entry = byId.get(g.id)!;
        if (!entry.name) entry.name = g.name.trim();
      }

      const filed = new Map<string, string>();
      const file = (alias: string | undefined, id: string) => {
        if (alias && byId.has(id) && !filed.has(alias)) filed.set(alias, id);
      };
      for (const [key, id] of Object.entries(groups.assignments))
        file(codeAlias(key), id);
      for (const s of sections)
        if (s.kind === "manual")
          for (const key of s.members ?? []) file(codeAlias(key), s.id);

      return [...byId.values()]
        .sort((a, b) => a.order - b.order || a.index - b.index)
        .map(({ id, name }) => {
          const members: string[] = [];
          for (const key of groups.order[id] ?? []) {
            const alias = codeAlias(key);
            if (alias && filed.get(alias) === id && !members.includes(alias))
              members.push(alias);
          }
          for (const [alias, sectionId] of filed)
            if (sectionId === id && !members.includes(alias))
              members.push(alias);
          return { id, name, members };
        });
    },
  };
}

/** What the target account lacks of its sources' organization. */
export interface SidebarGap {
  /** Sections in the order the recipe creates them, each with the sessions to file in it. */
  sections: { name: string; ids: string[] }[];
  /** How many of those sections the target has no section of that name for. */
  missingSections: number;
  /** How many sessions the recipe files, all sections together. */
  sessions: number;
  /** The source accounts the gap comes from, in order. */
  from: string[];
}

/**
 * The organization the target lacks, as fill-gaps-only steps; undefined when it lacks nothing.
 *
 * The target's own filing comes first: a conversation it had filed under an alias the merge
 * replaced (its card now has the conversation's `targetAlias`) goes back into the target's own
 * section. Then the sources, in priority order, the account being left first: the first source
 * that names a section places it, and the first that files a session decides where it goes. A
 * session is filed only when the switch carried its conversation to the target (it is then
 * known there by its `targetAlias`), it is not pinned (filing a pinned session through Desktop
 * unpins it on every account) and the target has not filed it anywhere. Sections are matched by
 * name. Nothing of the target's own is ever moved, renamed or removed.
 */
export function planSidebarGap(input: {
  sources: { accountUuid: string; layout: SidebarLayout }[];
  /** The account switched to, and its sections. */
  target: { accountUuid: string; layout: SidebarLayout };
  conversations: CarriedConversation[];
  starred: Set<string>;
}): SidebarGap | undefined {
  const targetAccount = input.target.accountUuid.toLowerCase();
  const targetNames = new Set(
    input.target.layout.map((s) => s.name).filter(Boolean),
  );
  const targetFiled = new Set(input.target.layout.flatMap((s) => s.members));
  const targetSection = new Map<string, string>();
  for (const s of input.target.layout)
    if (s.name) for (const alias of s.members) targetSection.set(alias, s.name);
  const carried = new Map<string, string>();
  for (const c of input.conversations)
    for (const m of c.members)
      carried.set(
        `${m.accountUuid.toLowerCase()}|${m.alias.toLowerCase()}`,
        c.targetAlias.toLowerCase(),
      );

  const planned = new Set<string>();
  const sections = new Map<
    string,
    { name: string; ids: string[]; from: Set<string> }
  >();
  const entryFor = (name: string, source?: string) => {
    let entry = sections.get(name);
    if (!entry) {
      entry = { name, ids: [], from: new Set(source ? [source] : []) };
      sections.set(name, entry);
    }
    return entry;
  };
  for (const c of input.conversations) {
    const to = c.targetAlias.toLowerCase();
    if (targetFiled.has(to) || input.starred.has(to)) continue;
    const own = c.members.find(
      (m) =>
        m.accountUuid.toLowerCase() === targetAccount &&
        targetSection.has(m.alias.toLowerCase()),
    );
    if (!own || planned.has(to)) continue;
    planned.add(to);
    entryFor(targetSection.get(own.alias.toLowerCase())!).ids.push(to);
  }
  for (const source of input.sources) {
    const account = source.accountUuid.toLowerCase();
    for (const section of source.layout) {
      if (!section.name) continue;
      const entry = entryFor(section.name, source.accountUuid);
      for (const alias of section.members) {
        const to = carried.get(`${account}|${alias}`);
        if (
          !to ||
          input.starred.has(to) ||
          targetFiled.has(to) ||
          planned.has(to)
        )
          continue;
        planned.add(to);
        entry.ids.push(to);
        entry.from.add(source.accountUuid);
      }
    }
  }
  // A section the target already has is only worth listing for the sessions to file in it.
  const kept = [...sections.values()].filter(
    (s) => s.ids.length > 0 || !targetNames.has(s.name),
  );
  if (kept.length === 0) return undefined;
  const contributed = new Set(kept.flatMap((s) => [...s.from]));
  const from = input.sources
    .map((s) => s.accountUuid)
    .filter((uuid, i, all) => contributed.has(uuid) && all.indexOf(uuid) === i);
  return {
    sections: kept.map(({ name, ids }) => ({ name, ids })),
    missingSections: kept.filter((s) => !targetNames.has(s.name)).length,
    sessions: kept.reduce((n, s) => n + s.ids.length, 0),
    from,
  };
}

/** Most ids Desktop's `move_sessions` takes in one call. */
export const MOVE_BATCH = 100;

/** How many sessions the recipe asks `list_sessions` for: its default is only 20. */
export const LIST_LIMIT = 1000;

/**
 * The prompt the user pastes into a Code session on the target account: Claude rebuilds the
 * sections with Desktop's own sidebar tools, filling gaps only. `to` and `from` are account
 * names, for the reader; `from` is empty when the gap only restores the target's own filing.
 */
export function sidebarRecipe(
  gap: SidebarGap,
  names: { to: string; from: string[] },
): string {
  const origin = names.from.length
    ? `They come from ${names.from.join(", ")}, as Relay read them at the last switch.`
    : "They put sessions back where this account had filed them, as Relay read them at the last switch.";
  const lines = [
    `Recreate my Code sidebar sections on this account (${names.to}). ${origin}`,
    "",
    "Use only the sidebar tools (list_sections, create_section, move_sessions) and list_sessions. Never delete, rename or reorder an existing section, and never pin or unpin anything.",
    "",
    '1. Call list_sections. For each section below, reuse a "manual" section with the same name (ignoring spaces at either end); otherwise create it with create_section, in the order below.',
    `2. Call list_sessions with limit ${LIST_LIMIT} and include_archived true, so that every session is listed. For each section, move the listed session ids into it with move_sessions (section_id; at most ${MOVE_BATCH} ids per call). Leave out an id that list_sessions does not list, one whose pinned is true (moving would unpin it on every account), and one whose group is already another section.`,
    "3. Do not touch any other session or setting. Finish with one line per section: created or reused, how many moved, how many left out and why.",
    "",
    "## Sections",
  ];
  for (const section of gap.sections)
    lines.push(
      "",
      `### ${section.name}`,
      "",
      section.ids.length
        ? section.ids.map((alias) => `local_${alias}`).join(" ")
        : "(no sessions: create the section only)",
    );
  return lines.join("\n") + "\n";
}
