import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitMeter } from "@/components/LimitMeter";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { overviewAccounts, pendingFlow, tempoRateNow } from "@/data/selectors";
import { accountRowSubtitle } from "@/lib/account-row";
import { intentHash, type PageId } from "@/app/routes";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { planLabel } from "../accounts/accountLabels";
import { accountHash } from "../accounts/AccountDetail";

export function AccountsCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const zone = relay.settings.planning.timeZone;
  // The badge names the same account as the suggestion banner when there is one.
  const rows = overviewAccounts(
    relay.active,
    relay.accounts,
    relay.data?.usage ?? {},
    now,
    tempoRateNow(relay.data, relay.settings, now),
  ).map((row) =>
    relay.suggestion
      ? { ...row, recommended: row.account.id === relay.suggestion.id }
      : row,
  );
  const switchBlocked =
    relay.desktopBusy ||
    !!relay.pendingDesktop ||
    !!relay.desktop?.recoveryRequired;
  // Same lock as the Accounts row and sheet “Save Claude app sign-in” buttons.
  const linkBlocked =
    relay.desktopBusy ||
    !relay.desktop?.available ||
    !!relay.pendingDesktop ||
    !!relay.desktop?.recoveryRequired;
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">{t("Hesaplar", "Accounts")}</span>
        {relay.suggestion && relay.active ? (
          <span className="text-xs font-medium text-warn-foreground">
            {t(
              `${relay.active.name} limiti dolmak üzere · önerilen üstte`,
              `${relay.active.name} is near its limit · suggested first`,
            )}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("en uygunu üstte", "best first")}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-1 py-2 text-sm text-muted-foreground">
          {relay.accounts.length
            ? `${t("Başka hesap yok", "No other accounts")} ·`
            : `${t("Henüz hesap yok", "No accounts yet")} ·`}
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => {
              window.location.hash = intentHash("hesaplar", "ekle");
            }}
          >
            {t("Hesap ekle", "Add account")}
          </Button>
        </div>
      ) : (
        <div>
          {rows.map((row) => {
            const { account, usage } = row;
            const plan = planLabel(account);
            return (
              <div
                key={account.id}
                className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 border-t py-2.5 first:border-0"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-baseline gap-1.5 font-semibold">
                    <a
                      href={accountHash(account.id)}
                      className="truncate underline-offset-2 hover:underline"
                      title={t(`${account.name} hesabını aç`, `Open ${account.name}`)}
                    >
                      {account.name}
                    </a>
                    {row.recommended && (
                      <span className="shrink-0 text-xs font-semibold text-brand">
                        {t("önerilen", "suggested")}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {plan ? `${plan} · ` : ""}
                    {accountRowSubtitle(
                      row,
                      t,
                      language,
                      zone,
                      now,
                      pendingFlow(
                        relay.data?.authFlows.find(
                          (f) => f.accountId === account.id,
                        ),
                      ),
                    )}
                  </div>
                </div>
                <LimitMeter
                  size="sm"
                  label={t("5 sa", "5 h")}
                  percent={usage?.fiveHour?.usedPercent}
                />
                <LimitMeter
                  size="sm"
                  label={t("Hafta", "Week")}
                  percent={usage?.sevenDay?.usedPercent}
                />
                {row.state === "not-linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={linkBlocked}
                    title={t(
                      "Claude uygulaması girişini kaydet",
                      "Save Claude app sign-in",
                    )}
                    onClick={() => {
                      relay.setSetupId(account.id);
                      go("hesaplar");
                    }}
                  >
                    {t("Girişi kaydet", "Save sign-in")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={row.recommended ? "default" : "outline"}
                    disabled={switchBlocked}
                    onClick={(e) =>
                      offerAfter(prank, "nibble-cursor", e, () =>
                        relay.requestDesktop(account, "switch"),
                      )
                    }
                  >
                    {t("Geç", "Switch")}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
