import { useState, type ReactNode } from "react";
import { Check, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useI18n } from "@/data/i18n";
import { useRelay } from "@/data/relay-context";
import { macWording } from "@/data/platform";
import {
  cliDetail,
  cliState,
  setupState,
  type SetupKey,
} from "@/lib/onboarding";
import { automationMode } from "../../../shared/automation-mode";
import { MODE_TITLE } from "../../features/AutomationControl";
import { intentHash, type Destination } from "@/app/routes";
import { cn } from "@/lib/utils";
import { CliSetupActions } from "../../features/CliSetup";
import { ClaudeAppActions } from "../../features/ClaudeAppSetup";

/** The rows the list shows: the two account steps read as one. */
type RowKey = Exclude<SetupKey, "first" | "second"> | "accounts";

interface Row {
  title: string;
  status: string;
  reason: string;
  action?: ReactNode;
}

/** Where the steps the user settled by hand are kept: "mode", "extension", "hidden". */
const STORAGE_KEY = "relay.setup.v1";

function loadSeen(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    // No window (a static render) or unreadable storage: nothing settled yet.
  }
  return new Set();
}

/** The settled steps, kept across windows and restarts where storage allows. */
function useSeen(): [ReadonlySet<string>, (key: string) => void] {
  const [seen, setSeen] = useState(loadSeen);
  const add = (key: string) =>
    setSeen((current) => {
      const next = new Set(current).add(key);
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Without storage the choice lasts until the window closes.
      }
      return next;
    });
  return [seen, add];
}

/**
 * "Set up Relay" on the Overview: what Relay needs before it can switch (the Claude app, Code,
 * the CLI when missing), then a first and a second account, when to switch, and on macOS the
 * optional browser extension. The prerequisites show their reasons at once; the later steps
 * open one at a time, after every required step before them. Gone once everything is settled,
 * or when hidden.
 */
export function SetupChecklist({ go }: { go?: (to: Destination) => void }) {
  const relay = useRelay();
  const { t } = useI18n();
  const [seen, settle] = useSeen();
  const { desktop, accounts, settings } = relay;
  const diagnostics = relay.data?.diagnostics;
  const fleet = relay.data?.fleet;
  const state = setupState({
    desktop,
    diagnostics,
    accounts,
    settings,
    quota: automationMode(settings, fleet) === "quota",
    seen,
  });
  if (!state || state.complete || seen.has("hidden")) return null;
  const open = (to: Destination) => (go ? go(to) : (window.location.hash = `#/${to}`));
  const add = () => {
    window.location.hash = intentHash("hesaplar", "ekle");
  };
  const met = (key: SetupKey) => !!state.steps.find((s) => s.key === key)?.met;
  const connected = accounts.filter((a) => !!a.desktop).length;
  const mode = automationMode(settings, fleet);
  const title = t("setupChecklist.setUpRelay");
  const rows: Record<RowKey, Row> = {
    desktop: {
      title: t("common.claudeApp"),
      status: met("desktop") ? t("setupChecklist.found") : t("common.notFound"),
      reason: t("setupChecklist.relayNeedsTheClaudeApp"),
      action: <ClaudeAppActions />,
    },
    cli: {
      title: "Claude Code CLI",
      status: cliDetail(cliState(diagnostics), diagnostics?.version, t),
      reason: t("setupChecklist.relayUsesItToReadThe"),
      action: <CliSetupActions />,
    },
    code: {
      title: t("setupChecklist.codeTabOpened"),
      status: met("code")
        ? t("setupChecklist.workspaceFound")
        : t("setupChecklist.notOpenedYet"),
      reason: t("setupChecklist.openCodeOneTimeFromThe"),
      // Without the Claude app the first row already names the step.
      action: desktop?.available && (
        <Button
          variant="outline"
          size="sm"
          disabled={relay.desktopBusy}
          onClick={() =>
            void relay.action("open", () => relay.api.openCodeTab())
          }
        >
          {t("common.openCode")}
        </Button>
      ),
    },
    accounts: {
      title: t("setupChecklist.addYourAccounts"),
      status: `${connected} / 2`,
      reason:
        connected === 0
          ? macWording(diagnostics?.platform)
            ? t("setupChecklist.relaySwitchesBetweenAccountsSoIt")
            : t("setupChecklist.relaySwitchesBetweenAccountsSoIt2")
          : t("setupChecklist.oneMoreAccountIsNeededSign"),
      // With no account yet the welcome card above holds the button; one offer is enough.
      action: connected > 0 && (
        <Button variant="outline" size="sm" onClick={add}>
          {t("common.addAccount")}
        </Button>
      ),
    },
    mode: {
      title: t("setupChecklist.chooseWhenToSwitch"),
      status: met("mode") ? t(MODE_TITLE[mode]) : t("setupChecklist.notChosen"),
      reason: t("setupChecklist.doYouSwitchYourselfOrDoes"),
      action: (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            settle("mode");
            open("gecis");
          }}
        >
          {t("setupChecklist.choose")}
        </Button>
      ),
    },
    extension: {
      title: t("setupChecklist.letTheBrowserExtensionSwitchToo"),
      status: met("extension")
        ? t("setupChecklist.on")
        : seen.has("extension")
          ? t("setupChecklist.skipped")
          : t("setupChecklist.optional"),
      reason: t("setupChecklist.ifYouUseClaudeInChrome"),
      action: (
        <span className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => open("gecis")}>
            {t("setupChecklist.setUp")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => settle("extension")}>
            {t("setupChecklist.skip")}
          </Button>
        </span>
      ),
    },
  };
  // The two account steps are one row: met once the second account is there.
  type Step = { key: RowKey; met: boolean; optional: boolean };
  const steps: Step[] = state.steps.flatMap((step): Step[] =>
    step.key === "first" ? [] : [{ ...step, key: step.key === "second" ? "accounts" : step.key }],
  );
  const settled = (s: (typeof steps)[number]) => s.met || (s.optional && seen.has(s.key));
  const finished = steps.filter(settled);
  const pending = steps.filter((s) => !settled(s));
  const prerequisite = (key: RowKey) => key === "desktop" || key === "code" || key === "cli";
  // Prerequisites show their reasons at once; the later steps open one at a time, in order.
  const current = pending.find((s) => !prerequisite(s.key))?.key;
  const blocked = pending.some((s) => prerequisite(s.key) && !s.optional);
  return (
    <Card className="gap-0 px-4 py-3" role="region" aria-label={title}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {`${finished.length} / ${steps.length}`}
          {state.ready && (
            <Button variant="ghost" size="xs" onClick={() => settle("hidden")}>
              {t("common.hide")}
            </Button>
          )}
        </span>
      </div>
      <ul>
        {finished.length > 0 && (
          <li data-step="done" className="flex items-start gap-2.5 py-2 text-sm text-muted-foreground">
            <Check aria-hidden="true" className="mt-px size-4 shrink-0 text-ok-foreground" />
            <span className="min-w-0">
              <span className="sr-only">{t("setupChecklist.done")}</span>
              {finished.map((s) => rows[s.key].title).join(" · ")}
            </span>
          </li>
        )}
        {pending.map(({ key, optional }) => {
          const row = rows[key];
          const expanded = prerequisite(key) || (key === current && !blocked);
          return (
            <li
              key={key}
              data-step={key}
              data-met="false"
              className="flex items-start gap-2.5 border-t py-2 first:border-0"
            >
              {prerequisite(key) ? (
                <X aria-hidden="true" className="mt-px size-4 shrink-0 text-crit" />
              ) : (
                <Circle
                  aria-hidden="true"
                  className={cn("mt-px size-4 shrink-0", expanded ? "text-foreground" : "text-muted-foreground/50")}
                />
              )}
              <div className="grid min-w-0 flex-1 gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className={cn("font-semibold", !expanded && "font-normal text-muted-foreground")}>
                    {row.title}
                  </span>
                  <span className="sr-only">{optional ? t("setupChecklist.optional") : t("setupChecklist.missing")}</span>
                  <span className="text-xs text-muted-foreground">{row.status}</span>
                </div>
                {expanded && (
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
