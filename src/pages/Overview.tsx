import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Banner } from "@/components/Banner";
import { ToolList, blockedToolText, otherToolRows } from "../features/ToolList";
import { blockedTool, type ToolId } from "@/lib/tools";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatRelative } from "@/lib/time";
import { overviewCards } from "@/lib/onboarding";
import { PageFrame } from "@/app/PageFrame";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { intentHash, type Destination } from "@/app/routes";
import { ActiveAccountCard } from "./overview/ActiveAccountCard";
import { AccountsCard } from "./overview/AccountsCard";
import { TodayCard } from "./overview/TodayCard";
import { AutomationCard } from "./overview/AutomationCard";
import { SetupChecklist } from "./overview/SetupChecklist";

export function Overview({
  go,
  now = Date.now(),
}: {
  go: (to: Destination) => void;
  /** Injected by tests; the page re-renders with the snapshot poll. */
  now?: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const { accounts, usageBusy } = relay;
  const usage = relay.data?.usage ?? {};
  const date = new Intl.DateTimeFormat(language === "tr" ? "tr-TR" : "en-GB", {
    timeZone: relay.settings.planning.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(now));
  const latest = Object.values(usage)
    .map((u) => u.checkedAt)
    .filter((c): c is string => !!c && Number.isFinite(Date.parse(c)))
    .sort()
    .at(-1);
  const description = latest
    ? t(
        `${date} · ${formatRelative(latest, now, language)} güncellendi`,
        `${date} · updated ${formatRelative(latest, now, language)}`,
      )
    : date;
  const refreshing = usageBusy.size > 0;
  // Today plans a connected account; automatic switching needs two.
  const cards = overviewCards(accounts);
  const [openTool, setOpenTool] = useState<ToolId>();
  // A tool the user must move by hand (Antigravity, a Codex CLI on its own sign-in) leads the page
  // when its account is spent and another has room. The Claude app has its own suggestion below,
  // and the gateway moves Claude Code and Codex by itself.
  const stopped = blockedTool(otherToolRows(relay, now).filter((row) => row.via !== "gateway"));
  const stoppedText = stopped && blockedToolText(stopped, accounts, t, language, now);
  return (
    <PageFrame
      automationInline
      title={t("Genel bakış", "Overview")}
      description={description}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Limitleri yenile", "Refresh limits")}
            title={t("Limitleri yenile", "Refresh limits")}
            disabled={refreshing || !accounts.length}
            onClick={(e) =>
              offerAfter(prank, "wheel", e, () => {
                for (const a of accounts) void relay.refreshUsage(a);
              })
            }
          >
            {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshIcon />}
          </Button>
          {relay.active && (
            <Button
              variant="outline"
              disabled={relay.desktopBusy}
              onClick={() => void relay.action("open", () => relay.api.openDesktop())}
            >
              {t("Claude uygulamasını aç", "Open the Claude app")}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-4 px-5 pb-5">
        {stopped && stoppedText && (
          <Banner
            tone="warn"
            role="status"
            action={
              stopped.id === "antigravity" ? (
                <Button size="sm" onClick={() => setOpenTool("antigravity")}>
                  {t("Nasıl geçilir", "How to move")}
                </Button>
              ) : undefined
            }
          >
            <span data-slot="tool-banner" className="min-w-0 text-sm">
              <b className="font-semibold">{stoppedText.title}</b> {stoppedText.body}
            </span>
          </Banner>
        )}
        <ActiveAccountCard go={go} now={now} />
        <section aria-labelledby="tools-title" className="grid content-start gap-1.5 empty:hidden">
          <ToolList
            now={now}
            open={openTool}
            onOpenChange={setOpenTool}
            onGateway={() => go("proxy")}
            onAdd={() => {
              window.location.hash = intentHash("hesaplar", "ekle");
            }}
          />
        </section>
        {/* Before the first account the checklist is the next step; after, the accounts come first. */}
        {accounts.length === 0 && <SetupChecklist go={go} />}
        {cards.today ? (
          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <AccountsCard go={go} now={now} />
            <div className="grid content-start gap-4">
              <TodayCard go={go} now={now} />
              {cards.automation && <AutomationCard go={go} now={now} />}
            </div>
          </div>
        ) : (
          // With no account yet, the card above already offers the first one.
          accounts.length > 0 && <AccountsCard go={go} now={now} />
        )}
        {accounts.length > 0 && <SetupChecklist go={go} />}
      </div>
    </PageFrame>
  );
}
