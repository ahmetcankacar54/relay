import { useCallback, useEffect, useState } from "react";
import { parseRoute, routeHash, type PageId } from "./routes";
export function useHashRoute(): [PageId, (page: PageId) => void] {
  const [page, setPage] = useState<PageId>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const changed = () => setPage(parseRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const go = useCallback((next: PageId) => {
    if (window.location.hash !== routeHash(next)) window.location.hash = routeHash(next);
    setPage(next);
  }, []);
  return [page, go];
}
