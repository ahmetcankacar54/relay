import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { PlanningPanel } from "../features/PlanningPanel";

/** Settings → Planning: work hours, tempo, early start and each account's plan. */
export function PlanningTab() {
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
