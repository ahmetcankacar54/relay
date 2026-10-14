import type { AccountUsageStatistics } from "./usage-statistics";
import type { DesktopContinuationSnapshot } from "../electron/core/desktop-continuation";
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
  startedAt: string;
  error?: string;
}
export interface Snapshot {
  settings: RelaySettings;
  autoSwitch?: AutoSwitchState;
  continuation?: DesktopContinuationSnapshot;
  fleet?: FleetContinuationState;
  usageStatistics?: Record<string, AccountUsageStatistics>;
  planning?: KeeperSnapshot;
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
  updateAccountPlanning(
    accountId: string,
    input: AccountPlanning,
  ): Promise<Account>;
  consumeTraySwitchRequest(): Promise<string | null>;
  setTrayLanguage(language: "tr" | "en"): Promise<void>;
  onTraySwitch(callback: () => void): () => void;
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
  recoverDesktop(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  panelSnapshot(): Promise<Snapshot>;
  createAccount(input: CreateAccount): Promise<Account>;
  checkAuth(accountId: string): Promise<Account>;
  login(accountId: string): Promise<AuthFlow>;
  reopenLogin(accountId: string, attemptId: string): Promise<void>;
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
  /** "all": every Desktop-connected account shares local Code history. */
  desktopHistoryTransfer: "all" | "same-group" | "selected" | "off";
  desktopHistoryAccounts: string[];
  autoSwitchMode: "off" | "after-exit";
  autoSwitchAccounts: string[];
  /** 2: registries before "all" existed were migrated from the old default. */
  historyPolicyVersion?: 2;
}
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
}
export const DEFAULT_PLANNING: PlanningSettings = {
  autoStart: false,
  timeZone: "Europe/Istanbul",
  weekday: { enabled: true, start: "09:00", end: "18:00" },
  weekend: { enabled: false, start: "11:00", end: "17:00" },
  accounts: [],
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
export interface KeeperSnapshot {
  enabled: boolean;
  running: boolean;
  accounts: KeeperAccountStatus[];
  /** Most recent first, at most 20. */
  attempts: WindowAttempt[];
  /** Planned window starts on today's plan. */
  plannedToday: number;
  next?: { accountId: string; at: string };
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
  desktopHistoryTransfer: "all",
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
