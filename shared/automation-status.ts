import type {
  Account,
  AccountUsage,
  AutoSwitchReason,
  AutoSwitchState,
  DesktopState,
  FleetContinuationState,
  RelaySettings,
  Snapshot,
} from "./types";
import { automationMode, type AutomationMode } from "./automation-mode";
import type { Locale } from "./i18n/locales";
import { tFor, type MessageId, type Params, type T } from "./i18n/translate";
import { formatUsed } from "./percent";
import { withDative } from "./tr-dative";
import { maxUsedPercent, sourceExhausted } from "./usage";

export type AutomationTone = "off" | "ok" | "waiting" | "attention";

/**
 * Whether `platform` (diagnostics' platform; "preview" is the browser preview) can run `mode`.
 * Preparing on quit needs no UI automation, so Linux has it; continuing at quota types into
 * Claude through macOS's Accessibility.
 */
export function automationModeSupported(
  mode: AutomationMode,
  platform: string | undefined,
): boolean {
  if (mode === "off") return true;
  if (platform === "darwin" || platform === "preview") return true;
  return mode === "after-exit" && platform === "linux";
}

export interface AutomationStatus {
  mode: AutomationMode;
  tone: AutomationTone;
  /** One sentence: what Relay does, why it waits, what to do. */
  text: string;
  /**
   * The "<account> %n kullanıldı · " that `text` starts with (empty without a reading).
   * It changes with every usage reading, so the UI keeps it out of live
   * announcements.
   */
  prefix: string;
  /** Account id offered as "Şimdi <hesap>’e geç". */
  switchTo?: string;
  /** Show in the page-top banner. */
  banner: boolean;
}

export interface AutomationStatusInput {
  settings: RelaySettings;
  fleet?: FleetContinuationState;
  autoSwitch?: AutoSwitchState;
  /** The legacy single-conversation watch. */
  continuation?: Pick<
    NonNullable<Snapshot["continuation"]>,
    "enabled" | "status"
  >;
  accounts: Account[];
  usage: Record<string, AccountUsage>;
  desktop?: DesktopState;
  now: number;
  /** Diagnostics' platform: a saved mode it cannot run reads as unavailable. Unset, not checked. */
  platform?: string;
}

/** A sentence with its tone; its `{placeholders}` are filled when it is shown. */
interface Row {
  tone: AutomationTone;
  banner: boolean;
  message: MessageId;
}
const waiting = (message: MessageId): Row => ({ tone: "waiting", banner: false, message });
const ok = (message: MessageId, banner = false): Row => ({
  tone: "ok",
  banner,
  message,
});
const attention = (message: MessageId, banner = true): Row => ({
  tone: "attention",
  banner,
  message,
});

/** Prepare on quit. `{tgt}` is the target account. */
const AFTER_EXIT: Record<AutoSwitchReason, Row> = {
  disabled: waiting("automationStatus.checkInProgress"),
  "desktop-busy": waiting("automationStatus.relayIsBusyWithAnother"),
  "separate-window": waiting("automationStatus.aSeparateClaudeWindowIs"),
  "desktop-sign-in": waiting("automationStatus.anAccountSClaudeApp"),
  "browser-sign-in": waiting("automationStatus.anAccountSUsageSignIn"),
  "usage-not-fresh": waiting("automationStatus.noCurrentUsageDataYet"),
  "exit-settling": waiting("automationStatus.theClaudeAppQuitRelay"),
  "quota-exhausted": waiting("automationStatus.relayPreparesTgt"),
  "claude-running": { ...waiting("automationStatus.theClaudeAppIsOpen"), banner: true },
  "quota-available": ok("automationStatus.whenTheLimitIsReached"),
  "already-switched": ok("automationStatus.alreadySwitchedForThisLimit"),
  prepared: ok("automationStatus.tgtIsReadyOpenThe", true),
  "unsupported-platform": attention("automationStatus.automaticSwitchingWorksOnlyOn"),
  "desktop-unavailable": attention("automationStatus.theClaudeAppWasNot"),
  // Desktop recovery has its own banner.
  "desktop-recovery": attention("automationStatus.aClaudeAppActionIs", false),
  "continuation-active": attention("automationStatus.theSwitchAndContinueWhen"),
  "unknown-active": attention("automationStatus.theAccountOpenInThe"),
  "not-selected": attention("automationStatus.thisAccountIsNotIn"),
  "source-not-ready": attention("automationStatus.theOpenAccountSClaude"),
  "no-ready-target": attention("automationStatus.theLimitIsReachedAnd"),
  "retry-backoff": attention("automationStatus.theSwitchFailedRelayTries"),
  "switch-failed": attention("automationStatus.theSwitchDidNotFinish"),
  "ledger-unavailable": attention("automationStatus.relayPreparedTheAccountBut"),
};
/** `prepared` when the prefix already names the target. */
const PREPARED_HERE = ok("automationStatus.readyOpenTheClaudeApp", true);

/**
 * Continue at quota, by exact reason. `{n}` is the stopped conversations,
 * `{tgt}` the target (`{tgtDative}` in Turkish), `{uncertain}` the unconfirmed ones.
 */
const FLEET: Record<string, Row> = {
  "source-quota-unconfirmed": waiting("automationStatus.nConversationsStoppedAtThe"),
  checking: waiting("automationStatus.checkInProgress"),
  "desktop-busy": waiting("automationStatus.relayIsBusyWithAnother"),
  "separate-window": waiting("automationStatus.aSeparateClaudeWindowIs"),
  "context-changed": waiting("automationStatus.theStateChangedRelayChecks"),
  "delivery-uncertain": attention("automationStatus.relayCannotConfirmThatThe"),
  "no-target": attention("automationStatus.nConversationsStoppedAndNo"),
  "desktop-unavailable": attention("automationStatus.theClaudeAppWasNot"),
  "source-not-enrolled": attention("automationStatus.theAccountOpenInThe"),
  "accessibility-permission-required": attention("automationStatus.giveRelayMacosAccessibilityPermission"),
  "switch-interrupted": attention("automationStatus.aSwitchIsIncompleteRestore"),
  "account-changed": attention("automationStatus.theOpenAccountChangedAfter"),
  "target-missing": attention("automationStatus.theTargetAccountIsMissing"),
};

/** Reasons where Relay holds a stop it could switch for, if the user asks. */
const holdsSwitch = (reason: string) =>
  reason === "background-work" ||
  reason.startsWith("not-quiescent:") ||
  reason === "quiescence-unverified" ||
  reason === "awaiting-quota-stop";

/** A ready reading that shows a limit reached, however long ago it was taken. */
function readsFull(u: AccountUsage | undefined) {
  return (
    u?.status === "ready" &&
    !u.stale &&
    ((u.fiveHour?.usedPercent ?? 0) >= 100 ||
      (u.sevenDay?.usedPercent ?? 0) >= 100 ||
      u.otherLimitReached === true)
  );
}


/** What automatic switching is doing, in one sentence, from one snapshot, in `language`. */
export function automationStatus(
  input: AutomationStatusInput,
  language: Locale,
): AutomationStatus {
  const {
    settings,
    fleet,
    autoSwitch,
    continuation,
    accounts,
    usage,
    desktop,
  } = input;
  const t = tFor(language);
  const mode = automationMode(settings, fleet);
  const active = accounts.find((a) => a.id === desktop?.activeProfileId);
  const name = (id?: string) => accounts.find((a) => a.id === id)?.name ?? "—";
  const used = active ? maxUsedPercent(usage[active.id]) : undefined;
  const prefix =
    active && typeof used === "number"
      ? `${active.name} ${formatUsed(used, language)} · `
      : "";
  const show = (
    row: Row,
    params: Params = {},
    switchTo?: string,
    suffix?: MessageId,
  ): AutomationStatus => ({
    mode,
    tone: row.tone,
    text: `${prefix}${t(row.message, params)}${suffix ? ` ${t(suffix)}` : ""}`,
    prefix,
    ...(switchTo ? { switchTo } : {}),
    banner: row.banner || !!switchTo,
  });

  if (continuation?.status === "reconciliation-required")
    return show(attention("automationStatus.aConversationHandoffIsIncomplete"));
  if (mode === "off")
    return show(
      // An interrupted watch was handled above; an armed one still runs.
      continuation?.enabled
        ? attention("automationStatus.offButTheSwitchAnd")
        : { tone: "off", banner: false, message: "automationStatus.offWhenTheLimitIs" },
    );
  // A choice saved where it cannot run, as a store brought from a Mac: said, never shown as watching.
  if (input.platform !== undefined && !automationModeSupported(mode, input.platform))
    return show(
      mode === "quota"
        ? attention("automationStatus.continuingAtTheLimitWorks")
        : AFTER_EXIT["unsupported-platform"],
    );

  if (mode === "after-exit") {
    const row =
      autoSwitch?.reason === "prepared" &&
      prefix !== "" &&
      active?.id === autoSwitch.targetId
        ? PREPARED_HERE
        : (AFTER_EXIT[autoSwitch?.reason ?? "disabled"] ?? AFTER_EXIT.disabled);
    return show(
      row,
      { tgt: name(autoSwitch?.targetId) },
      autoSwitch?.reason === "claude-running" ? autoSwitch.targetId : undefined,
    );
  }

  if (!fleet || fleet.status === "off") return show(waiting("automationStatus.checkInProgress"));
  const n = fleet.stopped ?? 0;
  const src = name(fleet.sourceId);
  const tgt = name(fleet.targetId);
  const vars = { n, src, tgt, tgtDative: withDative(tgt) };
  if (fleet.status === "switching") return show(waiting("automationStatus.switchInProgress"), vars);
  if (fleet.status === "continuing") return show(waiting("automationStatus.relayContinuesOnTgt"), vars);

  // A saved-enabled fleet is published without a reason before its first check.
  const reason = fleet.reason ?? "";
  if (!reason) return show(waiting("automationStatus.checkInProgress"));
  const last = fleet.last;
  const activeUsage = active && usage[active.id];
  // The fleet's own rule: only a reading under 15 minutes old confirms a full
  // account. An older one that reads full waits for a fresh reading.
  const full = sourceExhausted(activeUsage, input.now);
  // Switching now is offered only for the account the fleet is watching, and
  // only once fresh usage says it is full.
  const offer =
    holdsSwitch(reason) &&
    !!fleet.targetId &&
    fleet.sourceId === active?.id &&
    full;
  const switchTo = offer ? fleet.targetId : undefined;

  if (reason === "continued" && last)
    return show(ok("automationStatus.lastHandoff"), {
      src: name(last.sourceId),
      tgt: name(last.targetId),
      started: last.started,
      conversations: last.conversations,
    });
  if (reason === "continued") return show(ok("automationStatus.whenTheLimitIsReachedRelay"));
  if (reason === "awaiting-quota-stop") {
    if (offer) return show(waiting("automationStatus.theLimitIsReachedButNo"), vars, switchTo);
    if (!fleet.targetId && full) return show(waiting("automationStatus.theLimitIsReachedNoConversation"));
    if (!full && readsFull(activeUsage)) return show(waiting("automationStatus.noCurrentUsageDataYet"));
    return show(ok("automationStatus.whenTheLimitIsReachedRelay"));
  }
  if (reason === "background-work")
    return show(
      waiting("automationStatus.nConversationsStoppedBackgroundCommand"),
      vars,
      switchTo,
      switchTo ? "automationStatus.ifYouSwitchNowYou" : undefined,
    );
  if (reason.startsWith("not-quiescent:") || reason === "quiescence-unverified")
    return show(
      waiting("automationStatus.nConversationsStoppedOtherWork"),
      vars,
      switchTo,
      switchTo ? "automationStatus.ifYouSwitchNowYou" : undefined,
    );
  if (reason.startsWith("switch-failed:"))
    return show(attention("automationStatus.theSwitchFailedX"), { x: reason.slice("switch-failed:".length) });
  if (Object.hasOwn(FLEET, reason))
    return show(FLEET[reason], { ...vars, uncertain: last?.uncertain ?? 0 });
  const unreadable: MessageId = "automationStatus.relayCannotReadTheClaude";
  return show(fleet.status === "attention" ? attention(unreadable) : waiting(unreadable), { reason });
}

/** The switch-now button: "Şimdi Kişisel’e geç" / "Switch to Kişisel now". */
export const switchNowLabel = (name: string, t: T) =>
  t("automationStatus.switchToNameNow", { name, nameDative: withDative(name) });

/** Why a confirmed manual switch is no longer wanted, read from fresh state. */
export function staleManualSwitch(
  targetId: string,
  desktop: DesktopState | undefined,
  fleet: FleetContinuationState | undefined,
): "already-active" | "automation-running" | undefined {
  if (desktop?.activeProfileId === targetId) return "already-active";
  if (fleet?.status === "switching" || fleet?.status === "continuing")
    return "automation-running";
}
