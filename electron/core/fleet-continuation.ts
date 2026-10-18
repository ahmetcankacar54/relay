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
import { sourceExhausted } from "../../shared/usage";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";
import type { QuotaStop } from "./desktop-continuation-evidence";

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
  stops(account: Account): Promise<QuotaStop[]>;
  /** Reason restarting Claude would interrupt other work, or undefined. */
  quiet(stops: QuotaStop[]): Promise<string | undefined>;
  quietSync(stops: QuotaStop[]): string | undefined;
  unchanged(stop: QuotaStop): boolean;
  /** Reason the UI automation cannot continue conversations, or undefined. */
  automationReady(): Promise<string | undefined>;
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
}

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
  /** Tells the windows only when the state changed, not for a new check time alone. */
  private publish(
    fields: Partial<FleetContinuationState> &
      Pick<FleetContinuationState, "status">,
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
    )
      this.deps.changed();
    return this.snapshot();
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
    const stops = (await this.deps.stops(source)).filter(
      (stop) => !this.saved.handled.includes(stopKey(source, stop)),
    );
    const now = this.now();
    if (!stops.length) {
      // Name the account the fleet would pick while the active one is full, so
      // the UI can offer it. Nothing switches until a conversation stops.
      const target = sourceExhausted(usage[source.id], now)
        ? chooseTarget(source, accounts, settings, usage, now, tempoRate)
        : undefined;
      return this.publish({
        status: "watching",
        reason: "awaiting-quota-stop",
        sourceId: source.id,
        stopped: 0,
        ...(target ? { targetId: target.id } : {}),
      });
    }
    const base = { sourceId: source.id, stopped: stops.length };
    if (!sourceExhausted(usage[source.id], now))
      return this.publish({
        ...base,
        status: "waiting",
        reason: "source-quota-unconfirmed",
      });
    const target = chooseTarget(
      source,
      accounts,
      settings,
      usage,
      now,
      tempoRate,
    );
    if (!target)
      return this.publish({ ...base, status: "waiting", reason: "no-target" });
    const busy = await this.deps.quiet(stops);
    if (busy)
      return this.publish({
        ...base,
        targetId: target.id,
        status: "waiting",
        reason: busy,
      });
    const automation = await this.deps.automationReady();
    if (automation)
      return this.publish({
        ...base,
        targetId: target.id,
        status: "attention",
        reason: automation,
      });
    return this.deps.withDesktopLock(async () => {
      // Recheck under the lock: a new turn or task may have started meanwhile.
      const again = (await this.deps.stops(source)).filter(
        (stop) => !this.saved.handled.includes(stopKey(source, stop)),
      );
      const key = (list: QuotaStop[]) =>
        list
          .map((stop) => stopKey(source, stop))
          .sort()
          .join(",");
      if (key(again) !== key(stops) || (await this.deps.quiet(stops)))
        return this.publish({
          ...base,
          status: "waiting",
          reason: "context-changed",
        });
      const pending: Pending = {
        id: randomUUID(),
        key: key(stops),
        sourceId: source.id,
        targetId: target.id,
        stops,
        stage: "switching",
        results: {},
        startedAt: now,
      };
      this.save({ ...this.saved, pending });
      this.publish({ ...base, targetId: target.id, status: "switching" });
      const stillSafe = () =>
        !this.deps.quietSync(stops) &&
        stops.every((stop) => this.deps.unchanged(stop));
      try {
        await this.deps.switchTo(target.id, {
          canProceed: stillSafe,
          beforeQuit: async () => {
            if (
              (await this.deps.quiet(stops)) ||
              !stops.every((stop) => this.deps.unchanged(stop))
            )
              throw new Error("work-started");
          },
        });
      } catch (error) {
        const after = await this.deps.desktop().catch(() => undefined);
        if (after?.activeProfileId !== target.id) {
          // Not switched. Never retry this limit automatically: a persistent
          // failure must not restart Claude again and again.
          this.save({
            ...this.saved,
            pending: undefined,
            handled: [
              ...this.saved.handled,
              ...stops.map((stop) => stopKey(source, stop)),
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
    return this.publish({
      status: reason || last.uncertain ? "attention" : "watching",
      reason: reason ?? (last.uncertain ? "delivery-uncertain" : "continued"),
      sourceId: pending.targetId,
    });
  }
}
