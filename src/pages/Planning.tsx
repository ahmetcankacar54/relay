import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { PageBody, PageFrame } from "@/app/PageFrame";
import { useRiskConsent } from "@/components/RiskConsent";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { PlanningPanel, planningHeadline, planningModel } from "../features/PlanningPanel";
import { planningRisks } from "../../shared/feature-risk";

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
  const { t, language } = useI18n();
  const consent = useRiskConsent();
  return (
    <>
        <PlanningPanel
          settings={settings.planning}
          keeper={data?.planning}
          accounts={accounts}
          usage={data?.usage ?? {}}
          activeId={active?.id}
          disabled={!!busy || !!desktop?.busy}
          t={t}
          language={language}
          platform={data?.diagnostics?.platform}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={onSettingsOpenChange}
          update={(patch) =>
            // Early start sends prompts for the user: it waits for its risk to be accepted.
            void consent.ask(planningRisks(settings.planning, patch)).then(
              (accepted) => accepted && action("planning", () => api.updatePlanning(patch)),
            )
          }
          updateAccount={(id, input) =>
            void action(`plan:${id}`, () =>
              api.updateAccountPlanning(id, input),
            )
          }
        />
        {consent.dialog}
    </>
  );
}

/**
 * Planning as its own page: the header says how the day goes in one line and opens the plan's
 * settings; the page is the plan itself.
 */
export function PlanningScreen() {
  const { data, accounts, active, settings } = useRelay();
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const model = planningModel({
    settings: settings.planning,
    keeper: data?.planning,
    accounts,
    usage: data?.usage ?? {},
    activeId: active?.id,
    t,
    language,
  });
  return (
    <PageFrame
      title={t("planning.planning")}
      description={planningHeadline(model, t)}
      actions={
        <Button variant="outline" onClick={() => setOpen(true)}>
          <SlidersHorizontal />
          {t("planning.planSettings")}
        </Button>
      }
    >
      <PageBody>
        <PlanningTab settingsOpen={open} onSettingsOpenChange={setOpen} />
      </PageBody>
    </PageFrame>
  );
}
