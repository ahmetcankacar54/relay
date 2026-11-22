import { useEffect, useId, useState } from "react";
import { Private } from "@/components/Private";
import { ArrowRight, Check, LoaderCircle, Pause, Play, ShieldCheck } from "lucide-react";
import { RefreshIcon } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Note, SectionHeading } from "@/components/SettingRow";
import { StatusDot } from "@/components/StatusDot";
import type { Account, AccountUsage, RelaySettings } from "../../shared/types";
import {
  continuationTargetReadinessReason,
  type ContinuationTargetReadinessReason,
} from "../../shared/continuation-readiness";
import type { MessageId, T } from "../../shared/i18n/translate";


/** The manager owns observation, eligibility and every Desktop action. */
export interface ContinuationSettingsView {
  status:
    | "off"
    | "armed"
    | "waiting"
    | "executing"
    | "continued"
    | "blocked"
    | "reconciliation-required";
  reason: string;
  enabled?: boolean;
  executable?: boolean;
  checkedAt?: string;
  sourceId?: string;
  targetId?: string;
  targetSelection?: "automatic";
  allowedTargetCount?: number;
  sessionId?: string;
  projectKey?: string;
  permissionMode?: string;
  requestId?: string;
}

const explanations: Record<string, MessageId> = {
  disabled: "continuationSettings.automaticSwitchingIsOff",
  armed: "continuationSettings.relayWaitsForThisConversationTo",
  "awaiting-quota-stop": "continuationSettings.relayWaitsForThisConversationTo2",
  "checkpointed-handoff": "continuationSettings.relayVerifiesTheSavedConversationTarget",
  "session-not-stopped": "continuationSettings.theResponseHasNotStoppedYet",
  "quota-stop-unverified": "continuationSettings.relayCannotVerifyThatThisResponse",
  "quota-checkpoint-changed": "continuationSettings.theRecordOfTheStoppedResponse",
  "own-quota-wakeup-can-takeover": "continuationSettings.claudesAutoContinueWhenLimitsReset",
  "own-quota-wakeup-uncertain": "continuationSettings.relayCannotConfirmThatItTurned",
  "quota-available": "continuationSettings.theLimitIsNotReachedRelay",
  "source-quota-available": "continuationSettings.theLimitIsNotReachedRelay",
  "quota-exhausted": "continuationSettings.theLimitIsReachedRelayWaits",
  "desktop-work-active": "continuationSettings.aTaskStillRunsRelayDoes",
  "workers-not-quiescent": "continuationSettings.aTaskRunsOrWaitsFor",
  "desktop-observation-incomplete": "continuationSettings.relayCannotVerifyThatAllTasks",
  "quiescence-unverified": "continuationSettings.relayCannotVerifyThatAllTasks",
  "coverage-unverified": "continuationSettings.relayCannotVerifyThatAllTasks",
  "observation-not-fresh": "continuationSettings.theConversationCheckIsOutOf",
  "desktop-observation-unavailable": "continuationSettings.relayCannotReadTheConversationAnd",
  "accessibility-permission-required": "continuationSettings.allowRelayInMacosAccessibilityTo",
  "unsupported-platform": "continuationSettings.automaticContinuationIsNotAvailableOn",
  "desktop-ui-unsupported": "continuationSettings.relayCannotVerifyTheConversationAnd",
  "adapter-contract-unverified": "continuationSettings.switchAndMessageChecksInThe",
  "claude-not-running": "continuationSettings.openTheClaudeAppAndSelect",
  "exact-session-not-observed": "continuationSettings.relayCannotVerifyTheOpenCode",
  "exact-session-unverified": "continuationSettings.relayCannotVerifyTheOpenCode",
  "composer-not-empty": "continuationSettings.theMessageFieldInTheClaude",
  "permission-mode-mismatch": "continuationSettings.thePermissionModeOfTheConversation",
  "permission-mode-changed": "continuationSettings.thePermissionModeIsNotThe",
  "source-account-changed": "continuationSettings.theOpenAccountIsNotThe",
  "selected-session-changed": "continuationSettings.aDifferentConversationIsOpenIn",
  "target-identity-changed": "continuationSettings.theSignInsOfTheTarget",
  "context-changed": "continuationSettings.theOpenAccountOrConversationChanged",
  "session-changed": "continuationSettings.theOpenConversationChangedThisWatch",
  "quota-not-fresh": "continuationSettings.noCurrentUsageDataYetRelay",
  "usage-not-fresh": "continuationSettings.noCurrentUsageDataYetRelay",
  "target-quota-unavailable": "continuationSettings.theCurrentLimitOfTheTarget",
  "automatic-target-unavailable": "continuationSettings.noConnectedAccountInTheShared",
  "automatic-target-enrollment-unavailable": "continuationSettings.forAutomaticSwitchingCompleteTheClaude",
  "target-cooldown": "continuationSettings.theTargetAccountIsInCooldown",
  "identity-not-enrolled": "continuationSettings.theClaudeAppAndUsageSign",
  "history-boundary": "continuationSettings.theseAccountsAreOutsideTheShared",
  "browser-sign-in": "continuationSettings.anAccountsUsageSignInIs",
  "guarded-native-policy-required": "continuationSettings.thisWatchNeedsANewConfirmation",
  "unfinished-attempt": "continuationSettings.anIncompleteHandoffIsOnRecord",
  "attempt-interrupted": "continuationSettings.theHandoffStoppedBeforeItFinished",
  "quota-episode-already-continued": "continuationSettings.relayAlreadyContinuedThisStoppedResponse",
  "new-turn-not-observed": "continuationSettings.relayCannotVerifyTheResponseAfter",
  "delivery-accepted": "continuationSettings.theClaudeAppAcceptedTheContinue",
  "delivery-unknown": "continuationSettings.relayCannotConfirmWhetherTheContinue",
  "delivery-ambiguous": "continuationSettings.relayCannotConfirmWhetherTheContinue",
  "reconciliation-required": "continuationSettings.checkTheIncompleteActionInThe",
  continued: "continuationSettings.relayVerifiedTheContinuationInThe",
  "new-turn-verified": "continuationSettings.aNewResponseStartedInThe",
  "durable-delivery-confirmed": "continuationSettings.relayVerifiedTheContinuationFromThe",
  "preview-only": "continuationSettings.thisPreviewDoesNotConnectTo",
};

const readinessExplanations: Record<ContinuationTargetReadinessReason, MessageId> = {
  "source-not-enrolled": "continuationSettings.theClaudeAppAndUsageSign2",
  "identity-not-enrolled": "continuationSettings.needsAClaudeAppSignIn",
  "duplicate-identity": "continuationSettings.sameAccountAsTheSourceCannot",
  "history-boundary": "continuationSettings.thisAccountIsOutsideTheShared",
  "quota-not-fresh": "continuationSettings.needsUsageDataFromTheLast",
  "five-hour-unavailable": "continuationSettings.no5HourLimitDataCannot",
  "quota-window-invalid": "continuationSettings.theLimitResetTimeIsOut",
  "target-quota-unavailable": "continuationSettings.n90OrMoreOfThe5",
  "target-cooldown": "continuationSettings.theAccountIsInCooldown",
};

const workExplanations: Record<string, MessageId> = {
  busyWorkers: "continuationSettings.anotherResponseOrOperationRunsRelay",
  subagents: "continuationSettings.aSubtaskStillRunsTheSwitch",
  pendingTasks: "continuationSettings.someTasksAreNotFinishedThe",
  waiting: "continuationSettings.aTaskWaitsForApprovalOr",
  queuedPrompts: "continuationSettings.someMessagesAreInTheQueue",
  scheduledWakeups: "continuationSettings.aContinuationIsScheduledTheSwitch",
  unknownWork: "continuationSettings.relayCannotVerifyTheStateOf",
};

function enrolled(account: Account) {
  return (
    !!account.desktop?.accountUuid &&
    !!account.desktop.orgId &&
    account.auth?.loggedIn === true &&
    account.auth.accountUuid?.toLowerCase() ===
      account.desktop.accountUuid.toLowerCase() &&
    account.auth.orgId?.toLowerCase() === account.desktop.orgId.toLowerCase()
  );
}

export function ContinuationSettings({
  accounts,
  active,
  value,
  busy,
  canArm = false,
  blockingReason,
  onRefresh,
  onArm,
  onDisable,
  t,
  usage,
  settings,
  now = Date.now(),
}: {
  accounts: Account[];
  active?: Account;
  value?: ContinuationSettingsView;
  busy: boolean;
  canArm?: boolean;
  blockingReason?: string;
  onRefresh: () => void;
  onArm: () => void;
  onDisable: () => void;
  t: T;
  usage?: Record<string, AccountUsage>;
  settings?: RelaySettings;
  now?: number;
}) {
  const fieldId = useId();
  const [consent, setConsent] = useState(false);
  const status = value?.status ?? "off";
  const watching =
    value?.enabled ?? ["armed", "waiting", "executing"].includes(status);
  const executing = status === "executing";
  const canEnable = canArm && value?.executable !== false;
  const source = accounts.find((a) => a.id === value?.sourceId) ?? active;
  const targets = accounts.filter(
    (a) =>
      a.id !== source?.id &&
      enrolled(a) &&
      !(
        a.desktop?.accountUuid.toLowerCase() ===
          source?.desktop?.accountUuid.toLowerCase() &&
        a.desktop?.orgId.toLowerCase() === source?.desktop?.orgId.toLowerCase()
      ),
  );
  const selectedTarget = accounts.find((a) => a.id === value?.targetId);
  const legacyWatch = watching && value?.targetSelection !== "automatic";
  const enrollmentKey = targets
    .map((a) => `${a.id}:${a.desktop?.accountUuid}:${a.desktop?.orgId}`)
    .sort()
    .join("|");
  const targetCount = watching
    ? (value?.allowedTargetCount ?? targets.length)
    : targets.length;
  const hasTarget = targetCount > 0;
  const readiness =
    usage && settings
      ? accounts
          .filter((account) => account.id !== source?.id)
          .map((account) => ({
            account,
            reason: continuationTargetReadinessReason(
              source,
              account,
              usage[account.id],
              settings,
              now,
            ),
          }))
      : undefined;
  const eligibleCount = readiness?.filter((item) => !item.reason).length ?? 0;
  const operationStatus = [
    "executing",
    "continued",
    "reconciliation-required",
  ].includes(status);
  const reason = operationStatus
    ? value?.reason
    : (blockingReason ?? value?.reason);
  const explanation = reason
    ? (explanations[reason] ??
      (reason.startsWith("not-quiescent:")
        ? workExplanations[reason.slice("not-quiescent:".length)]
        : undefined))
    : undefined;
  const statusLabels: Record<ContinuationSettingsView["status"], MessageId> = {
    off: "common.off",
    armed: "continuationSettings.active",
    waiting: "continuationSettings.onHold",
    executing: "continuationSettings.switchInProgress",
    continued: "continuationSettings.completed",
    blocked: "continuationSettings.checkRequired",
    "reconciliation-required": "continuationSettings.checkRequired",
  };

  useEffect(() => {
    setConsent(false);
  }, [
    active?.id,
    value?.sessionId,
    value?.permissionMode,
    status,
    enrollmentKey,
  ]);

  const statusDot =
    status === "armed" || status === "continued"
      ? "ok"
      : status === "off"
        ? "off"
        : status === "blocked" || status === "reconciliation-required"
          ? "crit"
          : "warn";
  const panel = "rounded-lg border border-border bg-muted/40 px-3 py-2.5";
  const caption = "block text-xs text-muted-foreground";

  return (
    <section aria-labelledby={`${fieldId}-title`} className="grid gap-3">
      <SectionHeading
        id={`${fieldId}-title`}
        icon={<ShieldCheck size={18} aria-hidden="true" />}
        title={t("continuationSettings.switchAndContinueWhenTheLimit")}
        description={t("continuationSettings.relayKeepsThePermissionModeOf")}
        aside={
          <Badge variant="outline">
            {executing ? (
              <LoaderCircle
                size={13}
                className="animate-spin"
                aria-hidden="true"
              />
            ) : status === "continued" ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <StatusDot tone={statusDot} />
            )}
            {t(statusLabels[status])}
          </Badge>
        }
      />

      <div className="grid items-stretch gap-2 @lg:grid-cols-[1fr_auto_1fr]">
        <div className={panel}>
          <span className={caption}>{t("continuationSettings.sourceAccount")}</span>
          <strong className="block text-sm font-semibold">
            {source?.name ?? t("continuationSettings.notVerifiedYet")}
          </strong>
          <small className={caption}>
            {source?.desktop?.email ? <Private>{source.desktop.email}</Private> : t("continuationSettings.claudeAppSignInRequired")}
          </small>
        </div>
        <ArrowRight
          size={18}
          aria-hidden="true"
          className="hidden self-center text-muted-foreground @lg:block"
        />
        <div className={panel}>
          <span className={caption}>
            {t("continuationSettings.accountSelection")}
          </span>
          <strong className="block text-sm font-semibold">
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.name
              : t("continuationSettings.automaticByRemainingCapacity")}
          </strong>
          <small className={caption}>
            {selectedTarget && (operationStatus || legacyWatch)
              ? selectedTarget.desktop?.email && <Private>{selectedTarget.desktop.email}</Private>
              : t("continuationSettings.connectedAccountsCheckedAtHandoff", { targetCount })}
          </small>
          {!hasTarget && (
            <small className={caption}>
              {t("continuationSettings.completeAnotherAccountSClaudeApp")}
            </small>
          )}
        </div>
      </div>

      {!watching && !operationStatus && readiness && (
        <div className={panel}>
          <strong className="text-sm font-semibold">
            {t("continuationSettings.enoughLimitVerifiedOnAccounts", { eligibleCount })}
          </strong>
          <Note>
            {t("continuationSettings.thisIsOnlyTheCurrentLimit")}
          </Note>
          <ul
            className="mt-2 grid gap-1"
            aria-label={t("continuationSettings.accountReadiness")}
          >
            {readiness.map(({ account, reason }) => (
              <li
                key={account.id}
                className="flex items-baseline justify-between gap-3 text-sm"
              >
                <strong className="font-medium">{account.name}</strong>
                <span className="text-right text-muted-foreground">
                  {reason
                    ? t(readinessExplanations[reason])
                    : usage?.[account.id]?.sevenDay
                      ? t("continuationSettings.n5HourAndWeeklyLimitsAre")
                      : t("continuationSettings.n5HourLimitIsAvailableNo")}
                </span>
              </li>
            ))}
          </ul>
          {settings?.usageRefreshMinutes !== 5 && (
            <Note className="mt-2">
              {t("continuationSettings.automaticSwitchingNeedsUsageDataFrom")}
            </Note>
          )}
        </div>
      )}

      <div className="grid gap-2 @lg:grid-cols-2">
        <div className={panel}>
          <span className={caption}>{t("continuationSettings.conversation")}</span>
          <strong className="block break-all text-sm font-semibold">
            {value?.projectKey ??
              t("continuationSettings.openCodeConversationInTheClaude")}
          </strong>
          {value?.sessionId && (
            <code
              className="block break-all text-xs text-muted-foreground"
              title={value.sessionId}
            >
              {value.sessionId}
            </code>
          )}
        </div>
        <div className={panel}>
          <span className={caption}>
            {t("continuationSettings.permissionModeToKeep")}
          </span>
          <strong className="block text-sm font-semibold">
            {value?.permissionMode ??
              t("continuationSettings.notCheckedYet")}
          </strong>
        </div>
      </div>

      <div className={`${panel} text-sm`} role="status" aria-live="polite">
        <p>
          {value?.executable === false && (!reason || reason === "disabled")
            ? t("continuationSettings.safeSwitchAndMessageChecksAre")
            : explanation
              ? t(explanation)
              : executing
                ? t("continuationSettings.relayVerifiesTheAccountTheConversation")
                : status === "blocked" || status === "reconciliation-required"
                  ? t("continuationSettings.relayCannotVerifyThatContinuationIs")
                  : value?.executable === false
                    ? t("continuationSettings.safeSwitchAndMessageChecksAre")
                    : !canEnable
                      ? t("continuationSettings.relayMustFirstVerifyTheOpen")
                      : t("continuationSettings.turnOnWatchingForThisConversation")}
        </p>
      </div>

      {!watching && (
        <div className="flex items-start gap-3">
          <Switch
            id={`${fieldId}-consent`}
            size="sm"
            className="mt-0.5"
            checked={consent}
            disabled={busy || !canEnable || !hasTarget}
            onCheckedChange={setConsent}
          />
          <label htmlFor={`${fieldId}-consent`} className="text-sm">
            {t("continuationSettings.whenTheLimitIsReachedAnd")}
          </label>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {watching ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy || executing}
            onClick={onDisable}
          >
            <Pause size={15} aria-hidden="true" />
            {t("continuationSettings.turnOffWatching")}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy || !canEnable || !hasTarget || !consent}
            onClick={() => {
              if (canEnable && hasTarget && consent) onArm();
            }}
          >
            <Play size={15} aria-hidden="true" />
            {t("continuationSettings.watchThisConversation")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy || executing}
          onClick={onRefresh}
        >
          <RefreshIcon className="size-4" />
          {t("continuationSettings.checkAgain")}
        </Button>
      </div>
      {legacyWatch && (
        <Note>
          {t("continuationSettings.thisWatchIsFromAnEarlier")}
        </Note>
      )}
      <Note>
        {t("continuationSettings.runsOnceForThisConversationWhile")}
      </Note>
    </section>
  );
}
