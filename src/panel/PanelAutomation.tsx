import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { nextPlannedWindow } from "@/lib/day-timeline";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";
import {
  AUTOMATION_DOT,
  automationModeCopy,
  useAutomation,
} from "../features/useAutomation";
import { panelEyebrow } from "./PanelActiveCard";

function Pill({
  tone,
  label,
  title,
  page,
}: {
  tone: "ok" | "warn" | "crit" | "off";
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
      className="h-auto max-w-full rounded-full px-2 py-0.5 text-xs font-normal"
      onClick={() => void relay.api.openPage(page)}
    >
      <StatusDot tone={tone} className="size-[7px]" />
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
  const automation = useAutomation(now);
  const planning = settings.planning;
  const clock = (time: string) =>
    formatClock(time, language, planning.timeZone);
  const next = planning.autoStart
    ? nextPlannedWindow(planning, accounts, relay.data?.planning, now)
    : undefined;
  // The earliest start the keeper moved today (its schedule is earliest first).
  const deferred =
    planning.autoStart && planning.adaptive !== false
      ? relay.data?.planning?.adaptation?.schedule.find((s) =>
          Number.isFinite(Date.parse(s.startAt)),
        )
      : undefined;
  const planLabel = !planning.autoStart
    ? t("Önceden başlatma kapalı", "Early start off")
    : deferred
      ? t(
          `Uyarlandı · ${name(deferred.accountId)} ${clock(deferred.startAt)}`,
          `Adapted · ${name(deferred.accountId)} ${clock(deferred.startAt)}`,
        )
      : next
        ? t(
            `Sonraki başlatma ${clock(next.at)} · ${name(next.accountId)}`,
            `Next start ${clock(next.at)} · ${name(next.accountId)}`,
          )
        : t("Önceden başlatma açık", "Early start on");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("Otomasyon", "Automation")}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Pill
          tone={AUTOMATION_DOT[automation.status.tone]}
          label={`${t("Otomatik geçiş", "Automatic switching")} · ${t(...automationModeCopy(automation.mode).label)}`}
          title={t(...automation.status.text)}
          page="gecis"
        />
        <Pill
          tone={planning.autoStart ? "ok" : "off"}
          label={planLabel}
          page="planlama"
        />
      </div>
    </section>
  );
}
