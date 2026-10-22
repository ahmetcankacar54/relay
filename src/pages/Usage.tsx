import { useState } from "react";
import type { Account } from "../../shared/types";
import type { StatisticsRange } from "../../shared/usage-statistics-view";
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
import { TokenUsage } from "./usage/TokenUsage";
import { LostFound } from "./usage/LostFound";
import { UsageHeatmap } from "./usage/UsageHeatmap";
import {
  useUsageStatistics,
  type UsageStatisticsState,
} from "./usage/useUsageStatistics";

const cardClass = "gap-0 px-5 py-4";

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
        title={t("İstatistikler alınamadı", "Could not load statistics")}
        description={error}
      />
    );
  if (!error) return <StatisticsContent {...props} />;
  return (
    <>
      <Banner tone="error" role="alert">
        <span>
          <b>
            {t("İstatistikler yenilenemedi.", "Could not refresh statistics.")}
          </b>{" "}
          {error}
        </span>
      </Banner>
      <StatisticsContent {...props} />
    </>
  );
}

function StatisticsContent({ state, accounts, accountId, zone }: SectionProps) {
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
          "Relay, hesap bağlanıp limitleri okunduğunda kullanımı kaydetmeye başlar.",
          "Relay starts recording usage once the account is connected and its limits are read.",
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
            ? t("İstatistikler yükleniyor", "Loading statistics")
            : t("İstatistik yok", "No statistics")
        }
      />
    );
  if (view.status === "unavailable")
    return (
      <StatisticsMessage
        scene="trouble"
        title={t("Kayıt okunamadı", "Usage history could not be read")}
        description={t(
          "Kullanım istatistikleri gösterilemiyor. Canlı limitler çalışmaya devam eder.",
          "Usage statistics are unavailable. Live limits keep working.",
        )}
      />
    );
  if (view.status === "empty")
    return (
      <StatisticsMessage
        scene="collecting"
        title={t("Veri birikiyor", "Collecting data")}
        description={t(
          "Relay açıkken limitler yenilendikçe istatistikler oluşur.",
          "Statistics build up as Relay refreshes limits while it is open.",
        )}
      />
    );
  return (
    <div className="grid gap-3" aria-busy={loading || undefined}>
      <SummaryTiles view={view} />
      <AccountBalance view={view} accounts={accounts} />
      <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <DailyChart view={view} accounts={accounts} zone={zone} />
        <UsageHeatmap view={view} />
      </div>
      <LimitHits view={view} zone={zone} />
      <Note className="px-1 text-xs">
        {t(
          `Değerler Relay’in gözlediği limit yüzdelerinden hesaplanır; token, mesaj ya da maliyet değildir. Gözlem kapsamı: ${formatPercent(view.coveragePercent, language)} (Relay kapalıyken veri yok). Pro birimi, gözlenen 5 saatlik kota yüzdesinin güncel plan kapasitesiyle çarpımıdır (Pro 1, Max 5× 5, Max 20× 20, Team = girilen ağırlık).`,
          `Values come from the limit percentages Relay observed; they are not tokens, messages or cost. Observed coverage: ${formatPercent(view.coveragePercent, language)} (no data while Relay is closed). A Pro unit is the observed 5-hour quota percentage times the current plan capacity (Pro 1, Max 5× 5, Max 20× 20, Team = the weight you set).`,
        )}
      </Note>
    </div>
  );
}

/** The page's tabs; only the open one is drawn, so a hidden token scan asks for nothing. */
const TABS = ["limits", "tokens", "lost", "warnings"] as const;
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

/** Whether the page will warn about accounts near their limit, and at what share; with where the figures come from. */
export function UsageWarnings() {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<typeof settings>) =>
    void action("settings", () => api.updateSettings(patch));
  return (
    <Card className={cardClass}>
      <SectionHeading title={t("Uyarılar", "Warnings")} />
      <SettingRow
        label={t("Limit uyarıları", "Usage warnings")}
        htmlFor="usage-warnings"
        description={t(
          "Eşiğe ulaşan hesapları bu panelde işaretle.",
          "Highlight accounts approaching their limit in this panel.",
        )}
      >
        <Switch
          id="usage-warnings"
          checked={settings.usageWarnings}
          disabled={disabled}
          onCheckedChange={(usageWarnings) => update({ usageWarnings })}
        />
      </SettingRow>
      <SettingRow
        label={
          <span id="usage-threshold">
            {t("Uyarı eşiği", "Warning threshold")}
          </span>
        }
        description={t(
          "Beş saatlik veya haftalık kullanım için geçerli.",
          "Applies to either the 5-hour or weekly usage limit.",
        )}
      >
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-labelledby="usage-threshold"
          value={String(settings.usageWarningPercent)}
          disabled={disabled || !settings.usageWarnings}
          onValueChange={(v) =>
            v &&
            update({
              usageWarningPercent: Number(
                v,
              ) as typeof settings.usageWarningPercent,
            })
          }
        >
          {[80, 90, 95].map((n) => (
            <ToggleGroupItem key={n} value={String(n)}>
              {t(
                `${formatPercent(n, "tr")} kullanılınca`,
                `At ${formatPercent(n, "en")} used`,
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm font-medium">
          {t("Veri kaynağı ve sınırlar", "Data source and limits")}
        </summary>
        <Note className="mt-1">
          {t(
            "Kullanım sorgusu deneysel Anthropic OAuth servisini kullanır. Relay’de bağlı CLI profili okunur; gerektiğinde bağlantıyı sen yenilersin. Bu işlem yalnız Relay profilini günceller, açık Claude uygulamasına dokunmaz. Kullanılan yüzde mesaj sayısı veya süre garantisi değildir.",
            "Usage comes from an experimental Anthropic OAuth endpoint. Relay reads its connected CLI profile; you can renew the connection when needed. Renewal updates only the Relay profile and leaves the open Claude app untouched. The percentage used is not a message count or time guarantee.",
          )}
        </Note>
      </details>
    </Card>
  );
}

/**
 * Usage in four tabs, so nothing needs a long scroll: the limit statistics, the token counts, the panda's lost and
 * found, and the warning preferences. The range and account filter belong to the first two and show only there.
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
      description={t(
        "Hangi hesapta ne kadar · çalışma alışkanlıkların",
        "Usage per account · your working habits",
      )}
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
        className="px-6 pb-6"
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
            {t("Kayıp Eşya", "Lost and found")}
          </TabsTrigger>
          <TabsTrigger value="warnings">
            {t("Uyarılar", "Warnings")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="limits">
          <UsageStatisticsSection
            state={statistics}
            accounts={accounts}
            accountId={accountId}
            zone={settings.planning.timeZone}
          />
        </TabsContent>
        <TabsContent value="tokens">
          <TokenUsage range={range} accountId={accountId} />
        </TabsContent>
        <TabsContent value="lost">
          <LostFound />
        </TabsContent>
        <TabsContent value="warnings">
          <UsageWarnings />
        </TabsContent>
      </Tabs>
    </PageFrame>
  );
}
