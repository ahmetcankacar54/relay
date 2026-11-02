import { useCallback, useEffect, useRef, useState } from "react";
import type { StatisticsRange } from "../../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../../shared/token-usage-view";
import { useRelay } from "@/data/relay-context";
import {
  StatisticsRequests,
  statisticsFailed,
  statisticsLoading,
  type UsageStatisticsState,
} from "./useUsageStatistics";

export type TokenUsageState = UsageStatisticsState<TokenUsageView>;

/** While the first scan of the conversation logs runs, the view is fetched again this often. */
export const TOKEN_SCAN_POLL_MS = 5_000;

/**
 * Fetches the token view on mount and whenever the range or account changes,
 * and again on `relay:changed`, at most once per statistics throttle interval.
 * While the scan is incomplete it also asks every few seconds, so the progress
 * moves; a failed fetch stops that until the next change. The last view stays
 * shown while reloading and after a failed reload.
 */
export function useTokenUsage(
  range: StatisticsRange,
  accountId?: string,
): TokenUsageState {
  const { api } = useRelay();
  const [state, setState] = useState<TokenUsageState>({ loading: true });
  const [requests] = useState(() => new StatisticsRequests());
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    clearTimeout(pending.current);
    pending.current = undefined;
    const id = requests.start(Date.now());
    setState(statisticsLoading);
    api.tokenUsage({ range, ...(accountId ? { accountId } : {}) }).then(
      (view) => {
        if (requests.current(id)) setState({ view, loading: false });
      },
      (error: unknown) => {
        if (requests.current(id)) setState((s) => statisticsFailed(s, error));
      },
    );
  }, [api, range, accountId, requests]);
  // A trailing timer must load the current range, not the one it was set for.
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
    load();
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

  const scanning = state.view !== undefined && !state.view.progress.complete;
  useEffect(() => {
    if (!scanning || state.loading || state.error) return;
    const timer = setTimeout(() => latestLoad.current(), TOKEN_SCAN_POLL_MS);
    return () => clearTimeout(timer);
  }, [scanning, state]);

  return state;
}
