import type { TerminalMode, TerminalOutcome, TerminalStatus } from "./terminal-identity";
import type { UsageStatisticsView } from "./usage-statistics-view";
export type { UsageStatisticsView } from "./usage-statistics-view";
import type { TokenUsageView } from "./token-usage-view";
export type { TokenUsageView } from "./token-usage-view";
import type { LostFoundCollection } from "./lost-found";
export type { LostFoundCollection, LostFoundWeek, LostItem } from "./lost-found";
import type { Tempo } from "./tempo";
import type {
  ExtensionOffer,
  ExtensionOutcome,
  ExtensionSetting,
  ExtensionStatus,
} from "./browser-extension";
export type {
  ExtensionCurrent,
  ExtensionInstance,
  ExtensionMode,
  ExtensionOffer,
  ExtensionOutcome,
  ExtensionSetting,
  ExtensionStatus,
  ExtensionTarget,
} from "./browser-extension";
import type { DesktopContinuationSnapshot } from "../electron/core/desktop-continuation";
import type { DraftSummary } from "../electron/core/draft-vault";
export type { DraftSummary } from "../electron/core/draft-vault";
import type { PageId, PageIntent } from "../src/app/routes";
export type AccountKind = "personal" | "work";
export type AccountPlan = "unknown" | "pro" | "max5" | "max20" | "team";
export interface AccountPlanning {
  plan: AccountPlan;
  capacityWeight: number;
}
export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  group: string;
  color: string;
  createdAt: string;
  cooldownUntil?: string;
  planning?: AccountPlanning;
  desktop?: {
    accountUuid: string;
    orgId: string;
    savedAt: string;
    email?: string;
  };
  auth?: {
    loggedIn: boolean;
    email?: string;
    accountUuid?: string;
    orgId?: string;
    orgName?: string;
    subscription?: string;
    checkedAt: string;
    error?: string;
  };
}
export interface Session {
  key: string;
  id: string;
  accountId: string;
  projectDir: string;
  projectName: string;
  title: string;
  updatedAt: string;
  messages: number;
  bytes: number;
  pinned: boolean;
  forkedFrom?: string;
}
export interface Run {
  id: string;
  accountId: string;
  title: string;
  cwd: string;
  kind: "session" | "desktop";
  sessionKey?: string;
  status: "running" | "exited";
  exitCode?: number;
}
export interface Diagnostics {
  executable?: string;
  /** Chosen in Settings, found in the usual places, or the one the Claude app downloaded for Code. */
  source?: "chosen" | "path" | "claude-app";
  version?: string;
  desktopSupported: boolean;
  platform: string;
  dataDir: string;
  error?: string;
}
export interface AuthFlow {
  id: string;
  accountId: string;
  status:
    "starting" | "waiting" | "verifying" | "connected" | "failed" | "cancelled";
  browserReady: boolean;
  codeRequested: boolean;
  /** The sign-in page is open in Relay's own window for the account, not the system browser. */
  inWindow?: boolean;
  startedAt: string;
  error?: string;
}
/**
 * The Code sidebar sections the account switched to lacks, as counts and account names: the
 * sessions and the recipe stay in main.
 */
export interface SidebarGapSummary {
  id: string;
  /** The account switched to, by name. */
  to: string;
  /** The accounts the sections come from, by name. */
  from: string[];
  /** Sections the account has none of that name for. */
  missingSections: number;
  /** Sessions to file in the sections. */
  sessions: number;
}
export interface Snapshot {
  settings: RelaySettings;
  autoSwitch?: AutoSwitchState;
  continuation?: DesktopContinuationSnapshot;
  fleet?: FleetContinuationState;
  planning?: KeeperSnapshot;
  /** The drafts rescued at switches: summaries only, never their text. */
  drafts?: DraftSummary[];
  /** What Desktop's current account lacks of the sidebar organization of the accounts it came from. */
  sidebar?: SidebarGapSummary;
  /** The Claude extension is left on another account than Desktop's, and can be brought along. */
  extension?: ExtensionOffer;
  usage: Record<string, AccountUsage>;
  authFlows: AuthFlow[];
  accounts: Account[];
  sessions: Session[];
  runs: Run[];
  diagnostics: Diagnostics;
  importEnabled: boolean;
  warnings: string[];
}
export interface CreateAccount {
  name: string;
  kind: AccountKind;
  group?: string;
}
/** What removing an account did. */
export interface AccountRemoved {
  /** Whether its usage sign-in was signed out; undefined when it had none. */
  signedOut?: boolean;
}
export interface LaunchRequest {
  accountId: string;
  cwd?: string;
  sessionKey?: string;
  importConsent?: boolean;
  desktop?: boolean;
  desktopConsent?: boolean;
}
export interface TerminalEvent {
  runId: string;
  data?: string;
  exitCode?: number;
}
export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}
/** "Switch and continue" for every local Code conversation, kept on until turned off. */
export interface FleetContinuationState {
  enabled: boolean;
  status:
    "off" | "watching" | "waiting" | "switching" | "continuing" | "attention";
  /** Machine-readable reason, localized by the UI. */
  reason?: string;
  sourceId?: string;
  targetId?: string;
  /** Quota-stopped conversations found in the active account. */
  stopped?: number;
  checkedAt?: string;
  last?: {
    at: string;
    sourceId: string;
    targetId: string;
    conversations: number;
    started: number;
    uncertain: number;
    skipped: number;
  };
}
export interface DesktopState {
  available: boolean;
  running: boolean;
  currentAccountUuid?: string;
  organizations: string[];
  activeProfileId?: string;
  pendingProfileId?: string;
  busy: boolean;
  error?: string;
  recoveryRequired: boolean;
  errorRevision: number;
  lastBackup?: string;
  /** Relay saves the Claude app sign-in for this profile by itself once it is complete. */
  autoCapture?: AutoCaptureState;
}
/**
 * The automatic save of a Claude app sign-in: waiting for the sign-in and Code, waiting for the
 * user to pick one of several workspaces, saving (Claude restarts), saved, or failed. `alreadySaved`
 * names a saved account that is signed in instead of a new one.
 */
export interface AutoCaptureState {
  accountId: string;
  status: "waiting" | "choose-org" | "saving" | "saved" | "failed";
  orgs?: string[];
  alreadySaved?: string;
  /** "timeout", "other-pending", or the save's own error. */
  error?: string;
}
/** A DesktopManager operation; each may restart Claude. */
export type DesktopOperationKind = "switch" | "save" | "link" | "cancel-link" | "merge" | "restore";
/**
 * An operation about to quit Claude (`start`, once), then its end (`end`).
 * Operations that never quit Claude report nothing.
 */
export type DesktopRestartEvent =
  | { phase: "start"; kind: DesktopOperationKind; profileId?: string }
  | { phase: "end"; kind: DesktopOperationKind; profileId?: string; ok: boolean };
/** How Relay starts Claude; kept in its own file beside the registry, not in it. */
export interface ClaudeLaunchChoice {
  /** Claude starts without HTTP/3, so its requests go over HTTP/2. */
  quicOff: boolean;
}
/**
 * One thing the macOS menu bar title can show: the percent used of the Claude-open account's
 * five-hour or weekly window, the time left in its five-hour window, today's tokens or their API
 * value across all accounts, or that account's name.
 */
export type MenuBarItem = "five-hour" | "week" | "reset" | "tokens" | "cost" | "account";
/** What the menu bar title shows, in order; kept in its own file beside the registry, not in it. */
export interface MenuBarTitleChoice {
  items: MenuBarItem[];
}
/**
 * The menu bar as it is now: its title, and each item's value on its own for the account open in
 * the Claude app ("" when it has none now, such as a week a Team seat does not report).
 */
export interface MenuBarNow {
  title: string;
  values: Record<MenuBarItem, string>;
}
export interface RelayAPI {
  inspectContinuation(): Promise<DesktopContinuationSnapshot>;
  /** "automatic" selects from identities enrolled when watching starts; UUIDs support existing watches. */
  armContinuation(
    targetAccountId: string,
    executionPolicy: "guarded-native-at-most-once",
  ): Promise<DesktopContinuationSnapshot>;
  disarmContinuation(): Promise<DesktopContinuationSnapshot>;
  setFleetContinuation(enabled: boolean): Promise<FleetContinuationState>;
  reconcileContinuation(): Promise<DesktopContinuationSnapshot>;
  abandonContinuation(): Promise<DesktopContinuationSnapshot>;
  requestDesktopAccessibility(): Promise<boolean>;
  /** Copies a rescued draft to the clipboard in main and removes it; its text never reaches a renderer. */
  copyDraft(id: string): Promise<void>;
  /** Removes a rescued draft. */
  dismissDraft(id: string): Promise<void>;
  /** Copies the sidebar recipe of gap `id` to the clipboard in main. */
  copySidebarRecipe(id: string): Promise<void>;
  /** Stops offering the sidebar gap `id`. */
  dismissSidebarGap(id: string): Promise<void>;
  updateAccountPlanning(
    accountId: string,
    input: AccountPlanning,
  ): Promise<Account>;
  /** The Claude browser extension's setting, what Relay found and saved, and the last result; undefined outside macOS. */
  extensionStatus(): Promise<ExtensionStatus | undefined>;
  /** Runs the extension step for the account Desktop is on, without changing Claude. */
  syncExtension(): Promise<ExtensionOutcome>;
  /**
   * Reads who the extension is signed in to from a copy of its storage (a running browser is
   * left alone) and saves that sign-in when the account is one of Relay's: how an account is
   * linked. Returns the status with `current` filled in; undefined outside macOS.
   */
  checkExtension(): Promise<ExtensionStatus | undefined>;
  /**
   * Like `checkExtension`, for an extension whose data names no account: the user says it is
   * signed in to this account, and its sign-in is saved as this account's.
   */
  linkExtension(accountId: string): Promise<ExtensionStatus | undefined>;
  /** The terminal's Claude Code: the setting, who it is on, what is saved, the last result; undefined outside macOS. */
  terminalStatus(): Promise<TerminalStatus | undefined>;
  /** Reads who the terminal's Claude Code is signed in to and saves that sign-in when it is one of Relay's accounts. */
  checkTerminal(): Promise<TerminalStatus | undefined>;
  /** Puts the saved terminal sign-in of the account Desktop is on in place. */
  syncTerminal(): Promise<TerminalOutcome>;
  setTrayLanguage(language: "tr" | "en"): Promise<void>;
  /** Shows draft-events.json, else usage-issues.json, in Finder; else opens the user data folder. Takes no path. */
  showDiagnostics(): Promise<void>;
  /**
   * How Relay starts Claude: `quicOff`, without HTTP/3, which Relay also turns on itself after a
   * stuck start.
   */
  claudeLaunch(): Promise<ClaudeLaunchChoice>;
  /** Changes what the patch names; resolves with the whole choice. */
  setClaudeLaunch(patch: Partial<ClaudeLaunchChoice>): Promise<ClaudeLaunchChoice>;
  /** What the menu bar title shows (macOS); the five-hour percent alone until changed. */
  menuBarTitle(): Promise<MenuBarTitleChoice>;
  /** Replaces the menu bar title's items and redraws it; resolves with the choice as kept. */
  setMenuBarTitle(choice: MenuBarTitleChoice): Promise<MenuBarTitleChoice>;
  /** What the menu bar shows now, and what each item would show; undefined before the first look. */
  menuBarNow(): Promise<MenuBarNow | undefined>;
  /** Main broadcast `relay:changed`: Relay state changed in another window or the tray. */
  onChanged(callback: () => void): () => void;
  /** Shows the main window on a page, with the intent its page acts on (and hides the menu bar panel). */
  openPage(page: PageId, intent?: PageIntent): Promise<void>;
  /** Main window: a page (and intent) requested from the menu bar panel. */
  onNavigate(callback: (page: PageId, intent?: PageIntent) => void): () => void;
  /**
   * Main window: the account a widget's Geç link asked to switch to, taken once (undefined
   * without one, or once it is two minutes old). The window opens its switch review for it.
   */
  takeSwitchRequest(): Promise<string | undefined>;
  /** Main window: a widget's switch request is waiting to be taken. */
  onSwitchRequest(callback: () => void): () => void;
  /** Menu bar panel only: reports its content height. */
  setPanelHeight(height: number): void;
  /** Menu bar panel only: hides it. */
  closePanel(): void;
  /** Menu bar panel only: main reports each time the panel is shown or hidden. */
  onPanelVisibility(callback: (shown: boolean) => void): () => void;
  quit(): Promise<void>;
  updateSettings(input: Partial<RelaySettings>): Promise<RelaySettings>;
  updatePlanning(patch: Partial<PlanningSettings>): Promise<PlanningSettings>;
  refreshUsage(
    accountId: string,
    allowKeychainPrompt?: boolean,
  ): Promise<AccountUsage>;
  desktopSnapshot(): Promise<DesktopState>;
  dismissDesktopError(revision: number): Promise<void>;
  captureDesktop(profileId: string, orgId: string): Promise<void>;
  beginDesktopLogin(profileId: string): Promise<void>;
  cancelDesktopLogin(): Promise<void>;
  switchDesktop(profileId: string): Promise<void>;
  syncDesktopHistory(profileId: string): Promise<void>;
  desktopHistorySummary(profileId: string): Promise<DesktopHistorySummary>;
  openDesktop(): Promise<void>;
  /** Opens Claude on Code's new-session screen, which creates the account's Code workspace. */
  openCodeTab(): Promise<void>;
  /** Saves this profile's Claude app sign-in by itself once it is complete (see AutoCaptureState). */
  armAutoCapture(profileId: string): Promise<void>;
  disarmAutoCapture(profileId?: string): Promise<void>;
  chooseAutoCaptureOrg(profileId: string, orgId: string): Promise<void>;
  recoverDesktop(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  panelSnapshot(): Promise<Snapshot>;
  usageStatistics(input: {
    range: 7 | 30 | 90;
    accountId?: string;
  }): Promise<UsageStatisticsView>;
  tokenUsage(input: {
    range: 7 | 30 | 90;
    accountId?: string;
  }): Promise<TokenUsageView>;
  /** Each kind's finds over every week within reach, for the collection. */
  lostFoundCollection(): Promise<LostFoundCollection>;
  createAccount(input: CreateAccount): Promise<Account>;
  /** Forgets an account: its profile, its saved sign-ins and its place in the lists. */
  removeAccount(accountId: string): Promise<AccountRemoved>;
  checkAuth(accountId: string): Promise<Account>;
  login(accountId: string): Promise<AuthFlow>;
  /** Opens the sign-in page again: Relay's window for the account, or the system browser. */
  reopenLogin(accountId: string, attemptId: string, where?: "window" | "browser"): Promise<void>;
  cancelLogin(accountId: string, attemptId: string): Promise<void>;
  submitLoginCode(
    accountId: string,
    attemptId: string,
    code: string,
  ): Promise<void>;
  onAuth(callback: (flow: AuthFlow) => void): () => void;
  closeRun(runId: string): Promise<void>;
  launch(input: LaunchRequest): Promise<Run>;
  switchAccount(runId: string, accountId: string): Promise<Run>;
  pickFolder(): Promise<string | null>;
  pickExecutable(): Promise<void>;
  /** Asks where Claude Desktop is installed and keeps the choice. */
  pickClaudeApp(): Promise<void>;
  importHistory(): Promise<void>;
  setPinned(key: string, pinned: boolean): Promise<void>;
  setCooldown(accountId: string, hours: number): Promise<void>;
  transcript(key: string): Promise<TranscriptMessage[]>;
  terminalBuffer(
    runId: string,
  ): Promise<{ data: string; sequence: number; status: Run["status"] }>;
  terminalWrite(runId: string, data: string): void;
  terminalResize(runId: string, cols: number, rows: number): void;
  stop(runId: string): Promise<void>;
  onTerminal(
    callback: (event: TerminalEvent & { sequence?: number }) => void,
  ): () => void;
}
declare global {
  interface Window {
    relay?: RelayAPI;
  }
}

export interface RelaySettings {
  /** Window theme; "system" follows macOS. */
  appearance: "system" | "light" | "dark";
  planning: PlanningSettings;
  usageRefreshMinutes: 0 | 5 | 15 | 30;
  usageWarningPercent: 80 | 90 | 95;
  usageWarnings: boolean;
  suggestAccounts: boolean;
  /**
   * Who shares local Code history. A new install starts with "same-group": personal accounts
   * share with each other, a work account only inside its own group. "all" shares between every
   * Desktop-connected account; a registry saved without this field keeps "all".
   */
  desktopHistoryTransfer: "all" | "same-group" | "selected" | "off";
  desktopHistoryAccounts: string[];
  autoSwitchMode: "off" | "after-exit";
  autoSwitchAccounts: string[];
  /** 2: registries from before "all" existed had "same-group" moved to "all" once. */
  historyPolicyVersion?: 2;
  /** Animate the menu bar panda; missing means on. */
  menuBarAnimation?: boolean;
  /** Show the switch window under the menu bar while Claude restarts; missing means on. */
  switchWindow?: boolean;
  /** How often the panda pranks; missing means "sometimes". */
  pranks?: PrankLevel;
  /**
   * Experimental: re-type the drafts rescued at a switch into Claude. Missing means off: the
   * drafts are offered in the panel for Copy, and nothing asks for Accessibility for them.
   */
  draftRetype?: boolean;
  /** What Relay does with the Claude browser extension's sign-in at a switch; missing means "restart". */
  claudeExtension?: ExtensionSetting;
  /** What Relay does with the terminal's Claude Code sign-in at a switch; missing means "follow". */
  terminalCli?: TerminalMode;
}
export type PrankLevel = "sometimes" | "rarely" | "off";
export interface PlanningHours {
  enabled: boolean;
  start: string;
  end: string;
}
export interface PlanningAccount {
  id: string;
  /** Manual first warm-up clock (HH:mm), applied on every planned day. */
  firstStart?: string;
}
/** How fast the plan expects usage to be consumed; "auto" learns it. */
export type TempoChoice = "auto" | "light" | "medium" | "heavy";
export interface PlanningSettings {
  /** Start and keep usage windows running automatically. */
  autoStart: boolean;
  timeZone: string;
  /** Monday–Friday, by the interval's start date. */
  weekday: PlanningHours;
  /** Saturday and Sunday, by the interval's start date. */
  weekend: PlanningHours;
  /** Planned accounts in priority order. */
  accounts: PlanningAccount[];
  /** Missing means "auto". */
  tempo?: TempoChoice;
  /** Re-plan the rest of the day at today's pace; missing means on. */
  adaptive?: boolean;
}
export const DEFAULT_PLANNING: PlanningSettings = {
  autoStart: false,
  timeZone: "Europe/Istanbul",
  weekday: { enabled: true, start: "09:00", end: "18:00" },
  weekend: { enabled: false, start: "11:00", end: "17:00" },
  accounts: [],
  tempo: "auto",
};
export type WindowAttemptStatus =
  "started" | "verified" | "sent-unverified" | "failed";
export interface WindowAttempt {
  id: string;
  accountId: string;
  identityKey: string;
  at: string;
  status: WindowAttemptStatus;
  reason?: string;
  resetAt?: string;
}
export type KeeperAccountState =
  "off" | "outside" | "active" | "due" | "waiting" | "blocked";
export interface KeeperAccountStatus {
  accountId: string;
  state: KeeperAccountState;
  reason?: string;
  resetsAt?: string;
  nextStartAt?: string;
}
/** Today's re-plan at today's pace. */
export interface KeeperAdaptation {
  /** Today's pace multiplier for the tempo (1–3). */
  factor: number;
  /** Pro units an hour over the last hour, when observed long enough. */
  observedRate?: number;
  /** Next window starts that differ from the plan, earliest first. */
  schedule: { accountId: string; startAt: string }[];
  /** When the schedule was adopted. */
  since?: string;
}
export interface KeeperSnapshot {
  enabled: boolean;
  running: boolean;
  accounts: KeeperAccountStatus[];
  /** Most recent first, at most 20. */
  attempts: WindowAttempt[];
  /** Planned window starts on today's plan. */
  plannedToday: number;
  next?: { accountId: string; at: string };
  /** The tempo the keeper plans with. */
  tempo?: Tempo;
  /** Present while today's pace is above the plan or a start is moved. */
  adaptation?: KeeperAdaptation;
}
export interface DesktopHistorySummary {
  profileId: string;
  indexed: number;
  archived: number;
  projects: number;
  transcriptsFound: number;
  missingTranscripts: number;
  unknownTranscripts: number;
  /** Extra cards of conversations that appear more than once; removed on the next switch or merge. */
  duplicates: number;
  sourceProfiles: number;
  checkedAt: string;
}
export const DEFAULT_SETTINGS: RelaySettings = {
  appearance: "system",
  planning: DEFAULT_PLANNING,
  usageRefreshMinutes: 5,
  usageWarningPercent: 90,
  usageWarnings: true,
  suggestAccounts: true,
  desktopHistoryTransfer: "same-group",
  desktopHistoryAccounts: [],
  autoSwitchMode: "off",
  autoSwitchAccounts: [],
  historyPolicyVersion: 2,
};
export type AutoSwitchReason =
  | "ledger-unavailable"
  | "exit-settling"
  | "unsupported-platform"
  | "disabled"
  | "not-selected"
  | "desktop-unavailable"
  | "desktop-busy"
  | "desktop-recovery"
  | "desktop-sign-in"
  | "browser-sign-in"
  | "continuation-active"
  | "unknown-active"
  | "source-not-ready"
  | "usage-not-fresh"
  | "quota-available"
  | "no-ready-target"
  | "claude-running"
  | "already-switched"
  | "retry-backoff"
  | "switch-failed"
  | "quota-exhausted"
  | "prepared";
export interface AutoSwitchState {
  status: "off" | "watching" | "waiting" | "blocked" | "switching" | "switched";
  reason: AutoSwitchReason;
  sourceId?: string;
  targetId?: string;
  checkedAt?: string;
  switchedAt?: string;
  retryAt?: string;
}
export interface UsageWindow {
  usedPercent: number;
  resetsAt?: string;
}
export type UsageIssue =
  | "connect-cli"
  | "credentials-missing"
  | "keychain-locked"
  | "renewal-required"
  | "expired"
  | "scope"
  | "identity-mismatch"
  | "rate-limited"
  | "unavailable"
  | "unsupported";
export interface ModelWindow {
  /** API key, e.g. "seven_day_opus". */
  key: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
}
export interface AccountUsage {
  accountId: string;
  connectionRenewalRequired?: boolean;
  status: "idle" | "loading" | "ready" | "error";
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** A model-specific window (e.g. weekly Opus) is exhausted. */
  otherLimitReached?: boolean;
  /** Model-specific windows such as weekly Opus. */
  modelWindows?: ModelWindow[];
  checkedAt?: string;
  stale: boolean;
  issue?: UsageIssue;
  retryAt?: string;
  /** Identity-bound history for display only, never fresh quota evidence. */
  lastKnownResets?: {
    fiveHour?: { resetsAt: string; checkedAt: string };
    sevenDay?: { resetsAt: string; checkedAt: string };
  };
}
