import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";
import { fleetStatusLabel } from "../../FleetSettings";
import { nextPlannedWindow } from "./TodayCard";

function Row({
  title,
  status,
  control,
}: {
  title: string;
  status: string;
  control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t py-2 first:border-0">
      <div className="min-w-0">
        <div className="text-sm font-semibold">{title}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {status}
        </div>
      </div>
      {control}
    </div>
  );
}

export function AutomationCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { api, accounts, settings, action } = relay;
  const disabled = !!relay.busy || !!relay.desktop?.busy;
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const fleet = relay.data?.fleet;
  const planning = settings.planning;
  const next = planning.autoStart
    ? nextPlannedWindow(planning, accounts, relay.data?.planning, now)
    : undefined;
  const prepare = settings.autoSwitchMode !== "off";
  // Same platform gate as the Geçiş page's "after exit" option.
  const platform = relay.data?.diagnostics?.platform;
  const prepareSupported = platform === "darwin" || platform === "preview";
  return (
    <Card className="gap-0 px-4 py-3.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">{t("Otomasyon", "Automation")}</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          onClick={() => go("gecis")}
        >
          {t("Geçiş →", "Switching →")}
        </Button>
      </div>
      <div>
        <Row
          title={t(
            "Kota dolunca geçiş ve devam",
            "Switch and continue at quota",
          )}
          status={fleetStatusLabel(fleet, name, t)}
          control={
            <Switch
              aria-label={t(
                "Kota dolunca geçiş ve devam",
                "Switch and continue at quota",
              )}
              checked={!!fleet?.enabled}
              disabled={disabled}
              onCheckedChange={(v) =>
                void action("fleet", () => api.setFleetContinuation(v))
              }
            />
          }
        />
        <Row
          title={t("Otomatik pencere başlatma", "Automatic window start")}
          status={
            !planning.autoStart
              ? t("Kapalı", "Off")
              : next
                ? t(
                    `Sonraki ${formatClock(next.at, language, planning.timeZone)} ${name(next.accountId)}`,
                    `Next ${formatClock(next.at, language, planning.timeZone)} ${name(next.accountId)}`,
                  )
                : t("Açık", "On")
          }
          control={
            <Switch
              aria-label={t(
                "Otomatik pencere başlatma",
                "Automatic window start",
              )}
              checked={planning.autoStart}
              disabled={disabled}
              onCheckedChange={(v) =>
                void action("planning", () =>
                  api.updatePlanning({ autoStart: v }),
                )
              }
            />
          }
        />
        <Row
          title={t("Claude kapanınca hazırla", "Prepare when Claude quits")}
          status={prepare ? t("Açık", "On") : t("Kapalı", "Off")}
          control={
            <Switch
              aria-label={t(
                "Claude kapanınca hazırla",
                "Prepare when Claude quits",
              )}
              checked={prepare}
              disabled={disabled || (!prepare && !prepareSupported)}
              onCheckedChange={(v) =>
                void action("settings", () =>
                  api.updateSettings({
                    autoSwitchMode: v ? "after-exit" : "off",
                  }),
                )
              }
            />
          }
        />
      </div>
    </Card>
  );
}
