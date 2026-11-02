import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { api } from "@/data/useRelay";
import { sidebarStatus } from "@/data/selectors";
import { linkedSwitchAccount } from "../../shared/relay-link";
import { Usage } from "@/pages/Usage";
import { Settings } from "@/pages/Settings";
import { Accounts } from "@/pages/Accounts";
import { Overview } from "@/pages/Overview";
// 24 px in the sidebar: the 64 px rendering is sharp at 2×, without the 1 MB icon.png.
import relayIcon from "../../assets/icons/app-64.png";
import { MainWindowPranks } from "@/pranks/useMainWindowPranks";
import { RelayPrankStage } from "@/pranks/RelayPrankStage";
import { cardState, cardYields, desktopWorking } from "@/mascot/card-panda";
import { Sidebar } from "./Sidebar";
import { CardPanda, useCardPanda } from "./CardPanda";
import { DesktopActionDialog } from "./DesktopActionDialog";
import { intentHash, shortcutPage } from "./routes";
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
  // An intent rides on the hash: the page reads it on mount or on the hash change.
  useEffect(
    () =>
      api.onNavigate((page, intent) => {
        if (intent) window.location.hash = intentHash(page, intent);
        else go(page);
      }),
    [go],
  );
  // A widget's Geç: the same switch review the app's Switch buttons open, once the accounts are known.
  const [linked, setLinked] = useState<string>();
  useEffect(() => {
    const take = () =>
      void api.takeSwitchRequest().then(
        (id) => id && setLinked(id),
        () => {},
      );
    take();
    return api.onSwitchRequest(take);
  }, []);
  useEffect(() => {
    const current = relayRef.current;
    if (!linked || !current.data) return;
    setLinked(undefined);
    const account = linkedSwitchAccount(
      linked,
      current.accounts,
      current.active?.id,
    );
    if (account) current.requestDesktop(account, "switch");
  }, [linked, relay.data]);
  const active = relay.active;
  const panda = useCardPanda({
    state: cardState(relay.data, relay.desktop, relay.busy, Date.now()),
    active: active?.id,
    busy: desktopWorking(relay.desktop, relay.busy),
    settings: relay.data && JSON.stringify(relay.data.settings),
    refreshing: relay.usageBusy.size > 0,
    yields: cardYields(page, relay.accounts, relay.settings.planning),
  });
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
            panda={<CardPanda view={panda.view} />}
            onPoke={panda.poke}
            status={sidebarStatus(relay.data)}
            summary={
              active && {
                name: active.name,
                running: !!relay.desktop?.running,
                fiveHour: relay.data?.usage[active.id]?.fiveHour?.usedPercent,
              }
            }
          />
          <main
            className="relative flex min-w-0 flex-1 flex-col overflow-y-auto"
            ref={mainRef}
          >
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
              {page === "ayarlar" && <Settings />}
            </div>
          </main>
        </div>
        <DesktopActionDialog />
      </RelayPrankStage>
    </TooltipProvider>
  );
}
