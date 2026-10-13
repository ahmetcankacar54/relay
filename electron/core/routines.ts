import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  Account,
  AccountUsage,
  WorkdaySettings,
} from "../../shared/types";
import {
  planningIdentity,
  quotaPlanningReason,
  workdayPlan,
} from "../../shared/planning";

export interface RoutineRecord {
  key: string;
  date: string;
  accountId: string;
  identityKey: string;
  scheduledAt: string;
  status: "claimed" | "verified" | "sent-unverified" | "failed" | "skipped";
  reason?: string;
  finishedAt?: string;
  observedResetAt?: string;
}
export interface RoutineSnapshot {
  running: boolean;
  entries: RoutineRecord[];
  error?: "ledger-unavailable";
}
export interface RoutineState {
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  workday: WorkdaySettings;
  blockedAccountIds: string[];
  blocked: boolean;
}
export interface RoutineHooks {
  state(): RoutineState;
  refresh(id: string, afterRequest?: boolean): Promise<AccountUsage>;
  verify(account: Account): Promise<boolean>;
  run(account: Account): Promise<void>;
  changed?(): void;
}
export interface RoutineJournal {
  claim(record: RoutineRecord): Promise<boolean>;
  update(key: string, patch: Partial<RoutineRecord>): Promise<void>;
  list(): Promise<RoutineRecord[]>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function routineIdentityKey(account: Account) {
  const identity = planningIdentity(account);
  return identity ? hash(identity) : undefined;
}
export function routineKey(identityKey: string, date: string) {
  return hash(`${identityKey}:${date}`);
}
function recordValid(v: unknown): v is RoutineRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as RoutineRecord;
  const fields = new Set([
    "key",
    "date",
    "accountId",
    "identityKey",
    "scheduledAt",
    "status",
    "reason",
    "finishedAt",
    "observedResetAt",
  ]);
  const timestamp = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  return (
    Object.keys(v).every((key) => fields.has(key)) &&
    typeof r.key === "string" &&
    /^[a-f0-9]{64}$/.test(r.key) &&
    typeof r.identityKey === "string" &&
    /^[a-f0-9]{64}$/.test(r.identityKey) &&
    typeof r.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.date) &&
    Number.isFinite(Date.parse(`${r.date}T00:00:00Z`)) &&
    new Date(`${r.date}T00:00:00Z`).toISOString().slice(0, 10) === r.date &&
    r.key === routineKey(r.identityKey, r.date) &&
    typeof r.accountId === "string" &&
    r.accountId.length > 0 &&
    r.accountId.length <= 128 &&
    timestamp(r.scheduledAt) &&
    (r.finishedAt === undefined || timestamp(r.finishedAt)) &&
    (r.observedResetAt === undefined || timestamp(r.observedResetAt)) &&
    (r.reason === undefined ||
      (typeof r.reason === "string" &&
        /^[a-z][a-z0-9-]{0,80}$/.test(r.reason))) &&
    ["claimed", "verified", "sent-unverified", "failed", "skipped"].includes(
      r.status,
    )
  );
}
const MAX_ROUTINE_RECORD_BYTES = 16_384;
const MAX_ROUTINE_LEDGER_ENTRIES = 10_000;
// One exclusive-create file per identity/day is the claim transaction. A crash
// after create but before a complete record deliberately prevents a retry.
export class RoutineLedger implements RoutineJournal {
  constructor(readonly directory: string) {}
  private file(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid routine key");
    return path.join(this.directory, `${key}.json`);
  }
  private async privateDirectory(create = false) {
    try {
      const parent = await fs.lstat(path.dirname(this.directory));
      if (!parent.isDirectory() || parent.isSymbolicLink())
        throw new Error("Invalid routine ledger directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      throw new Error("Routine ledger parent is unavailable");
    }
    if (create)
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    let metadata;
    try {
      metadata = await fs.lstat(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create)
        return false;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Invalid routine ledger directory");
    if (process.platform !== "win32") await fs.chmod(this.directory, 0o700);
    return true;
  }
  private async read(key: string) {
    const file = this.file(key);
    const metadata = await fs.lstat(file);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > MAX_ROUTINE_RECORD_BYTES
    )
      throw new Error("Invalid routine record");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > MAX_ROUTINE_RECORD_BYTES ||
        opened.ino !== metadata.ino ||
        opened.dev !== metadata.dev
      )
        throw new Error("Routine record changed while reading");
      const buffer = Buffer.alloc(MAX_ROUTINE_RECORD_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_ROUTINE_RECORD_BYTES)
        throw new Error("Invalid routine record");
      const record: unknown = JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8"),
      );
      if (!recordValid(record) || record.key !== key)
        throw new Error("Invalid routine record");
      return { record, metadata: opened };
    } finally {
      await handle.close();
    }
  }
  async claim(record: RoutineRecord) {
    if (!recordValid(record)) throw new Error("Invalid routine record");
    await this.privateDirectory(true);
    let handle;
    try {
      handle = await fs.open(this.file(record.key), "wx", 0o600);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      await handle?.close();
    }
  }
  async update(key: string, patch: Partial<RoutineRecord>) {
    if (!(await this.privateDirectory()))
      throw new Error("Routine ledger is unavailable");
    const file = this.file(key);
    const { record: old, metadata } = await this.read(key);
    const record = {
      ...old,
      ...patch,
      key: old.key,
      identityKey: old.identityKey,
      date: old.date,
      accountId: old.accountId,
      scheduledAt: old.scheduledAt,
    };
    if (!recordValid(record)) throw new Error("Invalid routine record");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.privateDirectory();
      const current = await fs.lstat(file);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.ino !== metadata.ino ||
        current.dev !== metadata.dev
      )
        throw new Error("Routine record changed while writing");
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  async list() {
    if (!(await this.privateDirectory())) return [];
    const entries: RoutineRecord[] = [];
    let count = 0;
    const directory = await fs.opendir(this.directory);
    for await (const entry of directory) {
      if (++count > MAX_ROUTINE_LEDGER_ENTRIES)
        throw new Error("Routine ledger has too many entries");
      const name = entry.name;
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      // Malformed claims remain occupied and cannot dispatch again, even
      // though they have no safely renderable user-facing record.
      try {
        const { record } = await this.read(name.slice(0, -5));
        entries.push(record);
      } catch {
        /* fail-closed claim */
      }
    }
    return entries
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
      .slice(0, 200);
  }
}
export class RoutineManager {
  private previous?: number;
  private active = false;
  private stopped = false;
  private entries: RoutineRecord[] = [];
  private error?: RoutineSnapshot["error"];
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private hooks: RoutineHooks,
    private ledger: RoutineJournal,
    private now = Date.now,
  ) {}
  snapshot(): RoutineSnapshot {
    return {
      running: this.active,
      entries: structuredClone(this.entries),
      error: this.error,
    };
  }
  start() {
    this.stopped = false;
    this.previous = undefined;
    if (!this.timer) {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), 15_000);
      this.timer.unref();
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private fingerprint(state: RoutineState, a: Account) {
    return JSON.stringify([
      state.workday,
      routineIdentityKey(a),
      a.planning,
      a.cooldownUntil,
    ]);
  }
  async tick() {
    if (this.active || this.stopped) return;
    const now = this.now(),
      previous = this.previous;
    this.previous = now;
    this.active = true;
    try {
      this.entries = await this.ledger.list();
      this.error = undefined;
      const initial = this.hooks.state();
      if (!initial.workday.routineEnabled || initial.blocked) return;
      const plan = workdayPlan(
        initial.accounts,
        initial.usage,
        initial.workday,
        now,
      );
      if (!plan.date) return;
      const upcoming = workdayPlan(
        initial.accounts,
        initial.usage,
        initial.workday,
        now + initial.workday.warmupLeadMinutes * 60_000,
      );
      // A full-day shift can still be open when the next anchor day's warm-up
      // is due. Inspect both anchors instead of waiting until midnight.
      const plans =
        upcoming.date && upcoming.date !== plan.date
          ? [plan, upcoming]
          : [plan];
      const slots = plans
        .flatMap((p) => p.slots.map((slot) => ({ date: p.date!, slot })))
        .sort((a, b) => a.slot.scheduledAt.localeCompare(b.slot.scheduledAt));
      // Startup, a backwards clock jump, sleep, or a delayed event loop never
      // generates a catch-up burst. Missed slots are shown as skipped instead.
      const continuous =
        previous !== undefined && now >= previous && now - previous <= 45_000;
      for (const { date, slot } of slots) {
        const scheduled = Date.parse(slot.scheduledAt);
        if (scheduled > now) continue;
        const account = initial.accounts.find((a) => a.id === slot.accountId);
        if (!account) continue;
        const identityKey = routineIdentityKey(account);
        if (!identityKey) continue;
        const record: RoutineRecord = {
          key: routineKey(identityKey, date),
          date,
          accountId: account.id,
          identityKey,
          scheduledAt: slot.scheduledAt,
          status: "claimed",
        };
        if (this.entries.some((entry) => entry.key === record.key)) continue;
        const staticReasons = new Set([
          "not-selected",
          "auth-required",
          "identity-mismatch",
          "duplicate-identity",
          "cooldown",
          "outside-workday",
        ]);
        const reason =
          !continuous || scheduled <= previous! || now - scheduled > 30_000
            ? "missed"
            : initial.blockedAccountIds.includes(account.id)
              ? "account-in-use"
              : slot.reason && staticReasons.has(slot.reason)
                ? slot.reason
                : undefined;
        if (reason) {
          record.status = "skipped";
          record.reason = reason;
        }
        if (!(await this.ledger.claim(record))) continue;
        this.entries.push(record);
        if (reason) continue;
        const fingerprint = this.fingerprint(initial, account);
        const valid = () => {
          if (this.stopped) return false;
          const state = this.hooks.state();
          const current = state.accounts.find((a) => a.id === account.id);
          return (
            !!current &&
            state.workday.routineEnabled &&
            !state.blocked &&
            !state.blockedAccountIds.includes(account.id) &&
            this.fingerprint(state, current) === fingerprint
          );
        };
        let sent = false;
        try {
          if (!valid()) throw new Error("settings-changed");
          if (!(await this.hooks.verify(structuredClone(account))))
            throw new Error("identity-mismatch");
          if (!valid()) throw new Error("settings-changed");
          const before = await this.hooks.refresh(account.id);
          if (!valid()) throw new Error("settings-changed");
          const issue = quotaPlanningReason(
            account,
            before,
            initial.workday.reservePercent,
            this.now(),
          );
          if (issue) throw new Error(issue);
          if (before.fiveHour?.resetsAt) throw new Error("already-active");
          await this.hooks.run(structuredClone(account));
          sent = true;
          if (!valid()) throw new Error("settings-changed");
          // A successful CLI exit alone is insufficient evidence that the
          // quota clock started. The server's newly observed reset is decisive.
          const after = await this.hooks.refresh(account.id, true);
          if (!valid()) throw new Error("settings-changed");
          const reset = after.fiveHour?.resetsAt;
          const verified =
            after.status === "ready" &&
            !after.stale &&
            after.accountId === account.id &&
            !!after.checkedAt &&
            Date.parse(after.checkedAt) >= now &&
            Date.parse(after.checkedAt) <= this.now() &&
            !!reset &&
            Number.isFinite(Date.parse(reset)) &&
            Date.parse(reset) > this.now() &&
            reset !== before.fiveHour?.resetsAt;
          Object.assign(record, {
            status: verified ? "verified" : "sent-unverified",
            observedResetAt: verified ? reset : undefined,
            reason: verified ? undefined : "server-reset-unconfirmed",
          });
        } catch (e) {
          const allowed = new Set([
            "settings-changed",
            "identity-mismatch",
            "auth-required",
            "cooldown",
            "usage-not-fresh",
            "usage-incomplete",
            "reserve",
            "already-active",
            "routine-policy-unverified",
            "routine-platform-unsupported",
            "routine-cli-unavailable",
            "routine-cli-unsupported",
            "routine-credentials-unavailable",
            "routine-request-failed",
            "routine-settings-changed",
          ]);
          const message =
            e instanceof Error && allowed.has(e.message)
              ? e.message
              : "request-failed";
          Object.assign(record, {
            status: sent ? "sent-unverified" : "failed",
            reason: message,
          });
        }
        record.finishedAt = new Date(this.now()).toISOString();
        await this.ledger.update(record.key, record);
        // One request at most per timer tick, including zero-stagger settings.
        // Other coincident slots become missed instead of issuing a burst.
        break;
      }
    } catch {
      this.error = "ledger-unavailable";
    } finally {
      this.active = false;
      this.hooks.changed?.();
    }
  }
}
