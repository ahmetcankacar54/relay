import { KeyRound, RefreshCw } from "lucide-react";
import { freshUsage } from "../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LimitMeter } from "@/components/LimitMeter";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { pendingFlow, usageWindowRows } from "@/data/selectors";
import { accountHealth, renewalIssue } from "@/lib/account-health";
import { formatReset } from "@/lib/time";
import { planLabel } from "../pages/accounts/accountLabels";

export const panelEyebrow =
  "mb-1.5 flex items-center justify-between gap-2 text-[10.5px] font-semibold tracking-wider text-muted-foreground uppercase";
export const panelCard = "rounded-[10px] border bg-card px-3 py-2.5";

/** The pending-Desktop hint links to the accounts page, where it is completed. */
export const openPendingDesktop = (relay: Pick<Relay, "api">) =>
  void relay.api.openPage("hesaplar");

/** The account open in Claude Desktop, with its limits. */
export function PanelActiveCard({ now }: { now: number }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { active, desktop } = relay;
  const running = !!desktop?.running;
  const usage = active ? relay.data?.usage[active.id] : undefined;
  const plan = active && planLabel(active);
  // The account's status, the one the Accounts page shows, explains limits that cannot be read.
  const health =
    active &&
    accountHealth(
      active,
      usage,
      {
        active: true,
        desktopRunning: running,
        waiting: pendingFlow(
          relay.data?.authFlows.find((f) => f.accountId === active.id),
        ),
      },
      t,
    );
  // A plain refresh cannot clear a locked Keychain or a connection to renew: it has to prompt.
  const renew = health?.fix === "renew";
  const openRelay = () => void relay.api.openPage("genel");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Claude uygulamasında açık", "Open in the Claude app")}</span>
        <span className="flex items-center gap-1.5 normal-case tracking-normal">
          <StatusDot tone={running ? "ok" : "off"} />
          {running ? t("Çalışıyor", "Running") : t("Kapalı", "Closed")}
        </span>
      </div>
      <div className={panelCard}>
        {!active ? (
          <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
            {t(
              "Claude uygulamasında kayıtlı hesap açık değil",
              "No saved account is open in the Claude app",
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
              <span className="truncate" title={active.name}>
                {active.name}
              </span>
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
                {health && health.tone !== "ok"
                  ? health.label
                  : t("Limit verisi eski", "Usage data is out of date")}{" "}
                ·
                {renew ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={
                      renewalIssue(usage) === "keychain-locked"
                        ? t(
                            "Anahtarlık erişimine izin ver",
                            "Allow Keychain access",
                          )
                        : t("Yenilemeye izin ver", "Allow renewal")
                    }
                    disabled={relay.usageBusy.has(active.id)}
                    onClick={() => void relay.refreshUsage(active, true)}
                  >
                    <KeyRound />
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("Limitleri yenile", "Refresh limits")}
                    disabled={relay.usageBusy.has(active.id)}
                    onClick={() => void relay.refreshUsage(active)}
                  >
                    <RefreshCw />
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {relay.desktopBusy ? (
        <p className="mt-1.5 text-[11.5px] text-muted-foreground">
          {t("Claude uygulaması işlemi sürüyor", "A Claude app operation is in progress")}
        </p>
      ) : desktop?.recoveryRequired ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground">
          {t(
            "Önce yedeği geri yükle",
            "Restore the backup first",
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
      ) : relay.pendingDesktop ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11.5px] text-muted-foreground">
          {t(
            "Claude uygulaması girişi tamamlanmayı bekliyor",
            "Claude app sign-in is waiting to be completed",
          )}{" "}
          ·
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-[11.5px]"
            onClick={() => openPendingDesktop(relay)}
          >
            {t("Relay’i aç", "Open Relay")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
