import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LimitMeter } from "@/components/LimitMeter";
import { useI18n } from "@/data/i18n";
import type { Relay } from "@/data/relay-context";
import { useRelay } from "@/data/relay-context";
import {
  overviewAccounts,
  tempoRateNow,
  type OverviewRow,
} from "@/data/selectors";
import { accountRowSubtitle, panelRowState } from "@/lib/account-row";
import { offerAfter, usePrank } from "@/pranks/PrankStage";
import { planLabel } from "../pages/accounts/accountLabels";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

export const PANEL_MAX_ROWS = 6;

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
  /** Lifted state so the suggestion strip can open a row’s confirmation. */
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
        <span>{t("Hesaplar", "Accounts")}</span>
        <span>{t("en uygun önce", "best first")}</span>
      </div>
      <div className={`${panelCard} px-2 py-1`}>
        {rows.length === 0 ? (
          <div className="py-1.5 text-muted-foreground">
            {t("Başka hesap yok", "No other accounts")}
          </div>
        ) : (
          rows.map((row) => {
            const { account, usage } = row;
            const plan = planLabel(account);
            const { canSwitch } = panelRowState(row, relay);
            const open = confirmId === account.id;
            const subtitle = `${plan ? `${plan} · ` : ""}${accountRowSubtitle(row, t, language, zone, now)}`;
            return (
              <div
                key={account.id}
                className="grid grid-cols-[1fr_72px_72px_auto] items-center gap-2 border-t px-1 py-1.5 first:border-0"
              >
                <div className="min-w-0">
                  <div
                    className="min-w-0 truncate font-semibold"
                    title={account.name}
                  >
                    {account.name}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    {row.recommended && (
                      <Badge
                        variant="secondary"
                        className="shrink-0 px-1.5 text-[10px]"
                      >
                        {t("Önerilen", "Suggested")}
                      </Badge>
                    )}
                    <span className="min-w-0 truncate" title={subtitle}>
                      {subtitle}
                    </span>
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
                <Button
                  size="xs"
                  variant={row.recommended ? "default" : "outline"}
                  disabled={!canSwitch || !!switching}
                  aria-expanded={open}
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
                {switching === account.id ? (
                  <div
                    role="status"
                    className="col-span-full flex items-center gap-2 rounded-lg border bg-muted px-2.5 py-1.5 text-[11.5px]"
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
                    <div className="col-span-full flex items-center justify-between gap-2 rounded-lg border border-warn/40 bg-warn/10 px-2.5 py-1.5 text-[11.5px] text-warn-foreground">
                      <span>
                        {language === "tr" ? (
                          <>
                            Claude kapanıp <b>{account.name}</b> ile yeniden
                            açılır. Çalışan yanıtlar bitsin.
                          </>
                        ) : (
                          <>
                            Claude quits and reopens with <b>{account.name}</b>.
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
          className="mt-1 h-auto px-1 text-[11.5px] text-muted-foreground"
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
