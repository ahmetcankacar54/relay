import { useState } from "react";
import type { Account } from "../shared/types";
import type { AccountUsageStatistics } from "../shared/usage-statistics";

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
    <section className="usage-statistics">
      <div className="planning-section-title">
        <div>
          <h4>{t("Hesap kullanım geçmişi", "Account usage history")}</h4>
          <p>
            {t(
              "Bu cihazın gözlediği kota tüketimi",
              "Quota consumption observed by this device",
            )}
          </p>
        </div>
        <select
          aria-label={t("İstatistik aralığı", "Statistics period")}
          value={days}
          onChange={(e) => setDays(Number(e.target.value) as 7 | 30)}
        >
          <option value={7}>{t("Son 7 gün", "Last 7 days")}</option>
          <option value={30}>{t("Son 30 gün", "Last 30 days")}</option>
        </select>
      </div>
      <div className="planning-table-wrap">
        <table className="planning-table">
          <thead>
            <tr>
              <th>{t("Hesap", "Account")}</th>
              <th>{t("Gözlenen tüketim", "Observed consumption")}</th>
              <th>{t("Pencere", "Windows")}</th>
              <th>{t("Gözlem süresi", "Observed time")}</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const stats = value[a.id];
              const period =
                days === 7 ? stats?.periods.sevenDay : stats?.periods.thirtyDay;
              const missing =
                !period?.samples || stats?.status === "unavailable";
              return (
                <tr key={a.id}>
                  <th scope="row">
                    <strong>{a.name}</strong>
                    <small>{a.auth?.email ?? a.desktop?.email}</small>
                  </th>
                  <td>
                    {missing
                      ? "—"
                      : `${number(period.observedFiveHourPoints)} ${t("puan", "points")}`}
                  </td>
                  <td>{missing ? "—" : period.windowsObserved}</td>
                  <td>
                    {missing
                      ? stats?.status === "unavailable"
                        ? t("Kayıt okunamadı", "History unavailable")
                        : t("Veri birikiyor", "Collecting data")
                      : `${number(period.coveredMinutes / 60)} ${t("sa", "h")} · ${number(period.coveragePercent)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="preference-footnote">
        {t(
          "Kısmi gözlem; toplam kullanım değildir. Kayıtlar ilk başarılı limit sorgusundan itibaren birikir.",
          "Partial observation, not total usage. History builds from the first successful usage poll.",
        )}
      </p>
      <details className="planning-help usage-statistics-help">
        <summary>
          {t("Bu değerler ne anlama geliyor?", "What do these figures mean?")}
        </summary>
        <p className="preference-footnote">
          {t(
            "1 puan, bir hesabın beş saatlik kotasında gözlenen 1 yüzde puandır. Farklı planlardaki puanlar eşit iş miktarı değildir. İlk ölçüm, sıfırlanmalar ve 35 dakikadan uzun boşluklar tüketim toplamına katılmaz; bu kayıt toplam kullanımın yalnızca gözlenen bölümüdür. Claude’un diğer yüzeylerindeki kullanım da hesaba dahildir.",
            "1 point is one observed percentage point of an account’s 5-hour allowance. Points across different plans do not represent equal work. Initial readings, resets and gaps over 35 minutes are excluded; this is only the observed part of total usage. Usage in other Claude surfaces is included.",
          )}
        </p>
        <p className="preference-footnote">
          {t(
            "Son 30 gün yerel olarak saklanır. Mesaj içeriği, token sayısı ve ücret okunmaz. Geçmiş, bu sürümün ilk başarılı limit sorgusundan itibaren birikir.",
            "The last 30 days are stored locally. Message content, token counts and costs are not read. History starts with this release’s first successful usage poll.",
          )}
        </p>
      </details>
    </section>
  );
}
