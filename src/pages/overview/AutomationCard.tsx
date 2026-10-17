import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { OptionSelect } from "@/components/SettingRow";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";
import { AutomationStatusLine } from "../../features/AutomationControl";
import { useAutomation } from "../../features/useAutomation";
import { AUTOMATION_MODES } from "../../../shared/automation-mode";
import { nextPlannedWindow } from "@/lib/day-timeline";

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
        <div className="truncate text-xs text-muted-foreground">
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
  const automation = useAutomation(now);
  const planning = settings.planning;
  const next = planning.autoStart
    ? nextPlannedWindow(planning, accounts, relay.data?.planning, now)
    : undefined;
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
        <div className="grid gap-1 border-t py-2 first:border-0">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="automation-mode" className="text-sm font-semibold">
              {t("Otomatik geçiş", "Automatic switching")}
            </label>
            <OptionSelect
              id="automation-mode"
              className="min-w-36"
              value={automation.mode}
              disabled={automation.locked}
              onChange={automation.setMode}
              options={AUTOMATION_MODES.map((m) => ({
                value: m.value,
                label: t(...m.label),
                disabled: m.value !== "off" && !automation.supported,
              }))}
            />
          </div>
          <AutomationStatusLine status={automation.status} compact />
        </div>
        <Row
          title={t(
            "Limit dönemlerini önceden başlat",
            "Start limit periods early",
          )}
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
                "Limit dönemlerini önceden başlat",
                "Start limit periods early",
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
      </div>
    </Card>
  );
}
