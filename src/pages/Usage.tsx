import { useState } from "react";
import type { Account } from "../../shared/types";
import type { StatisticsRange } from "../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../shared/token-usage-view";
import { historyIdentity } from "../../shared/usage-statistics";
import { Banner } from "@/components/Banner";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { Card } from "@/components/ui/card";
import { Panda } from "@/components/Panda";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SectionHeading } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "@/lib/meter";
import type { PandaScene } from "@/mascot/scenes";
import { AccountBalance } from "./usage/AccountBalance";
import { DailyChart } from "./usage/DailyChart";
import { LimitHits } from "./usage/LimitHits";
import { StatisticsHeader } from "./usage/StatisticsHeader";
import { SummaryTiles } from "./usage/SummaryTiles";
import { costSummary, type CostSummary } from "./usage/cost-summary";
import { useTokenUsage } from "./usage/useTokenUsage";
import { TokenUsage } from "./usage/TokenUsage";
import { LostFound } from "./usage/LostFound";
import { UsageHeatmap } from "./usage/UsageHeatmap";
import {
  useUsageStatistics,
  type UsageStatisticsState,
} from "./usage/useUsageStatistics";

/** A card with one message instead of the statistics; the panda reflects the state. */
function StatisticsMessage({
  title,
  description,
  alert,
  scene,
}: {
  title: string;
  description: string;
  alert?: boolean;
  scene?: PandaScene;
}) {
  return (
    <Card padded role={alert ? "alert" : undefined}>
      <div className="flex items-center gap-4">
        {scene && <Panda scene={scene} size={72} playful />}
        <div className="min-w-0 flex-1">
          <SectionHeading title={title} description={description} />
        </div>
      </div>
    </Card>
  );
}

interface SectionProps {
  state: UsageStatisticsState;
  accounts: Account[];
  accountId?: string;
  zone: string;
  /** What the range's tokens are worth at API prices, when the token ledger has priced any. */
  cost?: CostSummary;
  /** The token ledger's view of the range: the daily chart's token and $ bars, the summary's token total. */
  tokens?: TokenUsageView;
}

/**
 * The statistics cards for a fetched view, or the state that replaces them.
 * A failed reload keeps the last view under a short alert.
 */
export function UsageStatisticsSection(props: SectionProps) {
  const { t } = useI18n();
  const { view, error } = props.state;
  if (error && !view)
    return (
      <StatisticsMessage
        alert
        scene="trouble"
        title={t("usage.cannotLoadTheStatistics")}
        description={error}
      />
    );
  if (!error) return <StatisticsContent {...props} />;
  return (
    <>
      <Banner tone="error" role="alert">
        <span>
          <b>
            {t("usage.cannotRefreshTheStatistics")}
          </b>{" "}
          {error}
        </span>
      </Banner>
      <StatisticsContent {...props} />
    </>
  );
}

function StatisticsContent({
  state,
  accounts,
  accountId,
  zone,
}: SectionProps) {
  const { t } = useI18n();
  const { view, loading } = state;
  const selected = accounts.find((a) => a.id === accountId);
  if (selected && !historyIdentity(selected))
    return (
      <StatisticsMessage
        scene="lookout"
        title={t("usage.noUsageRecordForThisAccount")}
        description={t("usage.relayRecordsUsageAfterItReads")}
      />
    );
  if (!view)
    return (
      <StatisticsMessage
        scene={loading ? undefined : "lookout"}
        title={t("usage.statistics")}
        description={
          loading
            ? t("usage.relayLoadsTheStatistics")
            : t("usage.noStatistics")
        }
      />
    );
  if (view.status === "unavailable")
    return (
      <StatisticsMessage
        scene="trouble"
        title={t("usage.cannotReadTheUsageHistory")}
        description={t("usage.liveLimitsStillWork")}
      />
    );
  if (view.status === "empty")
    return (
      <StatisticsMessage
        scene="collecting"
        title={t("usage.noDataYet")}
        description={t("usage.relayCollectsStatisticsWhileItIs")}
      />
    );
  return (
    <div className="grid gap-5" aria-busy={loading || undefined}>
      <SummaryTiles view={view} />
      <DailyChart view={view} accounts={accounts} zone={zone} />
      <div className="grid items-start gap-5 @4xl:grid-cols-2">
        <AccountBalance view={view} accounts={accounts} />
        <LimitHits view={view} zone={zone} />
      </div>
      <UsageHeatmap view={view} />
    </div>
  );
}

/** The Limits page: the statistics with the token ledger's tokens and API value beside them. */
function LimitsPage({
  range,
  ...props
}: Omit<SectionProps, "cost" | "tokens" | "state"> & { range: StatisticsRange }) {
  const state = useUsageStatistics(range, props.accountId);
  const tokens = useTokenUsage(range, props.accountId).view;
  return (
    <UsageStatisticsSection
      {...props}
      state={state}
      cost={costSummary(tokens)}
      tokens={tokens}
    />
  );
}

/** Usage's three pages in the sidebar; each draws only its own section, so a token scan runs only on its page. */
export type UsageSection = "limits" | "tokens" | "lost";

/**
 * The range and account filter, shared by the limits and tokens pages and kept while the window is
 * open, so going from one page to the other keeps the same view.
 */
let lastFilter: { range: StatisticsRange; chosen?: string } = { range: 30 };

/**
 * The warning threshold as a segmented control, off while warnings are; Settings → Notifications
 * shows it. `short` drops the "kullanılınca" for a narrow row.
 */
export function WarningThreshold({
  labelledBy,
  short,
}: {
  labelledBy: string;
  short?: boolean;
}) {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t, language } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-labelledby={labelledBy}
      value={String(settings.usageWarningPercent)}
      disabled={disabled || !settings.usageWarnings}
      onValueChange={(v) =>
        v &&
        void action("settings", () =>
          api.updateSettings({
            usageWarningPercent: Number(
              v,
            ) as typeof settings.usageWarningPercent,
          }),
        )
      }
    >
      {[80, 90, 95].map((n) => (
        <ToggleGroupItem key={n} value={String(n)}>
          {short
            ? formatPercent(n, language)
            : t("usage.atUsed", { percent: formatPercent(n, language) })}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/**
 * One of Usage's pages: the limit statistics, the token counts, or the panda's pin collection. The
 * range and account filter belong to the first two and show only there.
 */
export function Usage({ section = "limits" }: { section?: UsageSection }) {
  const { accounts, settings } = useRelay();
  const { t } = useI18n();
  const [range, setRangeState] = useState<StatisticsRange>(lastFilter.range);
  const [chosen, setChosenState] = useState<string | undefined>(lastFilter.chosen);
  const setRange = (next: StatisticsRange) => {
    lastFilter = { ...lastFilter, range: next };
    setRangeState(next);
  };
  const setChosen = (next?: string) => {
    lastFilter = { ...lastFilter, chosen: next };
    setChosenState(next);
  };
  // A deleted account falls back to all accounts.
  const accountId = accounts.some((a) => a.id === chosen) ? chosen : undefined;
  const filtered = section === "limits" || section === "tokens";
  const title =
    section === "tokens"
      ? t("usage.tokensAndCost")
      : section === "lost"
        ? t("usage.pins")
        : t("usage.limitHistory");
  return (
    <PageFrame
      title={title}
      actions={
        filtered ? (
          <StatisticsHeader
            range={range}
            onRange={setRange}
            accountId={accountId}
            onAccount={setChosen}
            accounts={accounts}
          />
        ) : undefined
      }
    >
      <PageBody className="pb-5">
        {/* History only: today's limits of every account are on the Overview. */}
        {section === "limits" && (
          <LimitsPage
            accounts={accounts}
            accountId={accountId}
            range={range}
            zone={settings.planning.timeZone}
          />
        )}
        {section === "tokens" && <TokenUsage range={range} accountId={accountId} />}
        {section === "lost" && <LostFound />}
      </PageBody>
    </PageFrame>
  );
}
