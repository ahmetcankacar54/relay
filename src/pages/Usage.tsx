import { PageFrame } from "@/app/PageFrame";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Note, SectionHeading, SettingRow } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";

const cardClass = "gap-0 px-5 py-4";

export function Usage() {
  const { api, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  const disabled = !!busy || !!desktop?.busy;
  const update = (patch: Partial<typeof settings>) =>
    void action("settings", () => api.updateSettings(patch));
  return (
    <PageFrame
      title={t("Kullanım", "Usage")}
      description={t("İstatistikler ve uyarılar", "Statistics and warnings")}
    >
      <div className="grid gap-3 px-6 pb-6">
        <Card className={cardClass}>
          {/* Statistics are served on demand by relay:usage-statistics. */}
          <SectionHeading title={t("İstatistikler", "Statistics")} />
          <Note>{t("İstatistikler yükleniyor", "Loading statistics")}</Note>
        </Card>
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
