import type {
  Account,
  AccountUsage,
  PlanningSettings,
} from "../../shared/types";
import {
  PACE_WINDOW_MS,
  observedRate,
  paceFactor,
  plannedRate,
  replanStarts,
} from "../../shared/adaptive-plan";
import type { Forecast } from "../../shared/capacity-plan";
import {
  WINDOW_MS,
  dayPlan,
  planContext,
  shiftDate,
  type DayPlan,
  type PlanContext,
} from "../../shared/day-plan";
import { liveForecast, type LiveInput } from "../../shared/live-forecast";
import { localDate } from "../../shared/planning";
import type { Tempo } from "../../shared/tempo";
import { freshUsage } from "../../shared/usage";
import type { UsageSample } from "../../shared/usage-statistics";

const MINUTE_MS = 60_000;
/** At most one search this often. */
export const SEARCH_EVERY_MS = 15 * MINUTE_MS;
/** At most one notice this often. */
export const NOTIFY_EVERY_MS = 30 * MINUTE_MS;
// This many more minutes without quota than the plan makes a forecast worse.
const WORSE_BY_MINUTES = 5;

export interface AdaptiveInput {
  /** Planned accounts only (deleted ones filtered out). */
  settings: PlanningSettings;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  tempo: Tempo;
  /** Raw usage samples of the last hour: today's pace. */
  recentSamples: UsageSample[];
  /** The account Claude Desktop uses now. */
  activeId?: string;
  /** Accounts the keeper cannot start now; they keep their default start. */
  blocked: string[];
  now: number;
}
export interface AdaptiveNotice {
  kind: "updated" | "normal";
  schedule: Record<string, number>;
}
export interface AdaptiveResult {
  /** accountId → next window start, only where it differs from the default. */
  schedule: Record<string, number>;
  /** Today's pace multiplier for the tempo. */
  factor: number;
  /** Pro units an hour over the last hour, when observed long enough. */
  observedRate?: number;
  /** When the current schedule was adopted. */
  since?: number;
  /** Set when the user should hear about a change (already throttled). */
  notice?: AdaptiveNotice;
}

type Schedule = Record<string, number>;
const empty = (schedule: Schedule) => !Object.keys(schedule).length;
/** The accounts and their times, comparable across objects. */
const key = (schedule: Schedule) =>
  Object.entries(schedule)
    .map(([id, time]) => `${id}@${time}`)
    .sort()
    .join(",");
const unmet = (forecast: Forecast) => Math.round(forecast.unmet * 2) / 2;
/** Strictly better on unmet demand (to half a Pro unit), then on switches. */
const beats = (a: Forecast, b: Forecast) =>
  unmet(a) < unmet(b) || (unmet(a) === unmet(b) && a.switches < b.switches);

/** The plan's own forecast in [from, to): minutes without quota and switches. */
function planAfter(forecast: Forecast, from: number, to: number) {
  let outage = 0;
  let switches = 0;
  let last: string | undefined;
  for (const s of forecast.segments) {
    if (s.to <= from || s.from >= to) continue;
    if (!s.accountId) outage += Math.min(s.to, to) - Math.max(s.from, from);
    else {
      if (last !== undefined && s.accountId !== last) switches++;
      last = s.accountId;
    }
  }
  return { outageMinutes: outage / MINUTE_MS, switches };
}

/** Yesterday's or today's plan whose work interval holds `now`. */
function planAt(
  { settings, usage, now }: AdaptiveInput,
  context: PlanContext,
): DayPlan | undefined {
  // Live resets place the window chain as the Planning page draws it.
  const live = Object.fromEntries(
    Object.entries(usage).map(([id, u]) => [
      id,
      Date.parse(u.fiveHour?.resetsAt ?? "") || undefined,
    ]),
  );
  const today = localDate(now, settings.timeZone);
  for (const delta of [-1, 0]) {
    const plan = dayPlan(shiftDate(today, delta), settings, context, live);
    if (
      plan.interval &&
      plan.forecast &&
      plan.interval.start <= now &&
      now < plan.interval.end
    )
      return plan;
  }
}

/**
 * Each planned account's next window start for the rest of the work
 * interval, re-chosen only when the live forecast falls behind the plan's own
 * (at most every 15 minutes). A search result is adopted only when strictly
 * better than the schedule held, and the schedule is dropped once the default
 * does as well. Kept in memory; the keeper updates it before its decisions.
 */
export class AdaptiveSchedule {
  private schedule: Schedule = {};
  /** Per scheduled account: the reset of the window it had open at adoption. */
  private openAtAdoption: Record<string, number> = {};
  private since?: number;
  private date?: string;
  private lastUpdate?: number;
  private lastSearch?: number;
  private lastNotice?: number;
  private last: AdaptiveResult = { schedule: {}, factor: 1 };
  private readonly now: () => number;
  private readonly search: typeof replanStarts;
  constructor(
    options: { now?: () => number; search?: typeof replanStarts } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.search = options.search ?? replanStarts;
  }

  update(input: AdaptiveInput): AdaptiveResult {
    const { settings, usage, now } = input;
    // A clock moved back leaves every kept time meaningless.
    if (this.lastUpdate !== undefined && now < this.lastUpdate) {
      this.restart();
      // The last notice counts as just now.
      if (this.lastNotice !== undefined)
        this.lastNotice = Math.min(this.lastNotice, now);
    }
    this.lastUpdate = now;
    const on = settings.adaptive !== false && settings.autoStart;
    const context = planContext(input.accounts, input.tempo);
    const plan = on ? planAt(input, context) : undefined;
    if (plan && plan.date !== this.date) {
      this.restart();
      this.date = plan.date;
    }
    // Dropped quietly: starts whose time came (the keeper starts them now),
    // accounts used by hand, accounts no longer planned, and outside work
    // whatever is left.
    const planned = new Set(settings.accounts.map((a) => a.id));
    for (const [id, time] of Object.entries(this.schedule))
      if (
        (on && !plan) ||
        time <= now ||
        !planned.has(id) ||
        this.usedByHand(id, usage[id], now)
      )
        this.remove(id);
    const before = key(this.schedule);
    let factor = 1;
    let observed: number | undefined;
    // Turned off: dropped, and the user hears the plan is normal again.
    if (!plan) this.clear();
    else {
      const from = now - PACE_WINDOW_MS;
      observed = observedRate({
        samples: input.recentSamples,
        accounts: input.accounts.filter((a) => planned.has(a.id)),
        from,
        // `to` is exclusive: a sample read just now counts.
        to: now + 1,
      });
      factor = paceFactor(
        observed,
        plannedRate(input.tempo, settings, from, now),
      );
      const live = {
        plan,
        settings,
        context,
        usage,
        activeId: input.activeId,
        now,
        factor,
      } satisfies LiveInput;
      let current = liveForecast({ ...live, schedule: this.schedule })!;
      const reference = planAfter(plan.forecast!, now, plan.interval!.end);
      const worse =
        current.outageMinutes >= reference.outageMinutes + WORSE_BY_MINUTES ||
        current.switches > reference.switches;
      if (
        worse &&
        (this.lastSearch === undefined ||
          now - this.lastSearch >= SEARCH_EVERY_MS)
      ) {
        this.lastSearch = now;
        const replan = this.search({ ...live, blocked: input.blocked });
        if (replan && beats(replan.forecast, current)) {
          this.adopt(replan.schedule, usage, now);
          current = replan.forecast;
        }
      }
      // The pace dropped, or the day turned out fine: the default does as well.
      if (!empty(this.schedule) && !beats(current, liveForecast(live)!))
        this.clear();
    }
    return this.finish(now, before, factor, observed);
  }

  /** The last result without its notice, less any start whose time has come. */
  current(): AdaptiveResult {
    const now = this.now();
    const { since, ...rest } = this.last;
    const schedule = Object.fromEntries(
      Object.entries(rest.schedule).filter(([, time]) => time > now),
    );
    return {
      ...rest,
      schedule,
      ...(since === undefined || empty(schedule) ? {} : { since }),
    };
  }

  private finish(
    now: number,
    before: string,
    factor: number,
    observed: number | undefined,
  ): AdaptiveResult {
    this.last = {
      schedule: { ...this.schedule },
      factor,
      ...(observed === undefined ? {} : { observedRate: observed }),
      ...(this.since === undefined ? {} : { since: this.since }),
    };
    if (
      key(this.schedule) === before ||
      (this.lastNotice !== undefined && now - this.lastNotice < NOTIFY_EVERY_MS)
    )
      return this.last;
    this.lastNotice = now;
    return {
      ...this.last,
      notice: {
        kind: empty(this.schedule) ? "normal" : "updated",
        schedule: { ...this.schedule },
      },
    };
  }

  /** The account runs a window opened after the adoption: someone used it. */
  private usedByHand(id: string, usage: AccountUsage | undefined, now: number) {
    if (this.since === undefined || !freshUsage(usage, now)) return false;
    const reset = Date.parse(usage.fiveHour?.resetsAt ?? "");
    if (!Number.isFinite(reset)) return false;
    const opened = this.openAtAdoption[id];
    // Still the window it had open at the adoption.
    if (opened !== undefined && opened > now) return false;
    return reset - WINDOW_MS >= this.since;
  }

  private adopt(
    schedule: Schedule,
    usage: Record<string, AccountUsage>,
    now: number,
  ) {
    this.clear();
    for (const [id, time] of Object.entries(schedule)) {
      this.schedule[id] = time;
      const u = usage[id];
      const reset = freshUsage(u, now)
        ? Date.parse(u.fiveHour?.resetsAt ?? "")
        : NaN;
      if (Number.isFinite(reset)) this.openAtAdoption[id] = reset;
    }
    if (!empty(this.schedule)) this.since = now;
  }

  private remove(id: string) {
    delete this.schedule[id];
    delete this.openAtAdoption[id];
    if (empty(this.schedule)) this.since = undefined;
  }

  private clear() {
    this.schedule = {};
    this.openAtAdoption = {};
    this.since = undefined;
  }

  /** A new plan date or a clock moved back: nothing kept still applies. */
  private restart() {
    this.clear();
    this.lastSearch = undefined;
  }
}
