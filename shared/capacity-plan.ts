import { WINDOW_MS } from "./work-hours";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
export const SIM_STEP_MS = 5 * MINUTE_MS;
const EPSILON = 1e-6;
/**
 * A run-out this close to the step's end is float noise (it depends on how
 * large the times are), so it counts as running out at the end.
 */
const RUN_OUT_SLACK_MS = 1;

export interface SimAccount {
  id: string;
  /** Pro-account multiples: a window holds `100 × capacity` Pro units. */
  capacity: number;
  /** Reset of the open window; absent means no window is open. */
  firstReset?: number;
  /** A new window starts at each reset. */
  keepAlive: boolean;
  /** Planned start of a closed window (used only while no window is open). */
  warmUp?: number;
  /** Hold the restart after the open window's reset until this time (first use starts it earlier). */
  restartAt?: number;
  /** Pro units left in the open window. */
  remaining: number;
  /** Out of reach (for example, its weekly limit is used up). */
  blocked?: boolean;
}
export interface SimInput {
  from: number;
  to: number;
  /** Demand in Pro units per hour at `time`. */
  rate: (time: number) => number;
  accounts: SimAccount[];
  /**
   * The account in use at `from`, kept first while it has quota. Without one
   * the first account is chosen when demand first arises.
   */
  active?: string;
  /**
   * Stops once this holds for the unmet demand and switches so far (both only
   * grow), with the forecast cut short: the optimizer's way to drop a
   * candidate that has already lost.
   */
  stopWhen?: (unmet: number, switches: number) => boolean;
}
/** A stretch served by one account; no `accountId` is an outage. */
export interface ForecastSegment {
  accountId?: string;
  from: number;
  to: number;
}
export interface Forecast {
  segments: ForecastSegment[];
  /** Pro units of demand nobody could serve. */
  unmet: number;
  outageMinutes: number;
  switches: number;
  exhaustedAt: Record<string, number[]>;
}

interface SimState {
  id: string;
  capacity: number;
  order: number;
  reset?: number;
  warmUp?: number;
  restartAt?: number;
  keepAlive: boolean;
  left: number;
  blocked: boolean;
}

const minute = (time: number) => Math.round(time / MINUTE_MS) * MINUTE_MS;

/**
 * One person working on one account at a time: the open account serves the
 * demand; when it runs out, the account with quota whose window resets
 * soonest takes over (closed windows last, then larger capacity, then order).
 */
export function simulateDay(input: SimInput): Forecast {
  const states: SimState[] = input.accounts.map((a, order) => ({
    id: a.id,
    capacity: a.capacity,
    order,
    reset: a.firstReset,
    warmUp: a.firstReset === undefined ? a.warmUp : undefined,
    restartAt: a.restartAt,
    keepAlive: a.keepAlive,
    left: a.remaining,
    blocked: !!a.blocked,
  }));
  const full = (s: SimState) => 100 * s.capacity;
  const advance = (time: number) => {
    for (const s of states) {
      for (;;) {
        if (
          s.reset === undefined &&
          s.warmUp !== undefined &&
          s.warmUp <= time
        ) {
          s.reset = s.warmUp + WINDOW_MS;
          s.left = full(s);
          s.warmUp = undefined;
          continue;
        }
        if (s.reset !== undefined && s.reset <= time) {
          s.left = full(s);
          if (s.restartAt !== undefined && s.restartAt > s.reset) {
            // Held: closed (full) until the restart, unless used first.
            s.warmUp = s.restartAt;
            s.reset = undefined;
          } else s.reset = s.keepAlive ? s.reset + WINDOW_MS : undefined;
          s.restartAt = undefined;
          continue;
        }
        break;
      }
    }
  };
  // Two closed windows give Infinity − Infinity = NaN, which falls through.
  const precedes = (a: SimState, b: SimState) =>
    ((a.reset ?? Infinity) - (b.reset ?? Infinity) ||
      b.capacity - a.capacity ||
      a.order - b.order) < 0;
  // Both run at every switch and gap, so neither allocates.
  const choose = () => {
    let chosen: SimState | undefined;
    for (const s of states)
      if (!s.blocked && s.left > EPSILON && (!chosen || precedes(s, chosen)))
        chosen = s;
    return chosen;
  };
  const nextEvent = (after: number) => {
    let next = Infinity;
    for (const s of states) {
      const time = s.reset ?? s.warmUp;
      if (time !== undefined && time > after && time < next) next = time;
    }
    return next;
  };

  const segments: ForecastSegment[] = [];
  const exhaustedAt: Record<string, number[]> = {};
  let unmet = 0,
    outageMs = 0,
    switches = 0;
  let lastUsed: string | undefined;
  let stopped = false;
  const check = () => {
    if (input.stopWhen?.(unmet, switches)) stopped = true;
  };
  /** The segment still running; none after a gap closes with the demand. */
  let open: ForecastSegment | undefined;
  const mark = (accountId: string | undefined, at: number) => {
    const time = minute(at);
    if (open && open.accountId === accountId) return;
    if (open) open.to = time;
    if (accountId && lastUsed && accountId !== lastUsed) {
      switches++;
      check();
    }
    if (accountId) lastUsed = accountId;
    open = { accountId, from: time, to: time };
    segments.push(open);
  };

  advance(input.from);
  let active = states.find(
    (s) => s.id === input.active && !s.blocked && s.left > EPSILON,
  );
  if (active) mark(active.id, input.from);
  let t = input.from;
  while (t < input.to && !stopped) {
    const end = Math.min(input.to, t + SIM_STEP_MS);
    advance(t);
    const perMs = Math.max(0, input.rate(t)) / HOUR_MS;
    if (perMs <= 0 && open && !open.accountId) {
      // A gap is unmet demand only: it closes when the demand stops; the
      // next account is chosen when the demand resumes.
      open.to = minute(t);
      open = undefined;
    }
    let cursor = t;
    while (cursor < end && perMs > 0 && !stopped) {
      if (!active || active.left <= EPSILON) {
        advance(cursor);
        active = choose();
        mark(active?.id, cursor);
        if (!active) {
          const until = Math.min(end, nextEvent(cursor));
          unmet += perMs * (until - cursor);
          check();
          outageMs += until - cursor;
          cursor = until;
          advance(cursor);
          continue;
        }
      }
      if (active.reset === undefined) {
        active.reset = cursor + WINDOW_MS;
        active.warmUp = undefined;
      }
      // Its own window refreshes within this step: serve until then and go
      // on with it, the way a refresh at a step boundary does.
      const until =
        active.reset > cursor && active.reset < end ? active.reset : end;
      const runOut = cursor + active.left / perMs;
      if (runOut >= until - RUN_OUT_SLACK_MS) {
        active.left -= perMs * (until - cursor);
        cursor = until;
        if (active.left <= EPSILON) {
          active.left = 0;
          (exhaustedAt[active.id] ??= []).push(minute(until));
        }
        if (until < end) advance(until);
      } else {
        active.left = 0;
        (exhaustedAt[active.id] ??= []).push(minute(runOut));
        cursor = runOut;
      }
    }
    t = end;
  }
  if (open) open.to = minute(t);
  return {
    segments: segments.filter((s) => s.to > s.from),
    unmet: Math.round(unmet * 10) / 10,
    outageMinutes: Math.round(outageMs / MINUTE_MS),
    switches,
    exhaustedAt,
  };
}

export interface StartPlanInput {
  interval: { start: number; end: number };
  accounts: { id: string; capacity: number; manual?: number }[];
  rate: (time: number) => number;
  /**
   * The even spread: the baseline every plan is compared with. It is
   * evaluated as given, so for an account with a `manual` start the caller
   * must put that same start at its index.
   */
  even: number[];
  /**
   * Whether a candidate's simulation stops once it is sure to lose (the
   * default; tests compare the plans with and without).
   */
  earlyStop?: boolean;
}
export interface StartPlan {
  starts: number[];
  forecast: Forecast;
  evenForecast: Forecast;
}

const GRID_MS = 15 * MINUTE_MS;
const CANDIDATES = 20;
const EXHAUSTIVE_FINE = 3;
const EXHAUSTIVE_COARSE = 4;
const SEEDS = 8;
const ROUNDS = 4;

/**
 * Warm-up times for the free accounts that leave the least unmet demand,
 * then the fewest switches, then start as late as possible. Manual starts
 * stay; the even spread is always a candidate, so the result is never worse.
 */
export function optimizeStarts(input: StartPlanInput): StartPlan {
  const { start, end } = input.interval;
  const simulate = (starts: number[], stopWhen?: SimInput["stopWhen"]) =>
    simulateDay({
      from: start,
      to: end,
      rate: input.rate,
      accounts: input.accounts.map((a, i) => ({
        id: a.id,
        capacity: a.capacity,
        keepAlive: true,
        remaining: 100 * a.capacity,
        ...(starts[i] <= start
          ? { firstReset: starts[i] + WINDOW_MS }
          : { warmUp: starts[i] }),
      })),
      ...(stopWhen ? { stopWhen } : {}),
    });
  interface Scored {
    starts: number[];
    forecast: Forecast;
    key: number[];
  }
  /**
   * Scores `starts`. With a `rival` the simulation stops once the candidate
   * is sure to lose to it, so a stopped forecast is never kept. Unmet demand
   * and switches only grow: more than the rival's rounded unmet + 0.5 rounds
   * above it, and at least its rounded unmet rounds no lower.
   */
  const scored = (starts: number[], rival?: Scored): Scored => {
    const forecast = simulate(
      starts,
      rival && input.earlyStop !== false
        ? (unmet, switches) =>
            unmet > rival.key[0] + 0.5 ||
            (unmet >= rival.key[0] && switches > rival.key[1])
        : undefined,
    );
    return {
      starts,
      forecast,
      key: [
        Math.round(forecast.unmet * 2) / 2,
        forecast.switches,
        -Math.min(...starts),
        -starts.reduce((sum, s) => sum + s, 0),
      ],
    };
  };
  const better = (a: Scored, b: Scored) => {
    for (let i = 0; i < a.key.length; i++)
      if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i];
    return false;
  };
  const evenScored = scored(input.even);
  const free = input.accounts
    .map((a, i) => (a.manual === undefined ? i : -1))
    .filter((i) => i >= 0);
  if (!free.length)
    return {
      starts: input.even,
      forecast: evenScored.forecast,
      evenForecast: evenScored.forecast,
    };
  const fine = Array.from(
    { length: CANDIDATES },
    (_, k) => start - WINDOW_MS + k * GRID_MS,
  );
  const coarse = fine.filter((_, k) => k % 2 === 0);
  const fixed = input.accounts.map((a, i) => a.manual ?? input.even[i]);
  let best = evenScored;
  /** Scores `starts` and keeps the best; it may stop early against a `rival` that the best is no worse than. */
  const consider = (starts: number[], rival?: Scored) => {
    const candidate = scored(starts, rival);
    if (better(candidate, best)) best = candidate;
    return candidate;
  };
  /** Moves one free account at a time while that improves the plan. */
  const descend = (from: Scored, grid: number[]) => {
    let current = from;
    for (let round = 0; round < ROUNDS; round++) {
      let moved = false;
      for (const i of free)
        for (const c of grid) {
          if (c === current.starts[i]) continue;
          const starts = [...current.starts];
          starts[i] = c;
          // Only a candidate better than the current one matters (the best
          // is no worse than the current one).
          const candidate = consider(starts, current);
          if (better(candidate, current)) {
            current = candidate;
            moved = true;
          }
        }
      if (!moved) break;
    }
  };
  /** Every combination of `grid` for the free accounts; returns the best `keep`. */
  const enumerate = (grid: number[], keep: number) => {
    const top: Scored[] = [];
    const pick = (index: number, starts: number[]) => {
      if (index === free.length) {
        // A candidate matters while it could still join the kept few (the
        // best is no worse than any of them); with none to keep, only the
        // best counts.
        const candidate = consider(
          [...starts],
          top.length < keep ? undefined : (top[keep - 1] ?? best),
        );
        let at = top.findIndex((t) => better(candidate, t));
        if (at < 0) at = top.length;
        if (at < keep) {
          top.splice(at, 0, candidate);
          top.length = Math.min(top.length, keep);
        }
        return;
      }
      for (const c of grid) {
        starts[free[index]] = c;
        pick(index + 1, starts);
      }
    };
    pick(0, [...fixed]);
    return top;
  };
  if (free.length <= EXHAUSTIVE_FINE) enumerate(fine, 0);
  else if (free.length <= EXHAUSTIVE_COARSE)
    for (const seed of enumerate(coarse, SEEDS)) descend(seed, fine);
  else {
    const total = input.accounts.reduce((sum, a) => sum + a.capacity, 0);
    let before = 0;
    const proportional = input.accounts.map((a) => {
      if (a.manual !== undefined) return a.manual;
      const target =
        start + (WINDOW_MS * (before + a.capacity / 2)) / total - WINDOW_MS;
      before += a.capacity;
      return coarse.reduce((closest, c) =>
        Math.abs(c - target) < Math.abs(closest - target) ? c : closest,
      );
    });
    for (const seed of [evenScored, consider(proportional)])
      descend(seed, coarse);
    descend(best, fine);
  }
  return {
    starts: best.starts,
    forecast: best.forecast,
    evenForecast: evenScored.forecast,
  };
}
