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
import type { Destination, PageId, PageIntent } from "../src/app/routes";
import { DEFAULT_PROXY_CONFIG, type ProxyClientId, type ProxyConfig, type ProxyRequestLog } from "./proxy-types";
export type { ProxyClientId, ProxyRequestLog } from "./proxy-types";
export type AccountKind = "personal" | "work";
export type AccountPlan = "unknown" | "pro" | "max5" | "max20" | "team";
export type AccountProvider = "claude" | "codex" | "antigravity" | "gemini";
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
  provider?: AccountProvider;
  cooldownUntil?: string;
  planning?: AccountPlanning;

  desktop?: {
    accountUuid: string;
    orgId: string;
    savedAt: string;
    email?: string;
    /**
     * Set when the saved Claude app sign-in ended: Claude signed the account out right after a
     * switch put it in place, or the user signed out of it inside Claude. Until the account is
     * signed in again no unattended switch goes to it.
     */
    rejectedAt?: string;
  };
  auth?: {
    loggedIn: boolean;
    email?: string;
    accountUuid?: string;
    orgId?: string;
    orgName?: string;
    subscription?: string;
    /** The plan read from the sign-in (Claude Code's rate-limit tier); it fills `planning.plan`. */
    plan?: Exclude<AccountPlan, "unknown">;
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
  /** The sign-in page was opened in Relay's own window for the account. */
  inWindow?: boolean;
  /** Relay can show the page in its own window, beside the system browser it opens by default. */
  windowAvailable?: boolean;
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
  /** Accounts opened in a separate Claude window, next to the main Claude. */
  windows?: SeparateWindows;
  /** Relay's own updates: a newer release found, downloaded and ready to install. */
  update?: UpdateState;
  usage: Record<string, AccountUsage>;
  authFlows: AuthFlow[];
  /** Sign-ins being made for the terminal, one per account at most. */
  terminalFlows?: AuthFlow[];
  accounts: Account[];
  sessions: Session[];
  runs: Run[];
  diagnostics: Diagnostics;
  importEnabled: boolean;
  warnings: string[];
}
/**
 * Separate Claude windows: an account opened in its own Claude, on a data folder of its own,
 * while the main Claude stays on its account. Off until turned on in Settings; macOS only.
 */
export interface SeparateWindows {
  supported: boolean;
  enabled: boolean;
  /** The Relay accounts whose window runs now. */
  open: { accountId: string; openedAt?: number }[];
  /** Claudes on a data folder of their own that Relay did not open. */
  others: number;
}
/**
 * Relay's own update, as the main process sees it. `available`: a newer release exists; it is
 * downloading, then `ready` once downloaded and verified. `manual`: it cannot install itself
 * here (`manualReason`), so the release page is offered instead.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "manual"
  | "error";
export type UpdateManualReason = "no-asset" | "location" | "not-writable" | "not-appimage";
export interface UpdateState {
  status: UpdateStatus;
  /** The running version. */
  current: string;
  /** Checks run by themselves at start and every few hours. */
  autoCheck: boolean;
  /** The newer release's version. */
  version?: string;
  /** Its release page. */
  notesUrl?: string;
  /** Download progress, 0–1, while downloading. */
  progress?: number;
  manualReason?: UpdateManualReason;
  /** Why the last check, download or install failed. */
  error?: string;
  /** When the last check finished. */
  checkedAt?: string;
}
export interface CreateAccount {
  name: string;
  kind: AccountKind;
  group?: string;
  provider?: AccountProvider;
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
  /**
   * Which of several Code workspaces the Claude app is in now, when its own files say so.
   * `certain` when they name it outright; otherwise it is only the most recently used.
   */
  orgHint?: { orgId: string; certain: boolean };
  activeProfileId?: string;
  pendingProfileId?: string;
  busy: boolean;
  error?: string;
  recoveryRequired: boolean;
  errorRevision: number;
  lastBackup?: string;
  /** Relay saves the Claude app sign-in for this profile by itself once it is complete. */
  autoCapture?: AutoCaptureState;
  /**
   * How many separate Claude windows (a Claude on its own data folder) run beside the main one.
   * Automatic switching, the fleet and continuation wait while one does.
   */
  windows?: number;
  /** The Proxy Gateway's live state; absent where the gateway is not available. */
  proxyStatus?: ProxyStatus;
}
/** One account as the Proxy Gateway sees it, for the routing monitor. */
export interface ProxyAccountStatus {
  id: string;
  name: string;
  provider?: AccountProvider;
  email?: string;
  /** The account the gateway's last request went to. */
  active: boolean;
  /** The account has a saved sign-in the gateway can use. */
  signedIn: boolean;
  /** The fuller of the 5-hour and weekly windows, 0–100; absent until limits are read. */
  quotaPercent?: number;
  /** Minutes until the soonest limit window resets. */
  resetInMinutes?: number;
  /** The 5-hour window, 0–100 used, and minutes until it resets. */
  fiveHourPercent?: number;
  fiveHourResetMinutes?: number;
  /** The weekly window, 0–100 used, and minutes until it resets. */
  weeklyPercent?: number;
  weeklyResetMinutes?: number;
  /** The gateway may route to it; false when it was taken out of the pool. */
  inPool: boolean;
  /** Requests the gateway sent it since it started. */
  requests: number;
  /** Tokens it answered since the gateway started. */
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /**
   * The gateway is keeping it out: `limit` (a window is spent, or it billed extra usage),
   * `auth` (its sign-in was refused or cannot be read), `transient` (an overload). Minutes
   * until it is tried again.
   */
  waiting?: { reason: "limit" | "auth" | "transient"; minutes: number };
  /** Its latest answer was billed as extra usage (`billed`), or a request needed it (`required`). */
  extraUsage?: { kind: "billed" | "required"; minutesAgo: number };
}
/** A client tool Relay can point at the gateway, and whether it is now. */
export interface ProxyClientStatus {
  id: ProxyClientId;
  /** The tool's settings folder exists on this Mac. */
  installed: boolean;
  /** Its settings point at this gateway with the current key. */
  bound: boolean;
  /** Its settings point at the gateway but with an old address or key. */
  stale: boolean;
  /** The settings file Relay writes. */
  file: string;
  /** Why Relay will not write it (e.g. another provider is set), when it will not. */
  blocked?: string;
}
/** What the Proxy Gateway page shows: whether the gateway runs, how it is reached, and what it did. */
export interface ProxyStatus {
  running: boolean;
  port: number;
  host: string;
  clientApiKey?: string;
  routingStrategy?: "soonest-reset" | "balanced" | "strict-priority";
  affinityTtlSeconds?: number;
  stats: {
    totalRequests: number;
    activeRequests: number;
    promptCacheHits: number;
    cacheHitRate: number;
  };
  accounts: ProxyAccountStatus[];
  /** Why the gateway is not running although it is turned on (e.g. the port is in use). */
  error?: string;
  /** The latest requests, newest first. */
  recent?: ProxyRequestLog[];
  /** This Mac's Tailscale address, when it is on a tailnet. */
  tailscaleAddress?: string;
  /** The client tools and whether each is pointed at the gateway. */
  clients?: ProxyClientStatus[];
}
/** Local session discovered on disk for 1-click Zero-Friction onboarding. */
export interface DetectedProviderSession {
  provider: AccountProvider;
  detected: boolean;
  email?: string;
  name?: string;
  accountUuid?: string;
  orgId?: string;
  orgName?: string;
  plan?: string;
  source?: string;
  alreadyLinkedAccountId?: string;
  alreadyLinkedAccountName?: string;
}
export type CascadeLayerStatus = "done" | "ready" | "skipped" | "pending";
export interface OneClickConnectInput {
  provider: AccountProvider;
  name: string;
  kind: AccountKind;
  group?: string;
  /** Codex only: an OpenAI API key typed by the user. */
  apiKey?: string;
}
export interface OneClickCascadeResult {
  account: Account;
  layers: {
    desktop: CascadeLayerStatus;
    usage: CascadeLayerStatus;
    terminal: CascadeLayerStatus;
    extensionAndProxy: CascadeLayerStatus;
  };
  needsSignIn?: boolean;
}
export interface AntigravityOAuthStart { accountId: string; state: string }
export type AntigravityOAuthPoll =
  | { status: "wait" }
  | { status: "ok"; result: OneClickCascadeResult }
  | { status: "error"; error: string };
/**
 * The automatic save of a Claude app sign-in: waiting for the sign-in and Code, waiting for the
 * user to pick one of several workspaces, saving (Claude restarts), saved, or failed. `alreadySaved`
 * names a saved account that is signed in instead of a new one.
 */
export interface AutoCaptureState {
  accountId: string;
  status: "waiting" | "choose-org" | "saving" | "saved" | "failed";
  orgs?: string[];
  /** The workspace the Claude app used last, offered first when the user has to choose. */
  suggestedOrg?: string;
  alreadySaved?: string;
  /** "timeout", "other-pending", or the save's own error. */
  error?: string;
}
/** A DesktopManager operation; each may restart Claude. */
export type DesktopOperationKind =
  | "switch"
  | "save"
  | "link"
  | "cancel-link"
  | "merge"
  | "restore"
  | "window";
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
  /** Opens claude.ai in the browser whose extension Relay manages, for signing in there again. */
  openClaudeWeb(): Promise<void>;
  /** Opens Settings → Switching in the main window, where the extension is reconnected. */
  openExtensionSettings(): Promise<void>;
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
  /** Starts, or brings back, a sign-in for the terminal with the account. */
  linkTerminal(accountId: string): Promise<AuthFlow>;
  cancelTerminalLink(accountId: string, attemptId: string): Promise<void>;
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
  /** Looks for a newer Relay now; resolves with the update state. */
  checkUpdate(): Promise<UpdateState>;
  /** Installs the downloaded update: Relay quits and the new version opens. */
  installUpdate(): Promise<void>;
  /** Turns the automatic update check on or off. */
  setUpdateAuto(enabled: boolean): Promise<void>;
  /** Opens the newer release's page in the browser. */
  openUpdateNotes(): Promise<void>;
  /** Turns separate Claude windows on or off (Settings). */
  setSeparateWindows(enabled: boolean): Promise<void>;
  /** Opens the account in a separate Claude window, or brings its window forward. */
  openWindow(accountId: string): Promise<"opened" | "shown">;
  /** Closes the account's separate window and gives its sign-in back to the vault. */
  closeWindow(accountId: string): Promise<void>;
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
  onNavigate(callback: (page: Destination, intent?: PageIntent) => void): () => void;
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
  updateSettings(input: Partial<Omit<RelaySettings, "proxy">>): Promise<RelaySettings>;
  /** The Proxy Gateway's live state: whether it runs, its client key, counters and routing. */
  proxyStatus(): Promise<ProxyStatus>;
  /** Starts or stops the gateway and saves the choice. Rejects when it cannot start (port in use). */
  proxyToggle(enabled: boolean): Promise<ProxyStatus>;
  /** Changes where the gateway listens (a running one restarts) or how it routes (applied live). */
  proxyConfigure(input: {
    port?: number;
    host?: string;
    routingStrategy?: "soonest-reset" | "balanced" | "strict-priority";
    affinityTtlSeconds?: number;
    /** Account ids in pool order (strict priority uses them in this order). */
    accountOrder?: string[];
    /** Accounts the gateway must not route to. */
    excludedAccountIds?: string[];
  }): Promise<ProxyStatus>;
  /** Replaces the client key (`relay-sec-…`); the old key stops working at once. Bound clients get the new one. */
  proxyRegenerateKey(): Promise<ProxyStatus>;
  /** Writes the client's own settings so it talks to the gateway; the replaced values are kept. */
  proxyBindClient(id: ProxyClientId): Promise<ProxyStatus>;
  /** Takes the gateway out of the client's settings and restores what was there before. */
  proxyUnbindClient(id: ProxyClientId): Promise<ProxyStatus>;
  /**
   * Puts text on the clipboard from main: the window's own clipboard API is refused in Relay's
   * windows. Write only; nothing is ever read back.
   */
  copyText(text: string): Promise<void>;
  /** Discovers local sessions for Claude, OpenAI/Codex, and Google Antigravity for 1-click onboarding. */
  detectProviders(): Promise<DetectedProviderSession[]>;
  /** Connects and cascades a provider account across Desktop, Usage, CLI, and Proxy Gateway in one click. */
  oneClickConnect(input: OneClickConnectInput): Promise<OneClickCascadeResult>;
  startAntigravityOAuth(input: Pick<OneClickConnectInput, "name" | "kind" | "group">): Promise<AntigravityOAuthStart>;
  pollAntigravityOAuth(input: AntigravityOAuthStart): Promise<AntigravityOAuthPoll>;
  /** Stops a pending Antigravity sign-in and removes the account it was creating. */
  cancelAntigravityOAuth(input: AntigravityOAuthStart): Promise<void>;
  /** Finishes a pending Antigravity sign-in from the localhost address the browser ended on. */
  submitAntigravityCallback(input: AntigravityOAuthStart & { url: string }): Promise<void>;
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
  /** Renames an account and sets its type and sharing group. */
  updateAccount(accountId: string, input: CreateAccount): Promise<Account>;
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
  /** The local Proxy Gateway; changed through the proxy calls, never through updateSettings. */
  proxy?: ProxyConfig;
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
  proxy: { ...DEFAULT_PROXY_CONFIG },
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
  | "separate-window"
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
  /**
   * The sign-in the last read went through: the account's Claude Code sign-in, or, without one,
   * its Claude app sign-in (claude.ai's own usage page).
   */
  source?: "cli" | "desktop";
  issue?: UsageIssue;
  retryAt?: string;
  /** Identity-bound history for display only, never fresh quota evidence. */
  lastKnownResets?: {
    fiveHour?: { resetsAt: string; checkedAt: string };
    sevenDay?: { resetsAt: string; checkedAt: string };
  };
}
