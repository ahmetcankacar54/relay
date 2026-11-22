import { useCallback, useEffect, useRef, useState } from "react";
import { planCapacity } from "../../../shared/planning";
import type {
  StatisticsRange,
  UsageStatisticsView,
} from "../../../shared/usage-statistics-view";
import { errorMessage } from "@/data/error-message";
import { useRelay } from "@/data/relay-context";

/** A Relay change refetches the statistics at most this often. */
export const STATISTICS_THROTTLE_MS = 30_000;

/** The state of a fetched view; the token card shares it with its own view type. */
export interface UsageStatisticsState<V = UsageStatisticsView> {
  view?: V;
  loading: boolean;
  error?: string;
}

/** A reload of the same range and account started: the last view and error stay until it settles. */
export const statisticsLoading = <V>(
  state: UsageStatisticsState<V>,
): UsageStatisticsState<V> => ({ ...state, loading: true });

/**
 * A request failed: the error replaces the view, so data that may be out of date is not shown
 * as current.
 */
export const statisticsFailed = <V>(error: unknown): UsageStatisticsState<V> => ({
  loading: false,
  error: errorMessage(error),
});

/**
 * Orders statistics requests: only the latest one may update the state, and
 * a Relay change refetches at most once per throttle interval.
 */
export class StatisticsRequests {
  private latest = 0;
  private startedAt = -Infinity;
  constructor(private readonly throttleMs = STATISTICS_THROTTLE_MS) {}
  /** Starts a request at `now` and returns its id. */
  start(now: number): number {
    this.startedAt = now;
    return ++this.latest;
  }
  /** Whether request `id` is still the latest one. */
  current(id: number): boolean {
    return id === this.latest;
  }
  /** Milliseconds until a change may refetch; 0 means now. */
  wait(now: number): number {
    return Math.max(0, this.startedAt + this.throttleMs - now);
  }
}

/**
 * Fetches the statistics view on mount and whenever the range or account
 * changes. Relay changes refetch it, throttled: `relay:changed`, and new
 * usage checks or plan edits seen in the snapshot (recording a sample does
 * not broadcast `relay:changed`). A new range or account starts from an empty
 * view; the same one keeps its view while reloading. A failure shows the error
 * in place of the view.
 */
export function useUsageStatistics(
  range: StatisticsRange,
  accountId?: string,
): UsageStatisticsState {
  const { api, data, accounts } = useRelay();
  const [state, setState] = useState<UsageStatisticsState>({ loading: true });
  const [requests] = useState(() => new StatisticsRequests());
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(
    (fresh = false) => {
      clearTimeout(pending.current);
      pending.current = undefined;
      const id = requests.start(Date.now());
      setState(fresh ? { loading: true } : statisticsLoading);
      api.usageStatistics({ range, ...(accountId ? { accountId } : {}) }).then(
        (view) => {
          if (requests.current(id)) setState({ view, loading: false });
        },
        (error: unknown) => {
          if (requests.current(id)) setState(statisticsFailed(error));
        },
      );
    },
    [api, range, accountId, requests],
  );
  // A trailing timer must load the current range, not the one it was set for.
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
    // Another range or account: the last view belongs to the previous one.
    load(true);
  }, [load]);

  const changed = useCallback(() => {
    if (pending.current) return;
    const wait = requests.wait(Date.now());
    if (!wait) latestLoad.current();
    else
      pending.current = setTimeout(() => {
        pending.current = undefined;
        latestLoad.current();
      }, wait);
  }, [requests]);
  useEffect(() => api.onChanged(changed), [api, changed]);
  useEffect(() => () => clearTimeout(pending.current), []);

  const revision = [
    ...Object.values(data?.usage ?? {}).map((u) => u.checkedAt ?? ""),
    ...accounts.map(
      (a) => `${a.id}:${a.name}:${a.planning?.plan ?? ""}:${planCapacity(a)}`,
    ),
  ].join("|");
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    changed();
  }, [revision, changed]);

  return state;
}
