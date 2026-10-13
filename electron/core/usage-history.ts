import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Account, AccountUsage } from "../../shared/types";
import {
  MAX_USAGE_SAMPLES,
  USAGE_HISTORY_DAYS,
  summarizeUsageSamples,
  usageIdentity,
  usageSample,
  type AccountUsageStatistics,
  type UsageSample,
} from "../../shared/usage-statistics";
import { privateDir } from "./store";

const windowSchema = z
  .object({
    usedPercent: z.number().finite().min(0).max(100),
    resetsAt: z.iso.datetime().optional(),
  })
  .strict();
const sampleSchema = z
  .object({
    accountId: z.string().min(1).max(128),
    identity: z.string().min(1).max(1024),
    checkedAt: z.iso.datetime(),
    fiveHour: windowSchema.optional(),
    sevenDay: windowSchema.optional(),
  })
  .strict()
  .refine((sample) => !!(sample.fiveHour || sample.sevenDay));
const historySchema = z
  .object({
    version: z.literal(1),
    samples: z.array(sampleSchema).max(MAX_USAGE_SAMPLES),
  })
  .strict();
const MAX_FILE_BYTES = 8 * 1024 * 1024;

// This ledger contains only verified quota metadata, never messages or tokens.
// An unreadable ledger stays unavailable rather than silently overwriting it.
export class UsageHistory {
  readonly file: string;
  private samples: UsageSample[] = [];
  private available = true;
  constructor(
    readonly root: string,
    private now = Date.now,
  ) {
    this.file = path.join(root, "usage-history.json");
    try {
      privateDir(root);
      let metadata: fs.Stats;
      try {
        metadata = fs.lstatSync(this.file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > MAX_FILE_BYTES
      )
        throw new Error("Invalid usage history file.");
      const fd = fs.openSync(
        this.file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const opened = fs.fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.size > MAX_FILE_BYTES ||
          opened.ino !== metadata.ino ||
          opened.dev !== metadata.dev
        )
          throw new Error("Usage history changed while reading.");
        this.samples = this.pruned(
          historySchema.parse(JSON.parse(fs.readFileSync(fd, "utf8"))).samples,
        );
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      this.available = false;
    }
  }
  private pruned(samples: UsageSample[]): UsageSample[] {
    const now = this.now();
    const oldest = now - USAGE_HISTORY_DAYS * 86_400_000;
    const seen = new Set<string>();
    return samples
      .filter((sample) => {
        const checkedAt = Date.parse(sample.checkedAt);
        const key = JSON.stringify([
          sample.accountId,
          sample.identity,
          checkedAt,
        ]);
        if (checkedAt < oldest || checkedAt > now || seen.has(key))
          return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => Date.parse(a.checkedAt) - Date.parse(b.checkedAt))
      .slice(-MAX_USAGE_SAMPLES);
  }
  record(account: Account, usage: AccountUsage): void {
    if (!this.available) return;
    const sample = usageSample(account, usage);
    if (!sample || Date.parse(sample.checkedAt) > this.now()) return;
    const previous = [...this.samples]
      .reverse()
      .find(
        (s) =>
          s.accountId === sample.accountId && s.identity === sample.identity,
      );
    if (
      previous &&
      Date.parse(previous.checkedAt) >= Date.parse(sample.checkedAt)
    )
      return;
    const next = this.pruned([...this.samples, sample]);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      privateDir(this.root);
      try {
        const target = fs.lstatSync(this.file);
        if (!target.isFile() || target.isSymbolicLink())
          throw new Error("Invalid usage history file.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, samples: next }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      this.samples = next;
    } catch {
      this.available = false;
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }
  snapshot(
    accounts: readonly Account[],
  ): Record<string, AccountUsageStatistics> {
    return Object.fromEntries(
      accounts.map((account) => [
        account.id,
        summarizeUsageSamples(
          account,
          this.samples,
          this.now(),
          this.available,
        ),
      ]),
    );
  }
  /** Reset dates survive a cache invalidation, without reviving old quota. */
  lastKnownResets(account: Account): AccountUsage["lastKnownResets"] {
    if (!this.available) return;
    const identity = usageIdentity(account);
    if (!identity) return;
    const samples = this.pruned(this.samples)
      .filter(
        (sample) =>
          sample.accountId === account.id && sample.identity === identity,
      )
      .reverse();
    const lastReset = (key: "fiveHour" | "sevenDay") => {
      const sample = samples.find((value) => value[key]?.resetsAt);
      return sample
        ? { resetsAt: sample[key]!.resetsAt!, checkedAt: sample.checkedAt }
        : undefined;
    };
    const fiveHour = lastReset("fiveHour");
    const sevenDay = lastReset("sevenDay");
    if (!fiveHour && !sevenDay) return;
    return {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
    };
  }
}
