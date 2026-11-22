import { KeyRound } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import type { AccountUsage } from "../../shared/types";
import { freshUsage, lastKnownUsage, windowHolds } from "../../shared/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AccountLimits } from "../features/Providers";
import { StatusDot } from "@/components/StatusDot";
import { useI18n } from "@/data/i18n";
import { useRelay, type Relay } from "@/data/relay-context";
import { keychainWords } from "@/data/platform";
import { pendingFlow, usageWindowRows } from "@/data/selectors";
import { accountHealth, renewalIssue } from "@/lib/account-health";
import { formatRelative, formatReset } from "@/lib/time";
import { accountPlan } from "../pages/accounts/accountLabels";

export const panelEyebrow =
  "mb-1 flex items-center justify-between gap-2 px-1 text-2xs font-medium text-muted-foreground";
export const panelCard = "rounded-[10px] border bg-card px-3 py-2.5";

/** The pending-Desktop hint links to the accounts page, where it is completed. */
export const openPendingDesktop = (relay: Pick<Relay, "api" | "report">) =>
  void relay.report(() => relay.api.openPage("hesaplar"));

/** A reading the card keeps, faded: last known, with neither window reset since. */
function keepsLastKnown(usage: AccountUsage | undefined, now: number): boolean {
  return (
    lastKnownUsage(usage, now) &&
    [usage.fiveHour, usage.sevenDay].every((w) => !w || windowHolds(w, now))
  );
}

/** The account open in Claude Desktop, with its limits. */
export function PanelActiveCard({ now }: { now: number }) {
  const relay = useRelay();
  const { t, language } = useI18n();
  const { active, desktop } = relay;
  const running = !!desktop?.running;
  const usage = active ? relay.data?.usage[active.id] : undefined;
  // The same plan name as everywhere else, the detected one included.
  const plan = active ? accountPlan(active)?.short : undefined;
  const waiting =
    !!active &&
    pendingFlow(relay.data?.authFlows.find((f) => f.accountId === active.id));
  // The account's status, the one the Accounts page shows, explains limits that cannot be read.
  const health =
    active &&
    accountHealth(
      active,
      usage,
      { active: true, desktopRunning: running, waiting, platform: relay.data?.diagnostics?.platform, language },
      t,
    );
  // A plain refresh cannot clear a locked Keychain or a connection to renew: it has to prompt.
  const renew = health?.fix === "renew";
  const readAt = usage?.checkedAt;
  const fresh = freshUsage(usage, now);
  // A reading old only because the service could not be reached (or that has just grown old) keeps
  // its rings, faded on a dashed track, until a window resets; a problem the user must fix does not.
  const lastKnown = !fresh && !health?.fix && keepsLastKnown(usage, now);
  const openRelay = () => void relay.report(() => relay.api.openPage("genel"));
  const usageButton =
    active &&
    (renew ? (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={
          renewalIssue(usage) === "keychain-locked"
            ? keychainWords(relay.data?.diagnostics?.platform, t).allow
            : t("common.allowRenewal")
        }
        disabled={relay.usageBusy.has(active.id)}
        onClick={() => void relay.refreshUsage(active, true)}
      >
        <KeyRound />
      </Button>
    ) : (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("common.refreshLimits")}
        disabled={relay.usageBusy.has(active.id)}
        onClick={() => void relay.refreshUsage(active)}
      >
        <RefreshIcon />
      </Button>
    ));
  const title = active && (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-sm font-bold" title={active.name}>
        {active.name}
      </span>
      {plan && <Badge variant="secondary">{plan}</Badge>}
      <span
        className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
        title={t("panelActiveCard.theAccountOpenInTheClaude")}
      >
        <StatusDot tone={running ? "ok" : "off"} />
        {running ? t("panelActiveCard.claudeOpen") : t("common.claudeClosed")}
      </span>
    </div>
  );
  return (
    <section className="px-3 py-1.5">
      <div className={panelCard}>
        {!active ? (
          <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
            {t("panelActiveCard.noSavedAccountIsOpenIn")}{" "}
            ·
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={openRelay}
            >
              {t("common.openRelay")}
            </Button>
          </div>
        ) : fresh ? (
          <div className="grid gap-2">
            {title}
            <AccountLimits usage={usage} now={now} size="sm" />
          </div>
        ) : lastKnown ? (
          <div className="grid gap-2">
            {title}
            <AccountLimits usage={usage} now={now} size="sm" note={false} />
            <div className="flex items-center gap-1 text-2xs text-muted-foreground">
              {waiting && health
                ? health.label
                : t("panelActiveCard.usageDataIsOutOfDate", { formatRelative: formatRelative(readAt!, now, language) })}{" "}
              · {usageButton}
            </div>
          </div>
        ) : (
          <>
            {title}
            <div className="mt-1 flex items-center gap-1 text-muted-foreground">
              {health && health.tone !== "ok"
                ? health.label
                : t("panelActiveCard.usageDataIsOutOfDate2")}{" "}
              ·{usageButton}
            </div>
          </>
        )}
      </div>
      {relay.desktopBusy ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("panelActiveCard.aClaudeAppActionIsRunning")}
        </p>
      ) : desktop?.recoveryRequired ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {t("panelActiveCard.restoreTheBackupFirst")}{" "}
          ·
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={openRelay}
          >
            {t("common.openRelay")}
          </Button>
        </p>
      ) : relay.pendingDesktop ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {t("panelActiveCard.finishTheClaudeAppSignIn")}{" "}
          ·
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 text-xs"
            onClick={() => openPendingDesktop(relay)}
          >
            {t("common.openRelay")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
