import { RefreshCw } from "lucide-react";
import { freshUsage } from "../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LimitMeter } from "@/components/LimitMeter";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { usageWindowRows } from "@/data/selectors";
import { formatReset } from "@/lib/time";
import { planLabel } from "../pages/accounts/accountLabels";

export const panelEyebrow =
  "mb-1.5 flex items-center justify-between gap-2 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase";
export const panelCard = "rounded-[10px] border bg-card px-3 py-2.5";

/** The account open in Claude Desktop, with its limits. */
export function PanelActiveCard({ now }: { now: number }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { active, desktop } = relay;
  const running = !!desktop?.running;
  const usage = active ? relay.data?.usage[active.id] : undefined;
  const plan = active && planLabel(active);
  const openRelay = () => void relay.api.openPage("genel");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Claude Desktop’ta açık", "Open in Claude Desktop")}</span>
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <StatusDot tone={running ? "ok" : "off"} />
          {running ? t("Çalışıyor", "Running") : t("Kapalı", "Closed")}
        </span>
      </div>
      <div className={panelCard}>
        {!active ? (
          <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
            {t(
              "Claude’da kayıtlı hesap açık değil",
              "No saved account is open in Claude",
            )}{" "}
            ·
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-[12.5px]"
              onClick={openRelay}
            >
              {t("Relay’i aç", "Open Relay")}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-bold">
              <span className="truncate">{active.name}</span>
              {plan && <Badge variant="secondary">{plan}</Badge>}
            </div>
            {freshUsage(usage, now) ? (
              <div className="mt-1 grid gap-2">
                {usageWindowRows(usage).map((row) => (
                  <LimitMeter
                    key={row.key}
                    label={t(row.label.tr, row.label.en)}
                    percent={row.usedPercent}
                    detail={
                      row.resetsAt
                        ? formatReset(
                            row.resetsAt,
                            now,
                            language,
                            relay.settings.planning.timeZone,
                          )
                        : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                {t("Limit verisi eski", "Usage data is out of date")} ·
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("Limitleri yenile", "Refresh limits")}
                  disabled={relay.usageBusy.has(active.id)}
                  onClick={() => void relay.refreshUsage(active)}
                >
                  <RefreshCw />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {relay.desktopBusy ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {t("Desktop işlemi sürüyor", "A Desktop operation is in progress")}
        </p>
      ) : desktop?.recoveryRequired ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground">
          {t(
            "Önce Desktop yedeğini geri yükle",
            "Restore the Desktop backup first",
          )}{" "}
          ·
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-[11.5px]"
            onClick={openRelay}
          >
            {t("Relay’i aç", "Open Relay")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
