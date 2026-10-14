import { useEffect } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { sidebarStatus } from "@/data/selectors";
import { LegacyHome, LegacySettings } from "@/pages/Legacy";
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
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = shortcutPage(e);
      if (target) {
        e.preventDefault();
        go(target);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
        e.preventDefault();
        for (const a of relay.accounts) void relay.refreshUsage(a);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [go, relay]);
  const active = relay.active;
  const languagePicker = (
    <select
      aria-label={t("Dil", "Language")}
      value={language}
      onChange={(e) => setLanguage(e.target.value as "tr" | "en")}
      className="h-8 rounded-md border bg-card px-2 text-sm"
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
          <div className="h-2 shrink-0 [-webkit-app-region:drag]" />
          {/* Legacy content is temporary; Tasks 7–13 replace each page. */}
          {page === "genel" && (
            <PageFrame
              title={t("Genel bakış", "Overview")}
              description={t(
                "Açık hesap, limitler ve bugünün planı",
                "Open account, limits and today’s plan",
              )}
            >
              <LegacyHome />
            </PageFrame>
          )}
          {page === "hesaplar" && (
            <PageFrame
              title={t("Hesaplar", "Accounts")}
              description={t(
                "Hesapların ve bağlantıları",
                "Your accounts and connections",
              )}
            >
              <LegacyHome />
            </PageFrame>
          )}
          {page === "kullanim" && (
            <PageFrame
              title={t("Kullanım", "Usage")}
              description={t(
                "İstatistikler ve uyarılar",
                "Statistics and warnings",
              )}
            >
              <LegacySettings section="usage" />
            </PageFrame>
          )}
          {page === "planlama" && (
            <PageFrame
              title={t("Planlama", "Planning")}
              description={t(
                "Otomatik pencere başlatma",
                "Automatic window start",
              )}
            >
              <LegacySettings section="planning" />
            </PageFrame>
          )}
          {page === "gecis" && (
            <PageFrame
              title={t("Geçiş", "Switching")}
              description={t(
                "Kota dolunca geçiş, kapanınca hazırlama, ortak geçmiş",
                "Switch when quota runs out, prepare on quit, shared history",
              )}
            >
              <LegacySettings section="switch" />
            </PageFrame>
          )}
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
