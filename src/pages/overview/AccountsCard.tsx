import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitMeter } from "@/components/LimitMeter";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { overviewAccounts } from "@/data/selectors";
import { accountRowSubtitle } from "@/lib/account-row";
import type { PageId } from "@/app/routes";
import { planLabel } from "../accounts/accountLabels";

export function AccountsCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const zone = relay.settings.planning.timeZone;
  // The badge names the same account as the suggestion banner when there is one.
  const rows = overviewAccounts(
    relay.active,
    relay.accounts,
    relay.data?.usage ?? {},
    now,
  ).map((row) =>
    relay.suggestion
      ? { ...row, recommended: row.account.id === relay.suggestion.id }
      : row,
  );
  const switchBlocked =
    relay.desktopBusy ||
    !!relay.pendingDesktop ||
    !!relay.desktop?.recoveryRequired;
  // Same lock as the Accounts row and sheet “Connect Desktop” buttons.
  const linkBlocked =
    relay.desktopBusy ||
    !relay.desktop?.available ||
    !!relay.pendingDesktop ||
    !!relay.desktop?.recoveryRequired;
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">{t("Hesaplar", "Accounts")}</span>
        <span className="text-xs text-muted-foreground">
          {t("en uygun önce", "best first")}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-1 py-2 text-sm text-muted-foreground">
          {t("Başka hesap yok", "No other accounts")} ·
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => {
              window.location.hash = "#/hesaplar?ekle";
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
                className="grid grid-cols-[1.2fr_1fr_1fr_auto] items-center gap-3 border-t py-2.5 first:border-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <span className="truncate">{account.name}</span>
                    {row.recommended && (
                      <Badge variant="secondary">
                        {t("Önerilen", "Suggested")}
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {plan ? `${plan} · ` : ""}
                    {accountRowSubtitle(row, t, language, zone, now)}
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
                    onClick={() => {
                      relay.setSetupId(account.id);
                      go("hesaplar");
                    }}
                  >
                    {t("Desktop’a bağla", "Link to Desktop")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant={row.recommended ? "default" : "outline"}
                    disabled={switchBlocked}
                    onClick={() => relay.requestDesktop(account, "switch")}
                  >
                    {t("Geçiş yap", "Switch")}
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
