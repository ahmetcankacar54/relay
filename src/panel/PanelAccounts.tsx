import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPercent, meterClass, meterTone, percentUsed } from "@/lib/meter";
import { cn } from "@/lib/utils";
import { useI18n } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import { useRelay } from "@/data/relay-context";
import {
  overviewAccounts,
  pendingFlow,
  tempoRateNow,
  type OverviewRow,
} from "@/data/selectors";
import { accountRowSubtitle, panelRowState } from "@/lib/account-row";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { planLabel } from "../pages/accounts/accountLabels";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

export const PANEL_MAX_ROWS = 6;

/** A limit on one line: its short name, a bar and the percent used. */
function InlineMeter({ label, percent }: { label: string; percent?: number }) {
  const { language } = useI18n();
  const value = percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
      <span className="w-8 shrink-0 text-muted-foreground">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-track"
      >
        <span
          className={cn("block h-full rounded-full", meterClass[meterTone(value)])}
          style={{ width: `${value ?? 0}%` }}
        />
      </span>
      <b className="w-9 shrink-0 text-right tabular-nums">
        {value === undefined ? "—" : formatPercent(percentUsed(value), language)}
      </b>
    </div>
  );
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
  /** Lifted state, so the panel can own which row’s confirmation is open. */
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
      </div>
      <div className={`${panelCard} px-2 py-1`}>
        {rows.length === 0 ? (
          relay.accounts.length ? (
            <div className="py-1.5 text-muted-foreground">
              {t("Başka hesap yok", "No other accounts")}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1 py-1.5 text-muted-foreground">
              {`${t("Henüz hesap yok", "No accounts yet")} ·`}
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 text-[12.5px]"
                onClick={() => openAddAccount(relay)}
              >
                {t("Hesap ekle", "Add account")}
              </Button>
            </div>
          )
        ) : (
          rows.map((row) => {
            const { account, usage } = row;
            const plan = planLabel(account);
            const { canSwitch } = panelRowState(row, relay);
            const open = confirmId === account.id;
            const waiting = pendingFlow(
              relay.data?.authFlows.find((f) => f.accountId === account.id),
            );
            const subtitle = `${plan ? `${plan} · ` : ""}${accountRowSubtitle(row, t, language, zone, now, waiting)}`;
            return (
              <div
                key={account.id}
                data-slot="panel-account"
                className="grid gap-1 border-t px-1 py-2 first:border-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span
                      className="min-w-0 truncate font-semibold"
                      title={account.name}
                    >
                      {account.name}
                    </span>
                    {row.recommended && (
                      <span className="shrink-0 text-[11.5px] font-semibold text-brand">
                        {t("önerilen", "suggested")}
                      </span>
                    )}
                  </div>
                  <Button
                    size="xs"
                    variant={row.recommended ? "default" : "outline"}
                    disabled={!canSwitch || !!switching}
                    aria-expanded={open}
                    aria-label={t(`${account.name} hesabına geç`, `Switch to ${account.name}`)}
                    onClick={(e) =>
                      // Closing an open confirmation is a cancel, not a switch request: no prank.
                      open
                        ? setConfirmId(undefined)
                        : offerAfter(prank, "nibble-cursor", e, () =>
                            setConfirmId(account.id),
                          )
                    }
                  >
                    {t("Geç", "Switch")}
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <InlineMeter
                    label={t("5 sa", "5 h")}
                    percent={usage?.fiveHour?.usedPercent}
                  />
                  <InlineMeter
                    label={t("Hafta", "Week")}
                    percent={usage?.sevenDay?.usedPercent}
                  />
                </div>
                <div
                  className="truncate text-[11.5px] text-muted-foreground"
                  title={subtitle}
                >
                  {subtitle}
                </div>
                {switching === account.id ? (
                  <div
                    role="status"
                    className="col-span-full flex items-center gap-2 rounded-lg border bg-muted px-2.5 py-1.5 text-xs"
                  >
                    <LoaderCircle className="size-3.5 animate-spin" />
                    {t(
                      `${account.name} hesabına geçiliyor…`,
                      `Switching to ${account.name}…`,
                    )}
                  </div>
                ) : (
                  open &&
                  !switching && (
                    <div className="col-span-full flex items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-xs text-warn-foreground">
                      <span>
                        {language === "tr" ? (
                          <>
                            Claude uygulaması kapanıp <b>{account.name}</b> ile yeniden
                            açılır. Çalışan yanıtlar bitsin.
                          </>
                        ) : (
                          <>
                            The Claude app quits and reopens with <b>{account.name}</b>.
                            Let running replies finish.
                          </>
                        )}
                      </span>
                      <span className="flex shrink-0 gap-1.5">
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setConfirmId(undefined)}
                        >
                          {t("Vazgeç", "Cancel")}
                        </Button>
                        <Button
                          size="xs"
                          disabled={!canSwitch}
                          onClick={() =>
                            confirmSwitch(relay, account.id, () =>
                              setConfirmId(undefined),
                            )
                          }
                        >
                          {t("Onayla", "Confirm")}
                        </Button>
                      </span>
                    </div>
                  )
                )}
              </div>
            );
          })
        )}
      </div>
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
