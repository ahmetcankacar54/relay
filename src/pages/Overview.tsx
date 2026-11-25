import { LoaderCircle } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { FORMAT_LOCALE } from "../../shared/i18n/locales";
import { useRelay } from "@/data/relay-context";
import { formatRelative } from "@/lib/time";
import { overviewCards } from "@/lib/onboarding";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import type { Destination } from "@/app/routes";
import { ActiveAccountCard } from "./overview/ActiveAccountCard";
import { AccountsBoard } from "./overview/AccountsBoard";
import { MetersCard } from "./overview/MetersCard";
import { TodayCard } from "./overview/TodayCard";
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
  const date = new Intl.DateTimeFormat(FORMAT_LOCALE[language], {
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
    ? t("overview.updated", { date, formatRelative: formatRelative(latest, now, language) })
    : date;
  const refreshing = usageBusy.size > 0;
  // Today plans a connected account; automatic switching needs two.
  const cards = overviewCards(accounts);
  return (
    <PageFrame
      title={t("overview.overview")}
      description={description}
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("common.refreshLimits")}
            title={t("common.refreshLimits")}
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
              {t("overview.openTheClaudeApp")}
            </Button>
          )}
        </>
      }
    >
      <PageBody className="gap-5 pb-5">
        {/* Now: the account in the Claude app, then every other account in one board, then today. */}
        <ActiveAccountCard go={go} now={now} />
        {/* Before the first account the checklist is the next step; after, the accounts come first.
            Until the first snapshot the board's placeholders stand in for both. */}
        {accounts.length === 0 && relay.data !== undefined && <SetupChecklist go={go} />}
        <AccountsBoard now={now} />
        {/* The other tools' meters, read-only: after the accounts Relay switches, before the plan. */}
        <MetersCard now={now} />
        {cards.today && <TodayCard go={go} now={now} />}
        {accounts.length > 0 && <SetupChecklist go={go} />}
      </PageBody>
    </PageFrame>
  );
}
