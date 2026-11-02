import { useCallback, useEffect, useState } from "react";
import { parseRoute, routeHash, type Destination, type NavPage } from "./routes";

/** The sidebar page the hash shows, and `go`, which also takes a former page or a Settings tab. */
export function useHashRoute(): [NavPage, (to: Destination) => void] {
  const [page, setPage] = useState<NavPage>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const changed = () => setPage(parseRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const go = useCallback((to: Destination) => {
    if (window.location.hash !== routeHash(to)) window.location.hash = routeHash(to);
    setPage(parseRoute(routeHash(to)));
  }, []);
  return [page, go];
}
