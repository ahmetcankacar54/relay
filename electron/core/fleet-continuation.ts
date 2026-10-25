import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  Account,
  AccountUsage,
  DesktopState,
  FleetContinuationState,
  RelaySettings,
} from "../../shared/types";
import { continuationTargetReadinessReason } from "../../shared/continuation-readiness";
import { rankContinuationTargets } from "../../shared/continuation-target-ranking";
import { SOURCE_FRESH_MS, sourceExhausted } from "../../shared/usage";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";
import type { QuotaStop } from "./desktop-continuation-evidence";
import { DesktopSwitchRefused } from "./desktop";

export { sourceExhausted } from "../../shared/usage";

/** Outcome of one conversation's continuation. "unknown" is never retried. */
export type FleetResult = "started" | "accepted" | "unknown" | "skipped";

export interface FleetDeps {
  directory: string;
  now?: () => number;
  snapshot(): {
    accounts: Account[];
    settings: RelaySettings;
    usage: Record<string, AccountUsage>;
    /** Pro units per hour now (the tempo); absent means unknown. */
    tempoRate?: number;
  };
  desktop(): Promise<DesktopState>;
  /** Another Relay operation (sign-in, single-conversation watch…) owns Claude now. */
  busy(): boolean;
  /**
   * Reads the account's usage from the server now, past its short success cache. Without it a
   * stop newer than the last reading waits for the next scheduled one.
   */
  refreshUsage?(accountId: string): Promise<unknown>;
  stops(account: Account): Promise<QuotaStop[]>;
  /** Reason restarting Claude would interrupt other work, or undefined. */
  quiet(stops: QuotaStop[]): Promise<string | undefined>;
  quietSync(stops: QuotaStop[]): string | undefined;
  unchanged(stop: QuotaStop): boolean;
  /** Reason the UI automation cannot continue conversations, or undefined. */
  automationReady(): Promise<string | undefined>;
  /** Throws `DesktopSwitchRefused` when a guard called the switch off before Claude quit. */
  switchTo(
    targetId: string,
    guards: { canProceed: () => boolean; beforeQuit: () => Promise<void> },
  ): Promise<void>;
  /** Reopen, verify and send once. `beforeSend` must run right before the send. */
  continueOne(
    stop: QuotaStop,
    target: Account,
    requestId: string,
    beforeSend: () => void,
  ): Promise<FleetResult>;
  withDesktopLock<T>(action: () => Promise<T>): Promise<T>;
  changed(): void;
  /**
   * A diagnosis log: each change of the fleet's state with what it waited on, and how each
   * conversation's continuation ended. Fields are ids cut to 8 characters, states, reasons,
   * counts and process names; never a conversation's text.
   */
  log?(event: string, fields: Record<string, unknown>): void;
  /** What the last `quiet` found running, for the log: transcripts and process names. */
  quietDetail?(): Record<string, unknown>;
  /** A switch and its continuations are over: what became of them, to tell the user. */
  finished?(last: NonNullable<FleetContinuationState["last"]>, reason?: string): void;
}

/** An id for the diagnosis log: its first 8 characters, which tell two apart. */
const short = (id: string | undefined) => (id ? id.slice(0, 8) : null);

interface Pending {
  id: string;
  key: string;
  sourceId: string;
  targetId: string;
  stops: QuotaStop[];
  stage: "switching" | "continuing";
  results: Record<string, FleetResult | "sending">;
  startedAt: number;
}
interface Saved {
  version: 1;
  enabled: boolean;
  /** Stops (account:conversation:turn) already handled; never handled twice. */
  handled: string[];
  pending?: Pending;
  last?: FleetContinuationState["last"];
}

const stopKey = (account: Account, stop: QuotaStop) =>
  `${account.desktop!.accountUuid.toLowerCase()}:${stop.cliSessionId}:${stop.turnId}`;

/**
 * How long a quota-stop scan is reused while the source's quota state holds: a stop is seen
 * within this long of happening, before its usage is read again. The scan reads only what
 * transcripts gained since the last one.
 */
export const FLEET_SCAN_MS = 20_000;
/** The least time between two usage reads the fleet asks for, per source. */
export const FLEET_REREAD_MS = 60_000;
/** A stop newer than the source's last usage reading, or one with no reading: it is out of date. */
function stoppedSinceReading(stops: QuotaStop[], usage: AccountUsage | undefined) {
  const checked = Date.parse(usage?.checkedAt ?? "");
  return stops.some((stop) => !Number.isFinite(checked) || stop.stoppedAt > checked);
}
/**
 * What a reading under 15 minutes old says about the source: out of quota ("full"), not
 * ("room"), or there is no such reading ("unknown").
 */
type SourceQuota = "full" | "room" | "unknown";
function sourceQuota(
  usage: AccountUsage | undefined,
  now: number,
): SourceQuota {
  if (sourceExhausted(usage, now)) return "full";
  const checked = Date.parse(usage?.checkedAt ?? "");
  return usage?.status === "ready" &&
    !usage.stale &&
    Number.isFinite(checked) &&
    checked <= now &&
    now - checked <= SOURCE_FRESH_MS
    ? "room"
    : "unknown";
}

/**
 * Best eligible target: the open window resetting soonest among accounts with
 * quota for half an hour at the tempo (`rate`, Pro units per hour), else by
 * plan capacity × smallest remaining quota.
 */
export function chooseTarget(
  source: Account,
  accounts: Account[],
  settings: RelaySettings,
  usage: Record<string, AccountUsage>,
  now: number,
  rate?: number,
) {
  const eligible = accounts.filter(
    (account) =>
      account.id !== source.id &&
      !continuationTargetReadinessReason(
        source,
        account,
        usage[account.id],
        settings,
        now,
      ),
  );
  return rankContinuationTargets(
    eligible.map((account) => ({ account, usage: usage[account.id] })),
    { now, rate },
  )[0]?.account;
}

/**
 * The notification after the fleet switched Claude to `name` at the limit: how many
 * conversations go on, and how many the user must continue or check. Counts only.
 */
export function fleetNotice(
  last: NonNullable<FleetContinuationState["last"]>,
  name: string,
  language: "tr" | "en",
  reason?: string,
): string {
  const en = language === "en";
  const head = en
    ? `Out of quota: Claude switched to ${name}.`
    : `Kota doldu: Claude ${name} hesabına geçti.`;
  const chats = (n: number) => `${n} ${n === 1 ? "conversation" : "conversations"}`;
  const go = (n: number) => `${chats(n)} ${n === 1 ? "continues" : "continue"}`;
  if (reason || last.started + last.uncertain + last.skipped === 0)
    return en
      ? `${head} Its conversations were not continued; continue them yourself.`
      : `${head} Sohbetler devam ettirilemedi; onları sen sürdür.`;
  if (last.started === last.conversations)
    return en
      ? `${head} ${go(last.started)} where ${last.started === 1 ? "it" : "they"} stopped.`
      : `${head} ${last.started} sohbet kaldığı yerden devam ediyor.`;
  const parts = en
    ? [
        last.started ? go(last.started) : "",
        last.skipped ? `continue ${chats(last.skipped)} yourself` : "",
        last.uncertain ? `check ${chats(last.uncertain)}` : "",
      ]
    : [
        last.started ? `${last.started} sohbet devam ediyor` : "",
        last.skipped ? `${last.skipped} sohbeti sen sürdür` : "",
        last.uncertain ? `${last.uncertain} sohbetin durumuna bak` : "",
      ];
  const text = parts.filter(Boolean).join("; ");
  return `${head} ${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * When the active Desktop account runs out of quota, waits until nothing else is
 * working, switches Claude to the best other account once and sends one
 * continuation message to every conversation that stopped at the limit. It stays
 * on for later limits (A → B → A) and never returns to an account that is still
 * out of quota.
 */
export class FleetContinuation {
  private saved: Saved;
  private view: FleetContinuationState = { enabled: false, status: "off" };
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  /** The last quota-stop scan, reused for a minute while the source and its quota state hold. */
  private scan?: {
    sourceId: string;
    quota: SourceQuota;
    at: number;
    stops: QuotaStop[];
  };
  /** When the fleet last asked for a usage read of each account. */
  private rereads = new Map<string, number>();
  private readonly file: string;
  private readonly now: () => number;
  constructor(private readonly deps: FleetDeps) {
    this.now = deps.now ?? Date.now;
    privateJournalDirectory(deps.directory);
    this.file = path.join(deps.directory, "fleet-state.json");
    let saved: Saved | undefined;
    try {
      const value = readPrivateJson(this.file) as Saved;
      if (value?.version === 1 && Array.isArray(value.handled)) saved = value;
    } catch {
      // Missing or unreadable: start off.
    }
    this.saved = saved ?? { version: 1, enabled: false, handled: [] };
    // A send that was about to happen when Relay stopped is never repeated.
    for (const [id, result] of Object.entries(
      this.saved.pending?.results ?? {},
    ))
      if (result === "sending") this.saved.pending!.results[id] = "unknown";
    this.view = {
      enabled: this.saved.enabled,
      status: this.saved.enabled ? "watching" : "off",
      last: this.saved.last,
    };
  }
  snapshot(): FleetContinuationState {
    return structuredClone(this.view);
  }
  get enabled() {
    return this.saved.enabled;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  setEnabled(enabled: boolean) {
    this.scan = undefined;
    this.save({ ...this.saved, enabled });
    return this.publish(
      enabled
        ? { status: "watching", reason: "checking" }
        : { status: "off", reason: undefined },
    );
  }
  private save(next: Saved) {
    next.handled = next.handled.slice(-300);
    writePrivateJson(this.file, next);
    this.saved = next;
  }
  /**
   * Tells the windows only when the state changed, not for a new check time alone, and logs
   * the change with `detail`: what the fleet waited on.
   */
  private publish(
    fields: Partial<FleetContinuationState> &
      Pick<FleetContinuationState, "status">,
    detail?: Record<string, unknown>,
  ) {
    const previous = { ...this.view, checkedAt: undefined };
    this.view = {
      enabled: this.saved.enabled,
      last: this.saved.last,
      checkedAt: new Date(this.now()).toISOString(),
      ...fields,
    };
    if (
      JSON.stringify(previous) !==
      JSON.stringify({ ...this.view, checkedAt: undefined })
    ) {
      this.deps.changed();
      this.logEvent("state", {
        status: this.view.status,
        reason: this.view.reason ?? null,
        source: short(this.view.sourceId),
        target: short(this.view.targetId),
        stopped: this.view.stopped ?? null,
        ...detail,
      });
    }
    return this.snapshot();
  }
  private logEvent(event: string, fields: Record<string, unknown>) {
    try {
      this.deps.log?.(event, fields);
    } catch {
      // The log is an aid, never a part of a switch.
    }
  }
  /** Each other account and why it cannot take over now, or `ok`, for the log. */
  private targetReasons(
    source: Account,
    accounts: Account[],
    settings: RelaySettings,
    usage: Record<string, AccountUsage>,
    now: number,
  ) {
    return accounts
      .filter((account) => account.id !== source.id)
      .map(
        (account) =>
          `${short(account.id)}:${
            continuationTargetReadinessReason(
              source,
              account,
              usage[account.id],
              settings,
              now,
            ) ?? "ok"
          }`,
      )
      .join(" ");
  }
  /**
   * No account can take over only because its last reading is too old: read those again now,
   * each at most once a minute. Whether any was read.
   */
  private async readTargetsAgain(
    source: Account,
    accounts: Account[],
    settings: RelaySettings,
    usage: Record<string, AccountUsage>,
    now: number,
  ) {
    let read = false;
    for (const account of accounts)
      if (
        account.id !== source.id &&
        continuationTargetReadinessReason(
          source,
          account,
          usage[account.id],
          settings,
          now,
        ) === "quota-not-fresh" &&
        (await this.readAgain(account.id))
      )
        read = true;
    return read;
  }
  async tick(): Promise<FleetContinuationState> {
    if (this.running) return this.snapshot();
    this.running = true;
    try {
      if (this.saved.pending) return await this.resume(this.saved.pending);
      if (!this.saved.enabled) return this.publish({ status: "off" });
      return await this.evaluate();
    } catch (error) {
      return this.publish({
        status: "attention",
        reason: error instanceof Error ? error.message : "monitor-failed",
      });
    } finally {
      this.running = false;
    }
  }
  private async evaluate(): Promise<FleetContinuationState> {
    const desktop = await this.deps.desktop();
    if (!desktop.available)
      return this.publish({ status: "waiting", reason: "desktop-unavailable" });
    if (
      desktop.busy ||
      desktop.recoveryRequired ||
      !!desktop.pendingProfileId ||
      this.deps.busy()
    )
      return this.publish({ status: "waiting", reason: "desktop-busy" });
    const { accounts, settings, usage, tempoRate } = this.deps.snapshot();
    const source = accounts.find((a) => a.id === desktop.activeProfileId);
    if (!source?.desktop)
      return this.publish({ status: "waiting", reason: "source-not-enrolled" });
    const now = this.now();
    let quota = sourceQuota(usage[source.id], now);
    let stops = (await this.quotaStops(source, quota, now)).filter(
      (stop) => !this.saved.handled.includes(stopKey(source, stop)),
    );
    // A conversation that stopped at the limit after the last reading makes that reading
    // out of date: a 99 % read a minute before the stop must not hold the switch until the
    // next scheduled read. Read again now, at most once a minute.
    if (
      quota !== "full" &&
      stoppedSinceReading(stops, usage[source.id]) &&
      (await this.readAgain(source.id))
    )
      quota = sourceQuota(this.deps.snapshot().usage[source.id], this.now());
    // While a fresh reading shows room, no conversation waits for another account.
    if (quota === "room") stops = [];
    const detail = { quota };
    if (!stops.length) {
      // Name the account the fleet would pick while the active one is full, so
      // the UI can offer it. Nothing switches until a conversation stops.
      const target =
        quota === "full"
          ? chooseTarget(source, accounts, settings, usage, now, tempoRate)
          : undefined;
      return this.publish(
        {
          status: "watching",
          reason: "awaiting-quota-stop",
          sourceId: source.id,
          stopped: 0,
          ...(target ? { targetId: target.id } : {}),
        },
        detail,
      );
    }
    const base = { sourceId: source.id, stopped: stops.length };
    if (quota !== "full")
      return this.publish(
        { ...base, status: "waiting", reason: "source-quota-unconfirmed" },
        detail,
      );
    let target = chooseTarget(
      source,
      accounts,
      settings,
      usage,
      now,
      tempoRate,
    );
    // An account whose reading is only too old is read again now rather than at its turn.
    if (
      !target &&
      (await this.readTargetsAgain(source, accounts, settings, usage, now))
    ) {
      const fresh = this.deps.snapshot();
      target = chooseTarget(
        source,
        fresh.accounts,
        fresh.settings,
        fresh.usage,
        this.now(),
        fresh.tempoRate,
      );
    }
    if (!target) {
      const fresh = this.deps.snapshot();
      return this.publish(
        { ...base, status: "waiting", reason: "no-target" },
        {
          ...detail,
          targets: this.targetReasons(
            source,
            fresh.accounts,
            fresh.settings,
            fresh.usage,
            this.now(),
          ),
        },
      );
    }
    const busy = await this.deps.quiet(stops);
    if (busy)
      return this.publish(
        { ...base, targetId: target.id, status: "waiting", reason: busy },
        { ...detail, ...this.deps.quietDetail?.() },
      );
    const automation = await this.deps.automationReady();
    if (automation)
      return this.publish(
        { ...base, targetId: target.id, status: "attention", reason: automation },
        detail,
      );
    return this.deps.withDesktopLock(async () => {
      // Recheck under the lock: a new turn or task may have started meanwhile.
      // From here on only this fresh scan counts; the one above may be a minute old.
      const current = (await this.scanStops(source, quota, this.now())).filter(
        (stop) => !this.saved.handled.includes(stopKey(source, stop)),
      );
      const key = (list: QuotaStop[]) =>
        list
          .map((stop) => stopKey(source, stop))
          .sort()
          .join(",");
      if (key(current) !== key(stops) || (await this.deps.quiet(current)))
        return this.publish({
          ...base,
          status: "waiting",
          reason: "context-changed",
        });
      const pending: Pending = {
        id: randomUUID(),
        key: key(current),
        sourceId: source.id,
        targetId: target.id,
        stops: current,
        stage: "switching",
        results: {},
        startedAt: now,
      };
      this.save({ ...this.saved, pending });
      this.publish({ ...base, targetId: target.id, status: "switching" });
      const stillSafe = () =>
        !this.deps.quietSync(current) &&
        current.every((stop) => this.deps.unchanged(stop));
      try {
        await this.deps.switchTo(target.id, {
          canProceed: stillSafe,
          beforeQuit: async () => {
            if (
              (await this.deps.quiet(current)) ||
              !current.every((stop) => this.deps.unchanged(stop))
            )
              throw new DesktopSwitchRefused("work-started");
          },
        });
      } catch (error) {
        const after = await this.deps.desktop().catch(() => undefined);
        if (after?.activeProfileId !== target.id) {
          if (error instanceof DesktopSwitchRefused) {
            // Called off before Claude quit, often by a task notification landing in a
            // stopped transcript: nothing restarted, so the next tick scans these again.
            this.scan = undefined;
            this.save({ ...this.saved, pending: undefined });
            return this.publish({
              ...base,
              targetId: target.id,
              status: "waiting",
              reason: "context-changed",
            });
          }
          // Not switched, and a quit or a write may have happened. Never retry this
          // limit automatically: a persistent failure must not restart Claude again and again.
          this.save({
            ...this.saved,
            pending: undefined,
            handled: [
              ...this.saved.handled,
              ...current.map((stop) => stopKey(source, stop)),
            ],
          });
          return this.publish({
            ...base,
            targetId: target.id,
            status: "attention",
            reason: `switch-failed:${error instanceof Error ? error.message : "unknown"}`,
          });
        }
      }
      return this.continueAll({ ...pending, stage: "continuing" });
    });
  }
  /** Asks for a fresh usage read of `accountId`, unless one was asked for under a minute ago. Whether it read. */
  private async readAgain(accountId: string) {
    if (!this.deps.refreshUsage) return false;
    const now = this.now();
    const last = this.rereads.get(accountId);
    if (last !== undefined && now >= last && now - last < FLEET_REREAD_MS)
      return false;
    this.rereads.set(accountId, now);
    try {
      await this.deps.refreshUsage(accountId);
      return true;
    } catch {
      // The scheduled reads go on; the next stop or minute asks again.
      return false;
    }
  }
  /** The source's quota stops: the last scan while it is under a minute old for this source and quota state. */
  private quotaStops(source: Account, quota: SourceQuota, now: number) {
    const last = this.scan;
    const age = last ? now - last.at : -1;
    if (
      last?.sourceId === source.id &&
      last.quota === quota &&
      age >= 0 &&
      age < FLEET_SCAN_MS
    )
      return Promise.resolve(last.stops);
    return this.scanStops(source, quota, now);
  }
  private async scanStops(source: Account, quota: SourceQuota, now: number) {
    const stops = await this.deps.stops(source);
    this.scan = { sourceId: source.id, quota, at: now, stops };
    return stops;
  }
  private async resume(pending: Pending) {
    const desktop = await this.deps.desktop();
    if (pending.stage === "switching") {
      if (desktop.activeProfileId !== pending.targetId) {
        // Relay stopped before the switch finished; Desktop recovery owns files.
        this.save({ ...this.saved, pending: undefined });
        return this.publish({
          status: "waiting",
          reason: "switch-interrupted",
        });
      }
      pending = { ...pending, stage: "continuing" };
    }
    if (desktop.activeProfileId !== pending.targetId) {
      const source = this.deps
        .snapshot()
        .accounts.find((a) => a.id === pending.sourceId);
      return this.finish(pending, source, "account-changed");
    }
    return this.deps.withDesktopLock(() => this.continueAll(pending));
  }
  private async continueAll(pending: Pending) {
    this.save({ ...this.saved, pending });
    const { accounts } = this.deps.snapshot();
    const target = accounts.find((a) => a.id === pending.targetId);
    const source = accounts.find((a) => a.id === pending.sourceId);
    if (!target) return this.finish(pending, source, "target-missing");
    for (const [index, stop] of pending.stops.entries()) {
      if (pending.results[stop.localSessionId]) continue;
      this.publish({
        status: "continuing",
        sourceId: pending.sourceId,
        targetId: pending.targetId,
        stopped: pending.stops.length,
      });
      let result: FleetResult;
      try {
        result = await this.deps.continueOne(
          stop,
          target,
          `relay-${pending.id}-${index}`,
          () => {
            pending.results[stop.localSessionId] = "sending";
            this.save({ ...this.saved, pending });
          },
        );
      } catch {
        result =
          pending.results[stop.localSessionId] === "sending"
            ? "unknown"
            : "skipped";
      }
      pending.results[stop.localSessionId] = result;
      this.save({ ...this.saved, pending });
      this.logEvent("continued", {
        conversation: short(stop.localSessionId.replace(/^local_/, "")),
        result,
      });
    }
    return this.finish(pending, source);
  }
  private finish(
    pending: Pending,
    source: Account | undefined,
    reason?: string,
  ) {
    const results = pending.stops.map(
      (stop) => pending.results[stop.localSessionId] ?? "skipped",
    );
    const last: FleetContinuationState["last"] = {
      at: new Date(this.now()).toISOString(),
      sourceId: pending.sourceId,
      targetId: pending.targetId,
      conversations: pending.stops.length,
      started: results.filter((r) => r === "started" || r === "accepted")
        .length,
      uncertain: results.filter((r) => r === "unknown" || r === "sending")
        .length,
      skipped: results.filter((r) => r === "skipped").length,
    };
    this.save({
      ...this.saved,
      pending: undefined,
      last,
      handled: [
        ...this.saved.handled,
        ...(source?.desktop
          ? pending.stops.map((stop) => stopKey(source, stop))
          : []),
      ],
    });
    try {
      this.deps.finished?.(last, reason);
    } catch {
      // A notice that fails changes nothing about the conversations.
    }
    return this.publish({
      status: reason || last.uncertain ? "attention" : "watching",
      reason: reason ?? (last.uncertain ? "delivery-uncertain" : "continued"),
      sourceId: pending.targetId,
    });
  }
}
