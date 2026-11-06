import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { MainWindowPranks } from "@/pranks/useMainWindowPranks";
import { RelayPrankStage } from "@/pranks/RelayPrankStage";
import { cardState, cardYields, desktopWorking } from "@/mascot/card-panda";
import { Sidebar } from "./Sidebar";
import { CardPanda, useCardPanda } from "./CardPanda";
import { DesktopActionDialog } from "./DesktopActionDialog";
import { intentHash, shortcutPage } from "./routes";
import { useHashRoute } from "./useHashRoute";
import { useMediaQuery } from "./useMediaQuery";
import { useSidebarSize } from "./useSidebarSize";

export function Shell() {
  const relay = useRelay();
  const { t } = useI18n();
  const [page, go] = useHashRoute();
  // A narrow window always shows the icon rail; a wider one shows what the user chose.
  const narrow = useMediaQuery("(max-width: 899px)");
  const [sidebar, setSidebar] = useSidebarSize();
  const compact = narrow || sidebar.collapsed;
  const sidebarRef = useRef(sidebar);
  useEffect(() => {
    sidebarRef.current = sidebar;
  });
  const toggleSidebar = () =>
    setSidebar({ ...sidebarRef.current, collapsed: !sidebarRef.current.collapsed });
  // The page toolbar shows its bottom edge once content scrolls under it.
  const [scrolled, setScrolled] = useState(false);
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
      } else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "s") {
        // ⌃⌘S shows or hides the sidebar, as in the macOS apps.
        e.preventDefault();
        if (!e.repeat) toggleSidebar();
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
        <div className="flex h-screen overflow-hidden bg-sidebar text-foreground vibrant:bg-transparent">
          <Sidebar
            page={page}
            go={go}
            t={t}
            compact={compact}
            width={sidebar.width}
            collapsed={compact}
            onResize={narrow ? undefined : setSidebar}
            onToggle={narrow ? undefined : toggleSidebar}
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
            className="group/main relative flex min-w-0 flex-1 flex-col overflow-y-auto border-l bg-background"
            ref={mainRef}
            data-scrolled={scrolled || undefined}
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
          >
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
