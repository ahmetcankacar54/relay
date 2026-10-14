import { useState } from "react";
import type { Account } from "../shared/types";
import type { AccountUsageStatistics } from "../shared/usage-statistics";
import { SectionHeading, Note } from "@/components/SettingRow";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export function UsageStatistics({
  accounts,
  value,
  t,
}: {
  accounts: Account[];
  value: Record<string, AccountUsageStatistics>;
  t: (tr: string, en: string) => string;
}) {
  const [days, setDays] = useState<7 | 30>(7);
  const number = (n: number) =>
    new Intl.NumberFormat(t("tr-TR", "en-GB"), {
      maximumFractionDigits: 1,
    }).format(n);
  return (
    <section>
      <SectionHeading
        title={t("Hesap kullanım geçmişi", "Account usage history")}
        description={t(
          "Bu cihazın gözlediği kota tüketimi",
          "Quota consumption observed by this device",
        )}
        aside={
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={String(days)}
            aria-label={t("İstatistik aralığı", "Statistics period")}
            onValueChange={(v) => v && setDays(Number(v) as 7 | 30)}
          >
            <ToggleGroupItem value="7">
              {t("Son 7 gün", "Last 7 days")}
            </ToggleGroupItem>
            <ToggleGroupItem value="30">
              {t("Son 30 gün", "Last 30 days")}
            </ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <Table className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>{t("Hesap", "Account")}</TableHead>
            <TableHead>
              {t("Gözlenen tüketim", "Observed consumption")}
            </TableHead>
            <TableHead>{t("Pencere", "Windows")}</TableHead>
            <TableHead>{t("Gözlem süresi", "Observed time")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {accounts.map((a) => {
            const stats = value[a.id];
            const period =
              days === 7 ? stats?.periods.sevenDay : stats?.periods.thirtyDay;
            const missing = !period?.samples || stats?.status === "unavailable";
            const coverage = missing
              ? 0
              : Math.min(100, period.coveragePercent);
            return (
              <TableRow key={a.id}>
                <TableCell className="whitespace-normal">
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.auth?.email ?? a.desktop?.email}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">
                  {missing
                    ? "—"
                    : `${number(period.observedFiveHourPoints)} ${t("puan", "points")}`}
                </TableCell>
                <TableCell className="tabular-nums">
                  {missing ? "—" : period.windowsObserved}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {missing ? (
                    <span className="text-muted-foreground">
                      {stats?.status === "unavailable"
                        ? t("Kayıt okunamadı", "History unavailable")
                        : t("Veri birikiyor", "Collecting data")}
                    </span>
                  ) : (
                    <div className="grid gap-1">
                      <span className="tabular-nums">
                        {`${number(period.coveredMinutes / 60)} ${t("sa", "h")} · ${number(period.coveragePercent)}%`}
                      </span>
                      <div
                        aria-hidden
                        className="h-1 w-24 overflow-hidden rounded-full bg-track"
                      >
                        <div
                          className={cn("h-full rounded-full bg-primary")}
                          style={{ width: `${coverage}%` }}
                        />
                      </div>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Note className="mt-2">
        {t(
          "Kısmi gözlem; toplam kullanım değildir. Kayıtlar ilk başarılı limit sorgusundan itibaren birikir.",
          "Partial observation, not total usage. History builds from the first successful usage poll.",
        )}
      </Note>
      <details className="mt-2 text-[13px] text-muted-foreground">
        <summary className="cursor-pointer text-foreground">
          {t("Bu değerler ne anlama geliyor?", "What do these figures mean?")}
        </summary>
        <p className="mt-1">
          {t(
            "1 puan, bir hesabın beş saatlik kotasında gözlenen 1 yüzde puandır. Farklı planlardaki puanlar eşit iş miktarı değildir. İlk ölçüm, sıfırlanmalar ve 35 dakikadan uzun boşluklar tüketim toplamına katılmaz; bu kayıt toplam kullanımın yalnızca gözlenen bölümüdür. Claude’un diğer yüzeylerindeki kullanım da hesaba dahildir.",
            "1 point is one observed percentage point of an account’s 5-hour allowance. Points across different plans do not represent equal work. Initial readings, resets and gaps over 35 minutes are excluded; this is only the observed part of total usage. Usage in other Claude surfaces is included.",
          )}
        </p>
        <p className="mt-1">
          {t(
            "Son 30 gün yerel olarak saklanır. Mesaj içeriği, token sayısı ve ücret okunmaz. Geçmiş, bu sürümün ilk başarılı limit sorgusundan itibaren birikir.",
            "The last 30 days are stored locally. Message content, token counts and costs are not read. History starts with this release’s first successful usage poll.",
          )}
        </p>
      </details>
    </section>
  );
}
