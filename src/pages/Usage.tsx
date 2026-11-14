import { useState } from "react";
import type { Account } from "../../shared/types";
import type { StatisticsRange } from "../../shared/usage-statistics-view";
import type { TokenUsageView } from "../../shared/token-usage-view";
import { historyIdentity } from "../../shared/usage-statistics";
import { Banner } from "@/components/Banner";
import { PageFrame } from "@/app/PageFrame";
import { Card } from "@/components/ui/card";
import { Panda } from "@/components/Panda";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
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
import { LimitsNow } from "./usage/LimitsNow";
import {
  useUsageStatistics,
  type UsageStatisticsState,
} from "./usage/useUsageStatistics";

const cardClass = "gap-0 px-4 py-3.5";

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
    <Card className={cardClass} role={alert ? "alert" : undefined}>
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
        title={t("İstatistikler alınamadı", "Cannot load the statistics")}
        description={error}
      />
    );
  if (!error) return <StatisticsContent {...props} />;
  return (
    <>
      <Banner tone="error" role="alert">
        <span>
          <b>
            {t("İstatistikler yenilenemedi.", "Cannot refresh the statistics.")}
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
  cost,
  tokens,
}: SectionProps) {
  const { t, language } = useI18n();
  const { view, loading } = state;
  const selected = accounts.find((a) => a.id === accountId);
  if (selected && !historyIdentity(selected))
    return (
      <StatisticsMessage
        scene="lookout"
        title={t(
          "Bu hesap için kullanım kaydı yok",
          "No usage record for this account",
        )}
        description={t(
          "Relay, bu hesabın limitlerini okuduktan sonra kullanımı kaydeder.",
          "Relay records usage after it reads the limits of this account.",
        )}
      />
    );
  if (!view)
    return (
      <StatisticsMessage
        scene={loading ? undefined : "lookout"}
        title={t("İstatistikler", "Statistics")}
        description={
          loading
            ? t("İstatistikler yükleniyor", "Relay loads the statistics…")
            : t("İstatistik yok", "No statistics")
        }
      />
    );
  if (view.status === "unavailable")
    return (
      <StatisticsMessage
        scene="trouble"
        title={t("Kullanım geçmişi okunamadı", "Cannot read the usage history")}
        description={t(
          "Canlı limitler çalışmaya devam eder.",
          "Live limits still work.",
        )}
      />
    );
  if (view.status === "empty")
    return (
      <StatisticsMessage
        scene="collecting"
        title={t("Henüz veri yok", "No data yet")}
        description={t(
          "Relay açıkken istatistik toplar.",
          "Relay collects statistics while it is open.",
        )}
      />
    );
  return (
    <div className="grid gap-3" aria-busy={loading || undefined}>
      <SummaryTiles view={view} />
      <UsageHeatmap view={view} />
      <DailyChart view={view} accounts={accounts} zone={zone} />
      <AccountBalance view={view} accounts={accounts} />
      <LimitHits view={view} zone={zone} />
      <details className="px-1">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          {t("Bu sayılar nasıl hesaplanıyor?", "How Relay calculates these numbers")}
        </summary>
        <Note className="mt-1 text-xs">
          {t(
            "Bu sayılar Relay’in okuduğu limit yüzdelerinden gelir; token, mesaj ya da maliyet saymaz. Dolu dönem, bir hesabın 5 saatlik limitinin tamamıdır. Hesap payları plana göre ağırlıklıdır: Pro 1, Max 5× 5, Max 20× 20, Team için girdiğin ağırlık. Token ve API karşılığı “Token ve ücret” sayfasındadır.",
            "These numbers come from the limit percentages that Relay reads. They do not count tokens, messages or cost. A full period is all of one 5-hour limit. Account shares use plan weights: Pro 1, Max 5× 5, Max 20× 20, Team as you set it. Tokens and API value are on the “Tokens and cost” page.",
          )}
        </Note>
      </details>
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
            : t(
                `${formatPercent(n, "tr")} kullanılınca`,
                `At ${formatPercent(n, "en")} used`,
              )}
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
      ? t("Token ve ücret", "Tokens and cost")
      : section === "lost"
        ? t("Rozetler", "Pins")
        : t("Limitler", "Limits");
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
      <div className="grid gap-4 px-5 pb-5">
        {/* Today's limits of every account first; the statistics below are history. */}
        {section === "limits" && <LimitsNow />}
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
      </div>
    </PageFrame>
  );
}
