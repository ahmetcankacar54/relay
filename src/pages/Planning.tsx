import { PageFrame } from "@/app/PageFrame";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { PlanningPanel } from "../features/PlanningPanel";

export function Planning() {
  const { api, data, accounts, settings, busy, desktop, action } = useRelay();
  const { t } = useI18n();
  return (
    <PageFrame
      title={t("Planlama", "Planning")}
      description={t("Otomatik pencere başlatma", "Automatic window start")}
    >
      <div className="px-6 pb-6">
        <PlanningPanel
          settings={settings.planning}
          keeper={data?.planning}
          accounts={accounts}
          usage={data?.usage ?? {}}
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
      </div>
    </PageFrame>
  );
}
