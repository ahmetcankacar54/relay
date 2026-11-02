import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { overviewAccounts, pendingFlow, tempoRateNow } from "@/data/selectors";
import {
  accountRowSubtitle,
  accountTileLine,
  fullLimitNote,
  ringState,
} from "@/lib/account-row";
import { AccountList } from "../../features/AccountList";
import { Plus } from "lucide-react";
import { intentHash, type Destination } from "@/app/routes";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { accountHash } from "../accounts/AccountDetail";

export function AccountsCard({
  go,
  now,
}: {
  go: (to: Destination) => void;
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
  const addAccount = () => {
    window.location.hash = intentHash("hesaplar", "ekle");
  };
  return (
    <section className="grid content-start gap-2">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-[13px] font-semibold text-muted-foreground">
          {t("Diğer hesaplar", "Other accounts")}
        </h2>
        {relay.suggestion && relay.active ? (
          <span className="text-xs font-medium text-warn-foreground">
            {t("Önerilen üstte", "Suggested first")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("en uygunu üstte", "best first")}
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-1 rounded-xl border bg-card px-4 py-3 text-sm text-muted-foreground">
          {relay.accounts.length
            ? `${t("Başka hesap yok", "No other accounts")} ·`
            : `${t("Henüz hesap yok", "No accounts yet")} ·`}
          <Button variant="link" size="sm" className="h-auto px-0" onClick={addAccount}>
            {t("Hesap ekle", "Add account")}
          </Button>
        </div>
      ) : (
        <AccountList
          rows={rows}
          now={now}
          href={(row) => accountHash(row.account.id)}
          line={(row) =>
            accountTileLine(row, t, language, zone, now, waitingFor(row))
          }
          title={(row) =>
            accountRowSubtitle(row, t, language, zone, now, waitingFor(row))
          }
          canSwitch={(row) => row.state !== "not-linked"}
          blocked={(row) =>
            row.state !== "not-linked" && switchBlocked
              ? t("Şu an geçilemez", "Cannot switch right now")
              : undefined
          }
          // A full account can still be switched to: its switch is tinted and says when it opens.
          warn={(row) =>
            row.state === "exhausted"
              ? fullLimitNote(row.availableAt, t, language, zone, now)
              : undefined
          }
          pick={(row, e) => {
            if (row.state === "not-linked") {
              if (linkBlocked) return;
              relay.setSetupId(row.account.id);
              window.location.hash = accountHash(row.account.id);
              return;
            }
            if (switchBlocked) return;
            offerAfter(prank, "nibble-cursor", e, () =>
              relay.requestDesktop(row.account, "switch"),
            );
          }}
          footer={
            <button
              type="button"
              onClick={addAccount}
              className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
            >
              <span className="grid size-[38px] shrink-0 place-items-center rounded-full border-[1.5px] border-dashed border-input">
                <Plus aria-hidden="true" className="size-4 text-muted-foreground" />
              </span>
              <span>
                <span className="block text-[13.5px] font-medium">{t("Hesap ekle", "Add account")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("Claude uygulamasındaki hesabı bir kez kaydet", "Save the account open in the Claude app once")}
                </span>
              </span>
            </button>
          }
        />
      )}
      {rows.length > 0 && (
        <p className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-muted-foreground" />
            {t("kalın: 5 saatlik dönem", "thick: 5-hour period")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full border-[1.5px] border-muted-foreground" />
            {t("ince: hafta", "thin: week")}
          </span>
          {rows.some((row) => ringState(row.usage, now) === "stale") && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-full border-[1.5px] border-dashed border-muted-foreground/60" />
              {t("kesikli: veri eski", "dashed: data out of date")}
            </span>
          )}
        </p>
      )}
    </section>
  );
}
