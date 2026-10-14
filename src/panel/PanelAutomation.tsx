import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { nextPlannedWindow } from "@/lib/day-timeline";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";
import { fleetStatusLabel } from "../features/FleetSettings";
import { panelEyebrow } from "./PanelActiveCard";

function Pill({
  on,
  label,
  title,
  page,
}: {
  on: boolean;
  label: string;
  title?: string;
  page: PageId;
}) {
  const relay = useRelay();
  return (
    <Button
      variant="outline"
      size="xs"
      title={title}
      className="h-auto max-w-full rounded-full px-2 py-0.5 text-[11px] font-normal"
      onClick={() => void relay.api.openPage(page)}
    >
      <StatusDot tone={on ? "ok" : "off"} className="size-[7px]" />
      <span className="truncate">{label}</span>
    </Button>
  );
}

/** Automation at a glance; each pill opens its page in the main window. */
export function PanelAutomation({ now }: { now: number }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { accounts, settings } = relay;
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const fleet = relay.data?.fleet;
  const planning = settings.planning;
  const next = planning.autoStart
    ? nextPlannedWindow(planning, accounts, relay.data?.planning, now)
    : undefined;
  const planLabel = !planning.autoStart
    ? t("Otomatik başlatma kapalı", "Automatic start off")
    : next
      ? t(
          `Sonraki başlatma ${formatClock(next.at, language, planning.timeZone)} · ${name(next.accountId)}`,
          `Next start ${formatClock(next.at, language, planning.timeZone)} · ${name(next.accountId)}`,
        )
      : t("Otomatik başlatma açık", "Automatic start on");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Otomasyon", "Automation")}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Pill
          on={!!fleet?.enabled}
          label={t("Kota dolunca devam", "Continue at quota")}
          title={fleetStatusLabel(fleet, name, t)}
          page="gecis"
        />
        <Pill on={planning.autoStart} label={planLabel} page="planlama" />
        <Pill
          on={settings.autoSwitchMode !== "off"}
          label={t("Kapanınca hazırla", "Prepare on quit")}
          page="gecis"
        />
      </div>
    </section>
  );
}
