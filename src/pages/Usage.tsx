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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
            "Bu sayılar Relay’in okuduğu limit yüzdelerinden gelir; token, mesaj ya da maliyet saymaz. Dolu dönem, bir hesabın 5 saatlik limitinin tamamıdır. Hesap payları plana göre ağırlıklıdır: Pro 1, Max 5× 5, Max 20× 20, Team için girdiğin ağırlık. Token ve API karşılığı “Token ve ücret” sekmesindedir.",
            "These numbers come from the limit percentages that Relay reads. They do not count tokens, messages or cost. A full period is all of one 5-hour limit. Account shares use plan weights: Pro 1, Max 5× 5, Max 20× 20, Team as you set it. Tokens and API value are on the “Tokens and cost” tab.",
          )}
        </Note>
      </details>
    </div>
  );
}

/** The Limits tab: the statistics with the token ledger's tokens and API value beside them; mounted only while open. */
function LimitsTab({
  range,
  ...props
}: Omit<SectionProps, "cost" | "tokens"> & { range: StatisticsRange }) {
  const tokens = useTokenUsage(range, props.accountId).view;
  return (
    <UsageStatisticsSection
      {...props}
      cost={costSummary(tokens)}
      tokens={tokens}
    />
  );
}

/** The page's tabs; only the open one is drawn, so a hidden token scan asks for nothing. */
const TABS = ["limits", "tokens", "lost"] as const;
export type UsageTab = (typeof TABS)[number];
/** Where the open tab is remembered, a convenience for this window only. */
const TAB_KEY = "relay.usage.tab.v1";

function storedTab(): UsageTab {
  try {
    const value = window.localStorage?.getItem(TAB_KEY);
    return TABS.includes(value as UsageTab) ? (value as UsageTab) : "limits";
  } catch {
    return "limits";
  }
}

function storeTab(tab: UsageTab) {
  try {
    window.localStorage?.setItem(TAB_KEY, tab);
  } catch {
    // The tab is then remembered until the page closes.
  }
}

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
 * Usage in three tabs, so nothing needs a long scroll: the limit statistics, the token counts and the panda's
 * pin collection. The range and account filter belong to the first two and show only there.
 */
export function Usage() {
  const { accounts, settings } = useRelay();
  const { t } = useI18n();
  const [range, setRange] = useState<StatisticsRange>(30);
  const [chosen, setChosen] = useState<string>();
  const [tab, setTab] = useState<UsageTab>(storedTab);
  // A deleted account falls back to all accounts.
  const accountId = accounts.some((a) => a.id === chosen) ? chosen : undefined;
  const statistics = useUsageStatistics(range, accountId);
  const filtered = tab === "limits" || tab === "tokens";
  return (
    <PageFrame
      title={t("Kullanım", "Usage")}
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
      <Tabs
        className="px-5 pb-5"
        value={tab}
        onValueChange={(value) => {
          const next = value as UsageTab;
          setTab(next);
          storeTab(next);
        }}
      >
        <TabsList aria-label={t("Kullanım bölümleri", "Usage sections")}>
          <TabsTrigger value="limits">{t("Limitler", "Limits")}</TabsTrigger>
          <TabsTrigger value="tokens">{t("Token ve ücret", "Tokens and cost")}</TabsTrigger>
          <TabsTrigger value="lost">
            {t("Rozetler", "Pins")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="limits">
          <LimitsTab
            state={statistics}
            accounts={accounts}
            accountId={accountId}
            range={range}
            zone={settings.planning.timeZone}
          />
        </TabsContent>
        <TabsContent value="tokens">
          <TokenUsage range={range} accountId={accountId} />
        </TabsContent>
        <TabsContent value="lost">
          <LostFound />
        </TabsContent>
      </Tabs>
    </PageFrame>
  );
}
