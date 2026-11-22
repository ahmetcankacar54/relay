import { ChevronRight } from "lucide-react";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { nextPlannedWindow, nextStartLabel } from "@/lib/day-timeline";
import { formatClock } from "@/lib/time";
import type { PageId } from "@/app/routes";
import {
  AUTOMATION_DOT,
  automationModeCopy,
  useAutomation,
} from "../features/useAutomation";
import { panelCard, panelEyebrow } from "./PanelActiveCard";

/** A setting at a glance: its name, its state and the page it opens in the main window. */
function Row({
  tone,
  name,
  value,
  title,
  page,
}: {
  tone: "ok" | "warn" | "crit" | "off";
  name: string;
  value: string;
  title?: string;
  page: PageId;
}) {
  const relay = useRelay();
  return (
    <button
      type="button"
      title={title}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
      onClick={() => void relay.report(() => relay.api.openPage(page))}
    >
      <StatusDot tone={tone} className="size-[7px]" />
      <span className="shrink-0">{name}</span>
      <span className="ml-auto min-w-0 truncate text-muted-foreground">{value}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
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
    ? t("common.off")
    : deferred
      ? t("panelAutomation.planAdapted", { name: name(deferred.accountId), clock: clock(deferred.startAt) })
      : next
        ? nextStartLabel(
            name(next.accountId),
            next.at,
            now,
            planning.timeZone,
            language,
          )
        : t("panelAutomation.on");
  return (
    <section className="px-3 py-1.5">
      <div className={panelEyebrow}>
        <span>{t("panelAutomation.automation")}</span>
      </div>
      <div className={`${panelCard} grid px-1.5 py-1`}>
        <Row
          tone={AUTOMATION_DOT[automation.status.tone]}
          name={t("panelAutomation.automaticSwitching")}
          value={t(automationModeCopy(automation.mode).label)}
          title={automation.status.text}
          page="gecis"
        />
        <Row
          tone={planning.autoStart ? "ok" : "off"}
          name={t("panelAutomation.earlyStart")}
          value={planLabel}
          title={
            planning.autoStart && !deferred && next
              ? t("panelAutomation.nextStart", { planLabel })
              : undefined
          }
          page="planlama"
        />
      </div>
    </section>
  );
}
