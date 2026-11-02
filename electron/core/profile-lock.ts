import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readPrivateJson } from "./continuation-journal";
import { holderAlive } from "./process-lock";

/**
 * Shared: Claude Code runs under the profile (the CLI's `run`, the app's terminals).
 * Exclusive: its credential is being changed (login, refresh, removal).
 */
export type ProfileLockKind = "shared" | "exclusive";

export interface ProfileLockHolder {
  pid: number;
  kind: ProfileLockKind;
  startedAt: string;
}

export class ProfileLockBusyError extends Error {
  constructor(
    readonly accountId: string,
    readonly holders: ProfileLockHolder[],
  ) {
    super(
      holders.some((h) => h.kind === "exclusive")
        ? "Another process is signing this account in or renewing its connection."
        : "Claude Code is running with this account.",
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = /^\d+-[0-9a-f-]{36}\.json$/i;

function accountDir(locksDir: string, accountId: string) {
  if (!UUID.test(accountId)) throw new Error("Invalid account id.");
  return path.join(locksDir, accountId.toLowerCase());
}

/** Live holders, each with its file name; dead holders' files are removed on the way. */
function liveEntries(dir: string) {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error: any) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const live: (ProfileLockHolder & { name: string })[] = [];
  for (const name of names) {
    if (!NAME.test(name)) continue;
    const file = path.join(dir, name);
    let value: any;
    try {
      value = readPrivateJson(file, 4096);
    } catch {
      continue; // Being written this instant, or not ours to judge.
    }
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      (value.kind !== "shared" && value.kind !== "exclusive") ||
      typeof value.startedAt !== "string"
    )
      continue;
    if (!holderAlive(value.pid, value.startedAt)) {
      try {
        fs.unlinkSync(file);
      } catch {
        // Swept by someone else.
      }
      continue;
    }
    live.push({ name, pid: value.pid, kind: value.kind, startedAt: value.startedAt });
  }
  return live;
}

/** The live holders of an account's profile lock, without `exceptPid`'s. */
export function profileLockHolders(
  locksDir: string,
  accountId: string,
  exceptPid?: number,
): ProfileLockHolder[] {
  return liveEntries(accountDir(locksDir, accountId))
    .filter((h) => h.pid !== exceptPid)
    .map(({ pid, kind, startedAt }) => ({ pid, kind, startedAt }));
}

/** Whether any account's profile is locked exclusively, other than by `exceptPid`. */
export function anyExclusiveProfileLock(locksDir: string, exceptPid?: number): boolean {
  let accounts: string[];
  try {
    accounts = fs.readdirSync(locksDir).filter((name) => UUID.test(name));
  } catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return accounts.some((account) =>
    profileLockHolders(locksDir, account, exceptPid).some((h) => h.kind === "exclusive"),
  );
}

/**
 * Takes an account's profile lock and returns its release. The process writes its own file,
 * then looks at the others: exclusive needs no other live holder, shared needs no live
 * exclusive one. On a conflict its own file goes again and ProfileLockBusyError names them.
 */
export function acquireProfileLock(
  locksDir: string,
  accountId: string,
  kind: ProfileLockKind,
): () => void {
  const dir = accountDir(locksDir, accountId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const name = `${process.pid}-${randomUUID()}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: process.pid, kind, startedAt: new Date().toISOString() }),
    { mode: 0o600, flag: "wx" },
  );
  const release = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      // Already gone.
    }
  };
  const others = liveEntries(dir).filter((h) => h.name !== name);
  if (kind === "exclusive" ? others.length : others.some((h) => h.kind === "exclusive")) {
    release();
    throw new ProfileLockBusyError(
      accountId,
      others.map(({ pid, kind: k, startedAt }) => ({ pid, kind: k, startedAt })),
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}
