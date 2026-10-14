import { useCallback, useEffect, useRef, useState } from "react";
import { planCapacity } from "../../../shared/planning";
import type {
  StatisticsRange,
  UsageStatisticsView,
} from "../../../shared/usage-statistics-view";
import { useRelay } from "@/data/relay-context";

/** A Relay change refetches the statistics at most this often. */
export const STATISTICS_THROTTLE_MS = 30_000;

export interface UsageStatisticsState {
  view?: UsageStatisticsView;
  loading: boolean;
  error?: string;
}

/**
 * Fetches the statistics view on mount and whenever the range or account
 * changes. Relay changes refetch it, throttled: `relay:changed`, and new
 * usage checks or plan edits seen in the snapshot (recording a sample does
 * not broadcast `relay:changed`). The last view stays shown while reloading.
 */
export function useUsageStatistics(
  range: StatisticsRange,
  accountId?: string,
): UsageStatisticsState {
  const { api, data, accounts } = useRelay();
  const [state, setState] = useState<UsageStatisticsState>({ loading: true });
  const request = useRef(0);
  const lastLoad = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = undefined;
    lastLoad.current = Date.now();
    const id = ++request.current;
    setState((s) => ({ view: s.view, loading: true }));
    api.usageStatistics({ range, ...(accountId ? { accountId } : {}) }).then(
      (view) => {
        if (id === request.current) setState({ view, loading: false });
      },
      (error: unknown) => {
        if (id === request.current)
          setState({
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
  }, [api, range, accountId]);
  // A trailing timer must load the current range, not the one it was set for.
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
    load();
  }, [load]);

  const changed = useCallback(() => {
    if (pending.current) return;
    const wait = lastLoad.current + STATISTICS_THROTTLE_MS - Date.now();
    if (wait <= 0) latestLoad.current();
    else
      pending.current = setTimeout(() => {
        pending.current = undefined;
        latestLoad.current();
      }, wait);
  }, []);
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
