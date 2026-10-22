import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatRelative } from "@/lib/time";
import { overviewCards } from "@/lib/onboarding";
import { PageFrame } from "@/app/PageFrame";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import type { PageId } from "@/app/routes";
import { ActiveAccountCard } from "./overview/ActiveAccountCard";
import { AccountsCard } from "./overview/AccountsCard";
import { TodayCard } from "./overview/TodayCard";
import { AutomationCard } from "./overview/AutomationCard";
import { SetupChecklist } from "./overview/SetupChecklist";

export function Overview({
  go,
  now = Date.now(),
}: {
  go: (page: PageId) => void;
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
    ? `${date} · ${t("güncellendi", "updated")} ${formatRelative(latest, now, language)}`
    : date;
  const refreshing = usageBusy.size > 0;
  // Today plans a connected account; automatic switching needs two.
  const cards = overviewCards(accounts);
  return (
    <PageFrame
      automationInline
      title={t("Genel bakış", "Overview")}
      description={description}
      actions={
        <Button
          variant="outline"
          disabled={refreshing || !accounts.length}
          onClick={(e) =>
            offerAfter(prank, "wheel", e, () => {
              for (const a of accounts) void relay.refreshUsage(a);
            })
          }
        >
          {refreshing ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          {t("Limitleri yenile", "Refresh limits")}
        </Button>
      }
    >
      <div className="grid gap-3 px-6 pb-6">
        <ActiveAccountCard go={go} now={now} />
        <SetupChecklist />
        {cards.today ? (
          <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
            <AccountsCard go={go} now={now} />
            <div className="grid content-start gap-3">
              <TodayCard go={go} now={now} />
              {cards.automation && <AutomationCard go={go} now={now} />}
            </div>
          </div>
        ) : (
          <AccountsCard go={go} now={now} />
        )}
      </div>
    </PageFrame>
  );
}
