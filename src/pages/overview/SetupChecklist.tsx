import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import {
  cliDetail,
  codeTabStep,
  prerequisites,
  type PrerequisiteKey,
} from "@/lib/onboarding";
import { CliSetupActions } from "../../features/CliSetup";
import { ClaudeAppActions } from "../../features/ClaudeAppSetup";

interface Row {
  title: string;
  status: string;
  reason: string;
  action?: ReactNode;
}

/** What Relay needs before it can switch, shown on the Overview until all three are met. */
export function SetupChecklist() {
  const relay = useRelay();
  const { t } = useI18n();
  const { desktop, accounts } = relay;
  const diagnostics = relay.data?.diagnostics;
  const state = prerequisites({ desktop, diagnostics, accounts });
  if (!state || state.complete) return null;
  const met = (key: PrerequisiteKey) =>
    !!state.items.find((i) => i.key === key)?.met;
  const title = t("Başlamadan önce", "Before you start");
  const rows: Record<PrerequisiteKey, Row> = {
    desktop: {
      title: t("Claude uygulaması", "Claude app"),
      status: met("desktop") ? t("Bulundu", "Found") : t("Bulunamadı", "Not found"),
      reason: t(
        "Relay, Claude uygulamasında hesaplar arasında geçiş yapar.",
        "Relay switches the Claude app between accounts.",
      ),
      action: <ClaudeAppActions />,
    },
    cli: {
      title: "Claude Code CLI",
      status: cliDetail(state.cli, diagnostics?.version, t),
      reason: t("Limitleri okumak için gerekir.", "Needed to read usage limits."),
      action: <CliSetupActions />,
    },
    code: {
      title: t("Code sekmesi açıldı", "Code tab opened"),
      status: met("code")
        ? t("Çalışma alanı bulundu", "Workspace found")
        : t("Henüz açılmadı", "Not opened yet"),
      reason: codeTabStep(t),
      // Without the Claude app the first row already names the step.
      action: desktop?.available && (
        <Button
          variant="outline"
          size="sm"
          disabled={relay.desktopBusy}
          onClick={() =>
            void relay.action("open", () => relay.api.openDesktop())
          }
        >
          {t("Claude uygulamasını aç", "Open the Claude app")}
        </Button>
      ),
    },
  };
  return (
    <Card className="gap-0 px-4 py-3.5" role="region" aria-label={title}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <span className="text-xs text-muted-foreground">
          {`${state.items.filter((i) => i.met).length} / ${state.items.length}`}
        </span>
      </div>
      <ul>
        {state.items.map(({ key, met }) => {
          const row = rows[key];
          return (
            <li
              key={key}
              data-prerequisite={key}
              data-met={String(met)}
              className="flex items-start gap-2.5 border-t py-2.5 first:border-0"
            >
              {met ? (
                <Check
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-ok-foreground"
                />
              ) : (
                <X aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-crit" />
              )}
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-semibold">{row.title}</span>
                  <span className="sr-only">
                    {met ? t("Tamam", "Done") : t("Eksik", "Missing")}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {row.status}
                  </span>
                </div>
                {!met && (
                  <>
                    <p className="text-xs text-muted-foreground">{row.reason}</p>
                    {row.action && <div>{row.action}</div>}
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
