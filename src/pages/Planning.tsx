import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { PageFrame } from "@/app/PageFrame";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { PlanningPanel, planningHeadline, planningModel } from "../features/PlanningPanel";

/** The day's plan and the plan's accounts; the settings open in a sheet from the page header. */
export function PlanningTab({
  settingsOpen,
  onSettingsOpenChange,
}: {
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
} = {}) {
  const { api, data, accounts, active, settings, busy, desktop, action } =
    useRelay();
  const { t } = useI18n();
  return (
        <PlanningPanel
          settings={settings.planning}
          keeper={data?.planning}
          accounts={accounts}
          usage={data?.usage ?? {}}
          activeId={active?.id}
          disabled={!!busy || !!desktop?.busy}
          t={t}
          platform={data?.diagnostics?.platform}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={onSettingsOpenChange}
          update={(patch) =>
            void action("planning", () => api.updatePlanning(patch))
          }
          updateAccount={(id, input) =>
            void action(`plan:${id}`, () =>
              api.updateAccountPlanning(id, input),
            )
          }
        />
  );
}

/**
 * Planning as its own page: the header says how the day goes in one line and opens the plan's
 * settings; the page is the plan itself.
 */
export function PlanningScreen() {
  const { data, accounts, active, settings } = useRelay();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const model = planningModel({
    settings: settings.planning,
    keeper: data?.planning,
    accounts,
    usage: data?.usage ?? {},
    activeId: active?.id,
    t,
  });
  return (
    <PageFrame
      title={t("Planlama", "Planning")}
      description={planningHeadline(model, t)}
      actions={
        <Button variant="outline" onClick={() => setOpen(true)}>
          <SlidersHorizontal />
          {t("Plan ayarları", "Plan settings")}
        </Button>
      }
    >
      <div className="grid gap-4 px-5 pb-6">
        <PlanningTab settingsOpen={open} onSettingsOpenChange={setOpen} />
      </div>
    </PageFrame>
  );
}
