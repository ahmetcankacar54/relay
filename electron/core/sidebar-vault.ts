import { randomUUID } from "node:crypto";
import { jsonBytes, readObject, uuid, writeBytes } from "./desktop-files";
import type { SidebarGap } from "./sidebar-layout";

/** Inside the vault. Plain JSON: section names and aliases, no conversation text. */
const FILE = "sidebar/pending.json";
/** An entry older than this is not offered any more. */
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;

/** What the last account-changing switch found the account switched to lacks. */
export interface SidebarGapRecord {
  id: string;
  /** The Desktop account switched to. */
  to: string;
  at: string;
  gap: SidebarGap;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/** A clean copy of `value` when it is an entry this vault wrote, else undefined. */
function parseRecord(value: unknown): SidebarGapRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return;
  const { id, to, at, gap } = value as Record<string, any>;
  if (
    !uuid.safeParse(id).success ||
    !uuid.safeParse(to).success ||
    typeof at !== "string" ||
    !Number.isFinite(Date.parse(at)) ||
    typeof gap !== "object" ||
    gap === null ||
    !Array.isArray(gap.sections) ||
    !gap.sections.every(
      (s: any) =>
        typeof s === "object" &&
        s !== null &&
        typeof s.name === "string" &&
        s.name !== "" &&
        strings(s.ids) &&
        s.ids.every((alias: string) => uuid.safeParse(alias).success),
    ) ||
    !Number.isInteger(gap.missingSections) ||
    !Number.isInteger(gap.sessions) ||
    !strings(gap.from)
  )
    return;
  return {
    id,
    to,
    at,
    gap: {
      sections: gap.sections.map((s: any) => ({
        name: s.name,
        ids: [...s.ids],
      })),
      missingSections: gap.missingSections,
      sessions: gap.sessions,
      from: [...gap.from],
    },
  };
}

/**
 * The one sidebar gap Relay offers, in `<vault>/sidebar/pending.json`: what the account switched
 * to at the last account-changing switch lacks of its sources' sidebar organization. Each such
 * switch replaces or clears it; the user can dismiss it. An entry that cannot be read, or is over
 * 14 days old, reads as none.
 */
export class SidebarGapVault {
  constructor(
    private readonly vault: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Replaces the entry with a new one for `to`, and returns it. */
  async put(to: string, gap: SidebarGap): Promise<SidebarGapRecord> {
    const record: SidebarGapRecord = {
      id: randomUUID(),
      to,
      at: new Date(this.now()).toISOString(),
      gap,
    };
    await writeBytes(this.vault, FILE, jsonBytes(record));
    return record;
  }

  async clear(): Promise<void> {
    await writeBytes(this.vault, FILE, null);
  }

  async get(): Promise<SidebarGapRecord | undefined> {
    let record: SidebarGapRecord | undefined;
    try {
      record = parseRecord(await readObject(this.vault, FILE));
    } catch {
      return undefined;
    }
    if (!record || this.now() - Date.parse(record.at) > MAX_AGE_MS)
      return undefined;
    return record;
  }

  /** Removes the entry when it is still `id`; a newer one stays. */
  async remove(id: string): Promise<void> {
    if ((await this.get())?.id === id) await this.clear();
  }
}
