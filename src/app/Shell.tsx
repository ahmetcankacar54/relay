import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { api } from "@/data/useRelay";
import { sidebarStatus } from "@/data/selectors";
import { Usage } from "@/pages/Usage";
import { Settings } from "@/pages/Settings";
import { Switching } from "@/pages/Switching";
import { Accounts } from "@/pages/Accounts";
import { Overview } from "@/pages/Overview";
import { Planning } from "@/pages/Planning";
import relayIcon from "../../assets/icon.png";
import { MainWindowPranks } from "@/pranks/useMainWindowPranks";
import { RelayPrankStage } from "@/pranks/RelayPrankStage";
import { Sidebar } from "./Sidebar";
import { DesktopActionDialog } from "./DesktopActionDialog";
import { shortcutPage } from "./routes";
import { useHashRoute } from "./useHashRoute";
import { useMediaQuery } from "./useMediaQuery";

export function Shell() {
  const relay = useRelay();
  const { t } = useI18n();
  const [page, go] = useHashRoute();
  const compact = useMediaQuery("(max-width: 839px)");
  const relayRef = useRef(relay);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    relayRef.current = relay;
  });
  // <main> is the scroller and outlives the page, so without this a page opens where the last one was left.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [page]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = shortcutPage(
        e,
        !!document.querySelector('[role="dialog"]'),
      );
      if (target) {
        e.preventDefault();
        go(target);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (e.repeat) return;
        const current = relayRef.current;
        for (const a of current.accounts) void current.refreshUsage(a);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go]);
  useEffect(() => api.onNavigate((page) => go(page)), [go]);
  const active = relay.active;
  return (
    <TooltipProvider delayDuration={300}>
      <RelayPrankStage>
        <MainWindowPranks />
        <div className="flex h-screen overflow-hidden bg-background text-foreground">
          <Sidebar
            page={page}
            go={go}
            t={t}
            compact={compact}
            icon={relayIcon}
            status={sidebarStatus(relay.data)}
            summary={
              active && {
                name: active.name,
                running: !!relay.desktop?.running,
                fiveHour: relay.data?.usage[active.id]?.fiveHour?.usedPercent,
              }
            }
          />
          <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto" ref={mainRef}>
            {/* In the 56 px rail the macOS traffic lights overhang into this column; keep it clear. */}
            <div
              className={cn(
                "shrink-0 [-webkit-app-region:drag]",
                compact ? "h-8" : "h-2",
              )}
            />
            <div
              key={page}
              className="flex flex-1 flex-col animate-in fade-in-0 duration-150 motion-reduce:animate-none"
            >
              {page === "genel" && <Overview go={go} />}
              {page === "hesaplar" && <Accounts />}
              {page === "kullanim" && <Usage />}
              {page === "planlama" && <Planning />}
              {page === "gecis" && <Switching />}
              {page === "ayarlar" && <Settings />}
            </div>
          </main>
        </div>
        <DesktopActionDialog />
      </RelayPrankStage>
    </TooltipProvider>
  );
}
