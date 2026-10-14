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
import {
  catchUp,
  foldSample,
  foldSamples,
  type UsageRollups,
} from "../../shared/usage-rollups";
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
const hourSchema = z
  .object({
    points: z.number().finite().min(0),
    windows: z.number().int().min(0),
    coveredMinutes: z.number().finite().min(0),
  })
  .strict();
const windowRecordSchema = z
  .object({
    resetAt: z.iso.datetime(),
    maxPercent: z.number().finite().min(0).max(100),
  })
  .strict();
const identityKey = z.string().min(1).max(1024);
const hitSchema = z
  .object({
    identity: identityKey,
    kind: z.enum(["five-hour", "weekly"]),
    at: z.iso.datetime(),
    until: z.iso.datetime().optional(),
    resetAt: z.iso.datetime().optional(),
  })
  .strict();
const rollupsSchema = z
  .object({
    version: z.literal(1),
    hours: z.record(identityKey, z.record(z.iso.datetime(), hourSchema)),
    windows: z.record(identityKey, z.array(windowRecordSchema)),
    hits: z.array(hitSchema),
    last: z.record(identityKey, sampleSchema),
  })
  .strict();
// 50,000 samples of ~340 bytes each must stay readable after they are written.
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_ROLLUPS_BYTES = 16 * 1024 * 1024;

// This ledger contains only verified quota metadata, never messages or tokens.
// An unreadable ledger stays unavailable rather than silently overwriting it.
// Rollups keep 90 days of hourly aggregates beside the 14-day raw ledger; an
// unreadable rollups file is likewise never overwritten and never affects the
// raw ledger or live limits. A failed rollups write keeps the folded state in
// memory and is retried on the next record; only an unsafe target (symlink or
// non-file) makes the rollups unavailable.
class UnsafeUsageFileError extends Error {}

export class UsageHistory {
  readonly file: string;
  readonly rollupsFile: string;
  private samples: UsageSample[] = [];
  private available = true;
  private rollupsState: UsageRollups | undefined;
  /** In-memory rollups differ from usage-rollups.json. */
  private rollupsDirty = false;
  rollupsAvailable = true;
  constructor(
    readonly root: string,
    private now = Date.now,
  ) {
    this.file = path.join(root, "usage-history.json");
    this.rollupsFile = path.join(root, "usage-rollups.json");
    try {
      const value = this.readPrivateJsonFile(this.file, MAX_HISTORY_BYTES);
      if (value !== undefined)
        this.samples = this.pruned(historySchema.parse(value).samples);
    } catch {
      this.available = false;
    }
    try {
      const value = this.readPrivateJsonFile(
        this.rollupsFile,
        MAX_ROLLUPS_BYTES,
      );
      if (value !== undefined) {
        const loaded: UsageRollups = rollupsSchema.parse(value);
        // Catch up samples recorded after the last successful rollups write.
        this.rollupsState = this.available
          ? catchUp(loaded, this.samples, this.now())
          : loaded;
        this.rollupsDirty = this.rollupsState !== loaded;
      } else if (!this.available)
        throw new Error("No readable usage history to backfill from.");
      else {
        this.rollupsState = foldSamples(this.samples, this.now());
        this.rollupsDirty = true;
      }
    } catch {
      this.rollupsAvailable = false;
      this.rollupsState = undefined;
    }
    if (this.rollupsDirty) this.persistRollups();
  }
  private persistRollups(): void {
    if (!this.rollupsAvailable || !this.rollupsState) return;
    try {
      this.writePrivateJsonFile(this.rollupsFile, this.rollupsState);
      this.rollupsDirty = false;
    } catch (error) {
      if (error instanceof UnsafeUsageFileError) {
        this.rollupsAvailable = false;
        this.rollupsState = undefined;
      } else this.rollupsDirty = true;
    }
  }
  /** Parsed JSON, or undefined when the file does not exist. */
  private readPrivateJsonFile(file: string, maxBytes: number): unknown {
    privateDir(this.root);
    let metadata: fs.Stats;
    try {
      metadata = fs.lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maxBytes
    )
      throw new Error("Invalid usage file.");
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.size > maxBytes ||
        opened.ino !== metadata.ino ||
        opened.dev !== metadata.dev
      )
        throw new Error("Usage file changed while reading.");
      return JSON.parse(fs.readFileSync(fd, "utf8"));
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Atomic private write that refuses to replace a non-file or symlink. */
  private writePrivateJsonFile(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      privateDir(this.root);
      try {
        const target = fs.lstatSync(file);
        if (!target.isFile() || target.isSymbolicLink())
          throw new UnsafeUsageFileError("Invalid usage file.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
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
    try {
      this.writePrivateJsonFile(this.file, { version: 1, samples: next });
      this.samples = next;
    } catch {
      this.available = false;
      return;
    }
    if (!this.rollupsAvailable || !this.rollupsState) return;
    const folded = foldSample(this.rollupsState, sample, this.now());
    if (folded === this.rollupsState && !this.rollupsDirty) return;
    this.rollupsState = folded;
    this.persistRollups();
  }
  /** 90-day hourly rollups; undefined when the rollups file is unavailable. */
  rollups(): UsageRollups | undefined {
    if (!this.rollupsAvailable || !this.rollupsState) return;
    return structuredClone(this.rollupsState);
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
