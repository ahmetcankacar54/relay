import { useState } from "react";
import type { Account } from "../../shared/types";
import type { StatisticsRange } from "../../shared/usage-statistics-view";
import { usageIdentity } from "../../shared/usage-statistics";
import { PageFrame } from "@/app/PageFrame";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatPercent } from "@/lib/meter";
import { AccountBalance } from "./usage/AccountBalance";
import { DailyChart } from "./usage/DailyChart";
import { LimitHits } from "./usage/LimitHits";
import { StatisticsHeader } from "./usage/StatisticsHeader";
import { SummaryTiles } from "./usage/SummaryTiles";
import { UsageHeatmap } from "./usage/UsageHeatmap";
import {
  useUsageStatistics,
  type UsageStatisticsState,
} from "./usage/useUsageStatistics";

const cardClass = "gap-0 px-5 py-4";

/** A card with one message instead of the statistics. */
function StatisticsMessage({
  title,
  description,
  alert,
}: {
  title: string;
  description: string;
  alert?: boolean;
}) {
  return (
    <Card className={cardClass} role={alert ? "alert" : undefined}>
      <SectionHeading title={title} description={description} />
    </Card>
  );
}

/** The statistics cards for a fetched view, or the state that replaces them. */
export function UsageStatisticsSection({
  state,
  accounts,
  accountId,
  zone,
}: {
  state: UsageStatisticsState;
  accounts: Account[];
  accountId?: string;
  zone: string;
}) {
  const { t, language } = useI18n();
  const { view, loading, error } = state;
  const selected = accounts.find((a) => a.id === accountId);
  if (error)
    return (
      <StatisticsMessage
        alert
        title={t("İstatistikler alınamadı", "Could not load statistics")}
        description={error}
      />
    );
  if (selected && !usageIdentity(selected))
    return (
      <StatisticsMessage
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

export function Usage() {
  const { api, accounts, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const [range, setRange] = useState<StatisticsRange>(30);
  const [chosen, setChosen] = useState<string>();
  // A deleted account falls back to all accounts.
  const accountId = accounts.some((a) => a.id === chosen) ? chosen : undefined;
  const statistics = useUsageStatistics(range, accountId);
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<typeof settings>) =>
    void action("settings", () => api.updateSettings(patch));
  return (
    <PageFrame
      title={t("Kullanım", "Usage")}
      description={t(
        "Hangi hesapta ne kadar · çalışma alışkanlıkların",
        "Usage per account · your working habits",
      )}
      actions={
        <StatisticsHeader
          range={range}
          onRange={setRange}
          accountId={accountId}
          onAccount={setChosen}
          accounts={accounts}
        />
      }
    >
      <div className="grid gap-3 px-6 pb-6">
        <UsageStatisticsSection
          state={statistics}
          accounts={accounts}
          accountId={accountId}
          zone={settings.planning.timeZone}
        />
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
              "Applies to either the 5-hour or weekly usage window.",
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
                  {t(`%${100 - n} kalınca`, `${100 - n}% remaining`)}
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
                "Kullanım sorgusu deneysel Anthropic OAuth servisini kullanır. Relay’de bağlı CLI profili okunur; gerektiğinde bağlantıyı sen yenilersin. Bu işlem yalnız Relay profilini günceller, açık Claude’a dokunmaz. Kalan yüzde mesaj sayısı veya süre garantisi değildir.",
                "Usage comes from an experimental Anthropic OAuth endpoint. Relay reads its connected CLI profile; you can renew the connection when needed. Renewal updates only the Relay profile and leaves the open Claude app untouched. Remaining percentage is not a message count or time guarantee.",
              )}
            </Note>
          </details>
        </Card>
      </div>
    </PageFrame>
  );
}
