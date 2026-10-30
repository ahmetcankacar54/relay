import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panda } from "@/components/Panda";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatRelative } from "@/lib/time";
import { RelayErrorAlert } from "@/app/RelayErrorAlert";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { PanelActiveCard } from "./PanelActiveCard";
import { PanelAccounts } from "./PanelAccounts";
import { PanelAutomation } from "./PanelAutomation";
import { PanelDrafts } from "./PanelDrafts";
import { PanelExtension } from "./PanelExtension";
import { PanelSidebar } from "./PanelSidebar";
import { panelHead } from "./panel-head";

/** The menu bar popover: active account, other accounts, automation. */
export function Panel({
  now = Date.now(),
}: {
  /** Injected by tests; the panel re-renders with the snapshot poll. */
  now?: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { api, accounts, usageBusy } = relay;
  const [confirmId, setConfirmId] = useState<string>();
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    // The line heights make the content a fraction of a pixel tall (477.28); scrollHeight
    // rounds that down, which left the window 0.28 px short and the document scrollable.
    // Main rounds the exact height up.
    const report = () => api.setPanelHeight(el.getBoundingClientRect().height);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    // A window that ended up shorter than the content asks again for the size it needs.
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [api]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") api.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);

  const usage = relay.data?.usage ?? {};
  const latest = Object.values(usage)
    .map((u) => u.checkedAt)
    .filter((c): c is string => !!c && Number.isFinite(Date.parse(c)))
    .sort()
    .at(-1);
  const refreshing = usageBusy.size > 0;

  return (
    // The window is sized to the content (observed on the inner div); if it is ever shorter,
    // only this wrapper scrolls, vertically and without a scrollbar that would eat the width.
    <div className="max-h-screen w-[360px] overflow-x-hidden overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        ref={root}
        className="w-full bg-background/90 text-[12.5px] leading-snug text-foreground"
      >
        <header className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
          <span className="flex items-center gap-2 font-bold">
            <Panda
              scene={panelHead(relay.data, relay.desktop, now)}
              size={18}
            />
            Relay
          </span>
          <span className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Limitleri yenile", "Refresh limits")}
              disabled={refreshing || !accounts.length}
              onClick={(e) =>
                offerAfter(prank, "wheel", e, () => {
                  for (const a of accounts) void relay.refreshUsage(a);
                })
              }
            >
              <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("Ayarlar", "Settings")}
              title={t("Ayarlar", "Settings")}
              onClick={() => void api.openPage("ayarlar")}
            >
              <Settings2 />
            </Button>
          </span>
        </header>
        <div className="px-3 empty:hidden">
          <RelayErrorAlert />
        </div>
        <PanelActiveCard now={now} />
        <PanelDrafts />
        <PanelExtension />
        <PanelSidebar />
        <PanelAccounts
          now={now}
          confirmId={confirmId}
          onConfirmChange={setConfirmId}
        />
        <PanelAutomation now={now} />
        <footer className="mt-1.5 flex items-center justify-between gap-2 border-t px-3 pt-1.5 pb-2 text-muted-foreground">
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-[12px] font-semibold text-foreground"
            onClick={() => void api.openPage("genel")}
          >
            {t("Relay’i aç", "Open Relay")}
          </Button>
          {latest && (
            <span className="truncate text-xs">
              {t(
                `${formatRelative(latest, now, language)} güncellendi`,
                `Updated ${formatRelative(latest, now, language)}`,
              )}
            </span>
          )}
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-[12px] text-muted-foreground"
            onClick={() => void api.quit()}
          >
            {t("Çık", "Quit")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
