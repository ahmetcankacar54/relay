import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Account, AccountUsage } from "../../shared/types";
import {
  MAX_USAGE_SAMPLES,
  USAGE_HISTORY_DAYS,
  usageIdentity,
  usageSample,
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
    version: z.union([z.literal(1), z.literal(2)]),
    hours: z.record(identityKey, z.record(z.iso.datetime(), hourSchema)),
    windows: z.record(identityKey, z.array(windowRecordSchema)),
    hits: z.array(hitSchema),
    last: z.record(identityKey, sampleSchema),
  })
  .strict();
// 50,000 samples of ~340 bytes each, and a day of appends after them, must stay
// readable after they are written.
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_ROLLUPS_BYTES = 16 * 1024 * 1024;
/** The ledger is rewritten with its retained window at startup and then at most this often. */
export const USAGE_COMPACTION_MS = 86_400_000;

// This ledger contains only verified quota metadata, never messages or tokens.
// Each sample is appended to usage-history.jsonl as one line, without an fsync;
// compaction rewrites the file atomically with the 14-day window. A line a
// crash cut short, or one that is not a valid sample, is skipped. A ledger
// whose lines hold no sample at all, or that cannot be read safely, stays
// unavailable rather than silently overwriting it. usage-history.json, the
// ledger before 0.11, is merged in once and kept as usage-history.json.migrated.
// Rollups keep 90 days of hourly aggregates beside the 14-day raw ledger; an
// unreadable rollups file is likewise never overwritten and never affects the
// raw ledger or live limits. An unavailable raw ledger does not stop the
// rollups: new samples are still folded and persisted. A failed rollups write
// keeps the folded state in memory and is retried on the next record; only an
// unsafe target (symlink or non-file) makes the rollups unavailable.
class UnsafeUsageFileError extends Error {}

export class UsageHistory {
  /** usage-history.jsonl: one sample per line, oldest first. */
  readonly file: string;
  /** usage-history.json, the ledger before 0.11. */
  readonly legacyFile: string;
  readonly rollupsFile: string;
  private samples: UsageSample[] = [];
  /** The ledger is readable and writable. */
  historyAvailable = true;
  /** When the ledger was last rewritten with its retained window. */
  private compactedAt: number;
  private rollupsState: UsageRollups | undefined;
  /** In-memory rollups differ from usage-rollups.json. */
  private rollupsDirty = false;
  rollupsAvailable = true;
  constructor(
    readonly root: string,
    private now = Date.now,
  ) {
    this.file = path.join(root, "usage-history.jsonl");
    this.legacyFile = path.join(root, "usage-history.json");
    this.rollupsFile = path.join(root, "usage-rollups.json");
    this.compactedAt = this.now();
    try {
      this.samples = this.load();
    } catch {
      this.historyAvailable = false;
    }
    try {
      const value = this.readPrivateJsonFile(
        this.rollupsFile,
        MAX_ROLLUPS_BYTES,
      );
      const parsed =
        value === undefined ? undefined : rollupsSchema.parse(value);
      if (parsed?.version === 2) {
        const loaded: UsageRollups = { ...parsed, version: 2 };
        // Catch up samples recorded after the last successful rollups write,
        // and clamp last samples stamped later than now (the clock moved back).
        this.rollupsState = catchUp(
          loaded,
          this.historyAvailable ? this.samples : [],
          this.now(),
        );
        this.rollupsDirty = this.rollupsState !== loaded;
      } else if (!this.historyAvailable)
        throw new Error("No readable usage history to backfill from.");
      else {
        // Missing, or version 1 (coverage counted differently): rebuild from
        // the raw ledger. Version 1 history beyond the raw 14 days is lost.
        this.rollupsState = foldSamples(this.samples, this.now());
        this.rollupsDirty = true;
      }
    } catch {
      this.rollupsAvailable = false;
      this.rollupsState = undefined;
    }
    if (this.rollupsDirty) this.persistRollups();
  }
  /**
   * The retained samples of the ledger and of one from before 0.11, compacted into
   * usage-history.jsonl. The old file is set aside only once its samples are written.
   */
  private load(): UsageSample[] {
    const appended = this.readLedger(this.file);
    const legacy = this.readPrivateJsonFile(this.legacyFile, MAX_HISTORY_BYTES);
    if (appended === undefined && legacy === undefined) return [];
    const samples = this.pruned([
      ...(legacy === undefined ? [] : historySchema.parse(legacy).samples),
      ...(appended ?? []),
    ]);
    this.compact(samples);
    if (legacy !== undefined)
      try {
        fs.renameSync(this.legacyFile, `${this.legacyFile}.migrated`);
      } catch {
        // Merged again at the next start: duplicates are dropped.
      }
    return samples;
  }
  /** The valid samples of a JSONL ledger; undefined when it does not exist. */
  private readLedger(file: string): UsageSample[] | undefined {
    const text = this.readPrivateFile(file, MAX_HISTORY_BYTES);
    if (text === undefined) return undefined;
    const lines = text.split("\n");
    // After the last newline: nothing, or a line a crash cut short.
    lines.pop();
    const samples: UsageSample[] = [];
    let complete = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      complete++;
      try {
        const parsed = sampleSchema.safeParse(JSON.parse(line));
        if (parsed.success) samples.push(parsed.data);
      } catch {
        // Not JSON: skipped.
      }
    }
    // Lines, but not one sample among them: not a ledger to overwrite.
    if (complete && !samples.length) throw new Error("Invalid usage history.");
    return samples;
  }
  /** Rewrites the ledger atomically with `samples`. */
  private compact(samples: UsageSample[]) {
    this.writePrivateFile(
      this.file,
      samples.map((sample) => JSON.stringify(sample) + "\n").join(""),
    );
    this.compactedAt = this.now();
  }
  /** Appends one sample as a line; compaction, not each append, makes the file durable. */
  private append(sample: UsageSample) {
    privateDir(this.root);
    try {
      const target = fs.lstatSync(this.file);
      if (!target.isFile() || target.isSymbolicLink())
        throw new UnsafeUsageFileError("Invalid usage file.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const fd = fs.openSync(
      this.file,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (!fs.fstatSync(fd).isFile())
        throw new UnsafeUsageFileError("Invalid usage file.");
      fs.writeFileSync(fd, JSON.stringify(sample) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  }
  /** Adds `sample` in time order and drops what the retention no longer keeps. */
  private insert(sample: UsageSample) {
    const at = Date.parse(sample.checkedAt);
    let index = this.samples.length;
    while (index > 0 && Date.parse(this.samples[index - 1].checkedAt) > at)
      index--;
    this.samples.splice(index, 0, sample);
    const oldest = this.now() - USAGE_HISTORY_DAYS * 86_400_000;
    let drop = Math.max(0, this.samples.length - MAX_USAGE_SAMPLES);
    while (
      drop < this.samples.length &&
      Date.parse(this.samples[drop].checkedAt) < oldest
    )
      drop++;
    if (drop) this.samples.splice(0, drop);
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
    const text = this.readPrivateFile(file, maxBytes);
    return text === undefined ? undefined : JSON.parse(text);
  }
  /** The file's text, or undefined when it does not exist. */
  private readPrivateFile(file: string, maxBytes: number): string | undefined {
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
      return fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  }
  private writePrivateJsonFile(file: string, value: unknown): void {
    this.writePrivateFile(file, JSON.stringify(value));
  }
  /** Atomic private write that refuses to replace a non-file or symlink. */
  private writePrivateFile(file: string, text: string): void {
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
        fs.writeFileSync(fd, text);
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
    const sample = usageSample(account, usage);
    if (!sample || Date.parse(sample.checkedAt) > this.now()) return;
    if (this.historyAvailable) {
      let previous: UsageSample | undefined;
      for (let i = this.samples.length - 1; i >= 0 && !previous; i--) {
        const s = this.samples[i];
        if (s.accountId === sample.accountId && s.identity === sample.identity)
          previous = s;
      }
      if (
        previous &&
        Date.parse(previous.checkedAt) >= Date.parse(sample.checkedAt)
      )
        return;
      try {
        this.insert(sample);
        const sinceCompaction = this.now() - this.compactedAt;
        if (sinceCompaction < 0 || sinceCompaction >= USAGE_COMPACTION_MS) {
          this.samples = this.pruned(this.samples);
          this.compact(this.samples);
        } else this.append(sample);
      } catch {
        this.historyAvailable = false;
      }
    }
    // The rollups reject duplicate and out-of-order samples on their own.
    if (!this.rollupsAvailable || !this.rollupsState) return;
    const folded = foldSample(this.rollupsState, sample, this.now());
    if (folded === this.rollupsState && !this.rollupsDirty) return;
    this.rollupsState = folded;
    this.persistRollups();
  }
  /** Copies of the raw samples checked at or after `since`, oldest first. */
  recentSamples(since: number): UsageSample[] {
    if (!this.historyAvailable) return [];
    // The samples are in time order: walk back from the newest.
    let first = this.samples.length;
    while (first > 0 && Date.parse(this.samples[first - 1].checkedAt) >= since)
      first--;
    return structuredClone(this.samples.slice(first));
  }
  /** 90-day hourly rollups; undefined when the rollups file is unavailable. */
  rollups(): UsageRollups | undefined {
    if (!this.rollupsAvailable || !this.rollupsState) return;
    return structuredClone(this.rollupsState);
  }
  /** Reset dates survive a cache invalidation, without reviving old quota. */
  lastKnownResets(account: Account): AccountUsage["lastKnownResets"] {
    if (!this.historyAvailable) return;
    const identity = usageIdentity(account);
    if (!identity) return;
    const now = this.now();
    const oldest = now - USAGE_HISTORY_DAYS * 86_400_000;
    type Reset = NonNullable<AccountUsage["lastKnownResets"]>["fiveHour"];
    let fiveHour: Reset;
    let sevenDay: Reset;
    // Runs on every snapshot: the samples are already deduplicated and in
    // time order, so scan back from the newest and stop at the retention.
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const sample = this.samples[i];
      if (sample.accountId !== account.id || sample.identity !== identity)
        continue;
      const checkedAt = Date.parse(sample.checkedAt);
      if (checkedAt < oldest) break;
      if (checkedAt > now) continue;
      const reset = (key: "fiveHour" | "sevenDay") =>
        sample[key]?.resetsAt
          ? { resetsAt: sample[key].resetsAt, checkedAt: sample.checkedAt }
          : undefined;
      fiveHour ??= reset("fiveHour");
      sevenDay ??= reset("sevenDay");
      if (fiveHour && sevenDay) break;
    }
    if (!fiveHour && !sevenDay) return;
    return {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {}),
    };
  }
}
