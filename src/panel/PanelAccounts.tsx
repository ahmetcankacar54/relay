import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useI18n, type T } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import { useRelay } from "@/data/relay-context";
import {
  overviewAccounts,
  pendingFlow,
  tempoRateNow,
  type OverviewRow,
} from "@/data/selectors";
import {
  accountRowSubtitle,
  accountTileLine,
  panelRowState,
  type PanelRowBlock,
} from "@/lib/account-row";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { AccountTiles } from "../features/AccountTiles";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

export const PANEL_MAX_ROWS = 6;

/** Why a tile cannot be switched to, in a few words. */
export function blockWords(reason: PanelRowBlock, t: T): string {
  switch (reason) {
    case "not-linked":
      return t("Relay’de girişi kaydet", "Save its sign-in in Relay");
    case "exhausted":
      return t("Limiti dolu", "Its limit is full");
    case "busy":
      return t("Claude uygulaması işlemi sürüyor", "A Claude app operation is running");
    case "pending":
      return t("Bekleyen giriş var", "A sign-in is waiting");
    case "recovery":
      return t("Önce yedeği geri yükle", "Restore the backup first");
  }
}

/** Overview ranking, with the badge on the suggested account when there is one. */
export function panelRows(relay: Relay, now: number): OverviewRow[] {
  return overviewAccounts(
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
}

/** The account a running panel switch targets (`relay.busy` is `switch:<id>`). */
export const switchingId = (busy: string) =>
  busy.startsWith("switch:") ? busy.slice("switch:".length) : undefined;

/** The first account is added in the main window: Accounts, with the add dialog open. */
export const openAddAccount = (relay: Pick<Relay, "api">) =>
  void relay.api.openPage("hesaplar", "ekle");

/** Starts the Desktop switch after the inline confirmation. */
export function confirmSwitch(relay: Relay, id: string, done: () => void) {
  void relay
    .action(`switch:${id}`, () => relay.api.switchDesktop(id))
    .finally(done);
}

export function PanelAccounts({
  now,
  initialConfirm,
  confirmId: controlled,
  onConfirmChange,
}: {
  now: number;
  /** Tests: render with this account’s confirmation open. */
  initialConfirm?: string;
  /** Lifted state, so the panel can own which tile’s confirmation is open. */
  confirmId?: string;
  onConfirmChange?: (id: string | undefined) => void;
}) {
  const relay = useRelay();
  const prank = usePrank();
  const { t, language } = useI18n();
  const [local, setLocal] = useState(initialConfirm);
  const confirmId = onConfirmChange ? controlled : local;
  const setConfirmId = onConfirmChange ?? setLocal;
  const zone = relay.settings.planning.timeZone;
  const switching = switchingId(relay.busy);
  const all = panelRows(relay, now);
  // Keep the suggested account visible even when the ranking puts it past the cut.
  let rows = all.slice(0, PANEL_MAX_ROWS);
  const pinned = all.find(
    (r) => r.account.id === (confirmId ?? relay.suggestion?.id),
  );
  if (pinned && !rows.includes(pinned))
    rows = [...rows.slice(0, PANEL_MAX_ROWS - 1), pinned];
  const hidden = all.length - rows.length;
  const waiting = (row: OverviewRow) =>
    pendingFlow(relay.data?.authFlows.find((f) => f.accountId === row.account.id));
  const confirming = rows.find((r) => r.account.id === confirmId);
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        {relay.suggestion && relay.active ? (
          <span className="font-semibold text-warn-foreground">
            {t("Limit dolmak üzere · önerilen üstte", "Near the limit · suggested first")}
          </span>
        ) : (
          <span>{t("Diğer hesaplar · en uygunu üstte", "Other accounts · best first")}</span>
        )}
        {rows.length > 0 && (
          <span className="flex items-center gap-2" aria-hidden="true">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-foreground/70" />
              {t("5 sa", "5 h")}
            </span>
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-foreground/30" />
              {t("hafta", "week")}
            </span>
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <div className={`${panelCard} text-muted-foreground`}>
          {relay.accounts.length ? (
            t("Başka hesap yok", "No other accounts")
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {`${t("Henüz hesap yok", "No accounts yet")} ·`}
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 text-[12.5px]"
                onClick={() => openAddAccount(relay)}
              >
                {t("Hesap ekle", "Add account")}
              </Button>
            </span>
          )}
        </div>
      ) : (
        <AccountTiles
          variant="panel"
          rows={rows}
          selected={confirmId}
          switching={switching}
          line={(row) => accountTileLine(row, t, language, zone, now, waiting(row))}
          title={(row) => accountRowSubtitle(row, t, language, zone, now, waiting(row))}
          blocked={(row) => {
            const { reason } = panelRowState(row, relay);
            return reason && blockWords(reason, t);
          }}
          pick={(row, e) => {
            const { canSwitch, reason } = panelRowState(row, relay);
            if (reason === "not-linked") return void relay.api.openPage("hesaplar");
            if (!canSwitch) return;
            // Closing an open confirmation is a cancel, not a switch request: no prank.
            if (confirmId === row.account.id) return setConfirmId(undefined);
            offerAfter(prank, "nibble-cursor", e, () => setConfirmId(row.account.id));
          }}
        />
      )}
      {switching ? (
        <div
          role="status"
          className="mt-2 flex items-center gap-2 rounded-lg border bg-muted px-2.5 py-1.5 text-xs"
        >
          <LoaderCircle className="size-3.5 animate-spin" />
          {t(
            `${relay.accounts.find((a) => a.id === switching)?.name ?? ""} hesabına geçiliyor…`,
            `Switching to ${relay.accounts.find((a) => a.id === switching)?.name ?? ""}…`,
          )}
        </div>
      ) : (
        confirming && (
          <div
            data-slot="switch-confirm"
            className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn-foreground"
          >
            <span>
              {language === "tr" ? (
                <>
                  Claude uygulaması kapanıp <b>{confirming.account.name}</b> ile yeniden
                  açılır. Çalışan yanıtlar bitsin.
                </>
              ) : (
                <>
                  The Claude app quits and reopens with <b>{confirming.account.name}</b>.
                  Let running replies finish.
                </>
              )}
            </span>
            <span className="flex shrink-0 gap-1.5">
              <Button size="xs" variant="outline" onClick={() => setConfirmId(undefined)}>
                {t("Vazgeç", "Cancel")}
              </Button>
              <Button
                size="xs"
                disabled={!panelRowState(confirming, relay).canSwitch}
                onClick={() =>
                  confirmSwitch(relay, confirming.account.id, () => setConfirmId(undefined))
                }
              >
                {t("Geç", "Switch")}
              </Button>
            </span>
          </div>
        )
      )}
      {hidden > 0 && (
        <Button
          variant="link"
          size="sm"
          className="mt-1 h-auto px-1 text-xs text-muted-foreground"
          onClick={() => void relay.api.openPage("hesaplar")}
        >
          {t(
            `+${hidden} hesap · Relay’de gör`,
            `+${hidden} accounts · View in Relay`,
          )}
        </Button>
      )}
    </section>
  );
}
