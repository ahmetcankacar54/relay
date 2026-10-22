import { ChevronRight } from "lucide-react";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { useExtensionStatus } from "@/data/useExtension";
import { instanceLabel } from "@/lib/extension-ui";
import type { PageId } from "@/app/routes";
import { AUTOMATION_DOT, automationModeCopy, useAutomation } from "../../features/useAutomation";
import { nextPlannedWindow, nextStartLabel } from "@/lib/day-timeline";
import { SwitchNowButton } from "../../features/AutomationControl";

/** One setting at a glance: its name, its state, its page. */
function Row({
  name,
  value,
  detail,
  tone,
  onClick,
}: {
  name: string;
  value: string;
  detail?: string;
  tone?: "ok" | "warn" | "crit" | "off";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-3 border-t px-4 py-3 text-left outline-none first:border-0 hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring/50"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px]">{name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        {tone && <StatusDot tone={tone} />}
        {value}
      </span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

/**
 * Automation as a grouped list: each row says how a setting stands and opens its page; when
 * automatic switching offers a switch now, its button sits under that row.
 */
export function AutomationCard({
  go,
  now,
}: {
  go: (page: PageId) => void;
  now: number;
}) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { accounts, settings } = relay;
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const automation = useAutomation(now);
  const planning = settings.planning;
  const next = planning.autoStart
    ? nextPlannedWindow(planning, accounts, relay.data?.planning, now)
    : undefined;
  const extension = useExtensionStatus().status;
  const macOS = ["darwin", "preview"].includes(relay.data?.diagnostics?.platform ?? "");
  return (
    <section className="grid content-start gap-2">
      <h2 className="px-1 text-[13px] font-semibold text-muted-foreground">
        {t("Otomasyon", "Automation")}
      </h2>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Row
          name={t("Otomatik geçiş", "Automatic switching")}
          value={t(...automationModeCopy(automation.mode).label)}
          detail={t(...automation.status.text)}
          tone={AUTOMATION_DOT[automation.status.tone]}
          onClick={() => go("gecis")}
        />
        {/* The page banner is off here (automationInline), so the switch-now offer lives under its row. */}
        {automation.status.switchTo && (
          <div data-slot="automation-offer" className="flex justify-end border-t bg-muted/40 px-4 py-2">
            <SwitchNowButton status={automation.status} size="xs" />
          </div>
        )}
        <Row
          name={t("Önceden başlatma", "Early start")}
          detail={planning.autoStart && next ? t("Sonraki başlatma", "Next start") : undefined}
          value={
            !planning.autoStart
              ? t("Kapalı", "Off")
              : next
                ? nextStartLabel(name(next.accountId), next.at, now, planning.timeZone, language)
                : t("Açık", "On")
          }
          onClick={() => go("planlama")}
        />
        {macOS && extension && (
          <Row
            name={t("Tarayıcı eklentisi", "Browser extension")}
            value={
              extension.setting.mode === "off"
                ? t("Kapalı", "Off")
                : extension.target
                  ? t(`${instanceLabel(extension.target)} · izliyor`, `${instanceLabel(extension.target)} · following`)
                  : t("Tarayıcı seç", "Choose a browser")
            }
            onClick={() => go("gecis")}
          />
        )}
      </div>
    </section>
  );
}
