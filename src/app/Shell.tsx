import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { sidebarStatus } from "@/data/selectors";
import { Usage } from "@/pages/Usage";
import { LegacySettings } from "@/pages/Legacy";
import { Switching } from "@/pages/Switching";
import { Accounts } from "@/pages/Accounts";
import { Overview } from "@/pages/Overview";
import { Planning } from "@/pages/Planning";
import relayIcon from "../../assets/icon.png";
import { Sidebar } from "./Sidebar";
import { PageFrame } from "./PageFrame";
import { DesktopActionDialog } from "./DesktopActionDialog";
import { shortcutPage } from "./routes";
import { useHashRoute } from "./useHashRoute";
import { useMediaQuery } from "./useMediaQuery";

export function Shell() {
  const relay = useRelay();
  const { t, language, setLanguage } = useI18n();
  const [page, go] = useHashRoute();
  const compact = useMediaQuery("(max-width: 839px)");
  const relayRef = useRef(relay);
  useEffect(() => {
    relayRef.current = relay;
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = shortcutPage(e);
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
  const active = relay.active;
  const languagePicker = (
    <select
      aria-label={t("Dil", "Language")}
      value={language}
      onChange={(e) => setLanguage(e.target.value as "tr" | "en")}
      className="h-8 rounded-md border bg-card px-2 py-0 text-sm"
    >
      <option value="tr">Türkçe</option>
      <option value="en">English</option>
    </select>
  );
  return (
    <TooltipProvider delayDuration={300}>
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
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* In the 56 px rail the macOS traffic lights overhang into this column; keep it clear. */}
          <div
            className={cn(
              "shrink-0 [-webkit-app-region:drag]",
              compact ? "h-8" : "h-2",
            )}
          />
          {/* Legacy content is temporary; Task 13 replaces the remaining page. */}
          {page === "genel" && <Overview go={go} />}
          {page === "hesaplar" && <Accounts />}
          {page === "kullanim" && <Usage />}
          {page === "planlama" && <Planning />}
          {page === "gecis" && <Switching />}
          {page === "ayarlar" && (
            <PageFrame
              title={t("Ayarlar", "Settings")}
              description={t(
                "Görünüm, dil ve teknik bilgiler",
                "Appearance, language and technical details",
              )}
              actions={languagePicker}
            >
              <LegacySettings section="switch" />
            </PageFrame>
          )}
        </main>
      </div>
      <DesktopActionDialog />
    </TooltipProvider>
  );
}
