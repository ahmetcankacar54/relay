import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { overviewAccounts, pendingFlow, tempoRateNow, windowAccounts } from "@/data/selectors";
import {
  accountRowSubtitle,
  accountTileLine,
  fullLimitNote,
  ringState,
} from "@/lib/account-row";
import { AccountList } from "../../features/AccountList";
import { AppWindow, X } from "lucide-react";
import { PlusIcon } from "@/components/icons";
import type { OverviewRow } from "@/data/selectors";
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
    windowAccounts(relay.data),
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
  // Separate Claude windows: opened, brought forward and closed right from the row.
  const windows = relay.data?.windows;
  const inWindows = windowAccounts(relay.data);
  const windowAction = (row: OverviewRow, label: string, run: () => Promise<unknown>) => ({
    label,
    disabled: !!relay.busy,
    onClick: () => void relay.action(`window:${row.account.id}`, run),
  });
  const windowActions = (row: OverviewRow) => {
    const { account } = row;
    const open = inWindows.has(account.id);
    if (!account.desktop || !windows?.supported || (!open && !windows.enabled)) return undefined;
    if (!open) {
      const { label, ...props } = windowAction(
        row,
        t(`${account.name} hesabını ayrı pencerede aç`, `Open ${account.name} in a separate window`),
        () => relay.api.openWindow(account.id),
      );
      return (
        <Button variant="outline" size="icon-sm" aria-label={label} title={label} {...props}>
          <AppWindow aria-hidden="true" />
        </Button>
      );
    }
    const show = windowAction(
      row,
      t(`${account.name} penceresini öne getir`, `Bring ${account.name}’s window forward`),
      () => relay.api.openWindow(account.id),
    );
    const close = windowAction(
      row,
      t(`${account.name} penceresini kapat`, `Close ${account.name}’s window`),
      () => relay.api.closeWindow(account.id),
    );
    return (
      <>
        <Button variant="outline" size="icon-sm" aria-label={show.label} title={show.label} disabled={show.disabled} onClick={show.onClick}>
          <AppWindow aria-hidden="true" />
        </Button>
        <Button variant="outline" size="sm" aria-label={close.label} title={close.label} disabled={close.disabled || relay.desktopBusy} onClick={close.onClick}>
          <X aria-hidden="true" />
          {t("Kapat", "Close")}
        </Button>
      </>
    );
  };
  const addAccount = () => {
    window.location.hash = intentHash("hesaplar", "ekle");
  };
  return (
    <section className="grid content-start gap-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-xs font-semibold text-muted-foreground">
          {t("Diğer hesaplar", "Other accounts")}
        </h2>
        {/* What the two rings and the two figures in each row are. */}
        {rows.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-2.5 text-2xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-muted-foreground" />
              {t("5 saat", "5 hours")}
            </span>
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="size-1.5 rounded-full border border-muted-foreground" />
              {t("hafta", "week")}
            </span>
            {rows.some((row) => ringState(row.usage, now) === "stale") && (
              <span className="inline-flex items-center gap-1">
                <span aria-hidden="true" className="size-1.5 rounded-full border border-dashed border-muted-foreground" />
                {t("limit verisi eski", "out of date")}
              </span>
            )}
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-1 rounded-lg border bg-card px-3 py-2.5 text-sm text-muted-foreground">
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
          line={(row) => {
            const tile = accountTileLine(row, t, language, zone, now, waitingFor(row));
            return inWindows.has(row.account.id)
              ? `${t("Ayrı pencerede açık", "Open in its own window")} · ${tile}`
              : tile;
          }}
          actions={windowActions}
          title={(row) =>
            accountRowSubtitle(row, t, language, zone, now, waitingFor(row))
          }
          // An account in its own window is not switched to: its sign-in is there until it closes.
          canSwitch={(row) => row.state !== "not-linked" && !inWindows.has(row.account.id)}
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
              className={cn(
                "flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-primary outline-none hover:bg-foreground/3",
                "focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50",
              )}
            >
              <span className="grid size-8 shrink-0 place-items-center">
                <PlusIcon aria-hidden="true" className="size-4" />
              </span>
              {t("Hesap ekle", "Add account")}
            </button>
          }
        />
      )}
    </section>
  );
}
