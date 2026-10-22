import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { LimitMeter } from "@/components/LimitMeter";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { overviewAccounts, pendingFlow, tempoRateNow } from "@/data/selectors";
import { accountRowSubtitle, accountTileLine } from "@/lib/account-row";
import { AccountTiles } from "../../features/AccountTiles";
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
  const waitingFor = (row: { account: { id: string } }) =>
    pendingFlow(relay.data?.authFlows.find((f) => f.accountId === row.account.id));
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
        <AccountTiles
          rows={rows}
          line={(row) =>
            accountTileLine(row, t, language, zone, now, waitingFor(row))
          }
          title={(row) =>
            accountRowSubtitle(row, t, language, zone, now, waitingFor(row))
          }
          blocked={(row) =>
            row.state === "not-linked"
              ? undefined
              : row.state === "exhausted"
                ? t("Limiti dolu", "Its limit is full")
                : switchBlocked
                  ? t("Şu an geçilemez", "Cannot switch right now")
                  : undefined
          }
          pick={(row, e) => {
            if (row.state === "not-linked") {
              if (linkBlocked) return;
              relay.setSetupId(row.account.id);
              window.location.hash = accountHash(row.account.id);
              return;
            }
            if (switchBlocked || row.state === "exhausted") return;
            offerAfter(prank, "nibble-cursor", e, () =>
              relay.requestDesktop(row.account, "switch"),
            );
          }}
        />
      )}
    </Card>
  );
}
