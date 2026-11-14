import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import {
  AUTH_KEYS,
  COOKIE_FILES,
  identity,
  directories,
  readBytes,
  readObject,
  writeBytes,
  jsonBytes,
  planHistoryDetailed,
  planPermissionPreferences,
  DESKTOP_PREFERENCES,
  scopePath,
  uuid,
  type CarriedConversation,
  type JsonObject,
} from "./desktop-files";
import { activeOrgHint, type OrgHint } from "./desktop-org";
import {
  CLAUDE_SIGNED_OUT,
  SIGN_IN_WITHOUT_SESSION,
  SignInNotSettled,
  sessionEndsMs,
  sessionPresence,
  type SessionPresence,
} from "./desktop-session";
import type {
  Account,
  DesktopOperationKind,
  DesktopRestartEvent,
  DesktopState,
  SidebarGapSummary,
} from "../../shared/types";
import {
  allowedHistoryPair,
  historySources,
} from "../../shared/history-policy";
import { summarizeHistory } from "./desktop-history";
import type { ClaudeWindowProcess } from "./desktop-instances";
import { errorMessage, type DraftJob, type DraftResult } from "../draft-job";
import {
  CLAUDE_RUNNING,
  captureDrafts,
  sweepStaleDraftScratch,
  type CaptureOutcome,
} from "./draft-transfer";
import { safeMessage, shortId } from "./draft-diagnostics";
import { pruneSwitchBackups } from "./backup-prune";
import type { CapturedDraft } from "./drafts";
import { removeLegacyDraftBackups } from "./draft-storage";
import {
  UnsupportedSidebar,
  planSidebarGap,
  readSidebarStorage,
  sidebarRecipe,
} from "./sidebar-layout";
import { SidebarGapVault, type SidebarGapRecord } from "./sidebar-vault";
import {
  DraftVault,
  summarize,
  type DraftRecord,
  type DraftState,
  type DraftSummary,
} from "./draft-vault";
import {
  browserRunning,
  dataDir, deniedBrowsers,
  readJson,
  type BrowserSystem,
} from "./browser-system";
import { clearScratch, type ExtensionStorage } from "./extension-storage";
import { anthropicUnreachable } from "./usage-refresh";
import { ExtensionSwitcher } from "./extension-switch";
import { ExtensionVault } from "./extension-vault";
import { CookieVault } from "./cookie-vault";
import {
  TerminalSwitcher,
  TerminalVault,
  adoptTerminalSignIn,
  type TerminalAdoption,
  type TerminalPorts,
} from "./terminal-identity";
import {
  DEFAULT_TERMINAL_MODE,
  terminalIdentities,
  type TerminalCurrent,
  type TerminalOutcome,
  type TerminalStatus,
} from "../../shared/terminal-identity";
import type { CookieStorage } from "./cookie-store";
import type { ClaudeSignOut, LaunchWatch, PageOutcome } from "./desktop-launch";
import {
  BROWSERS,
  DEFAULT_EXTENSION,
  chooseInstance,
  pickInstance,
  startupRestores,
  type ExtensionCurrent,
  type ExtensionMode,
  type ExtensionOffer,
  type ExtensionOutcome,
  type ExtensionStatus,
} from "../../shared/browser-extension";

/** The account's uuids for the extension step: Desktop's and its own, any that exist. */
const accountUuids = (account: Account) =>
  [account.desktop?.accountUuid, account.auth?.accountUuid].filter(
    (value): value is string => !!value,
  );

export interface DesktopHost {
  available(): Promise<boolean>;
  /** Whether Claude runs, from a full process listing. */
  running(): Promise<boolean>;
  /**
   * Whether Claude seems to run, for display: may answer from a pid seen alive in the last
   * minute instead of a full listing. Never used to decide a quit, launch or write.
   */
  seemsRunning?(): Promise<boolean>;
  /**
   * Asks Claude to quit and waits for it to close. While Claude still runs after being asked,
   * `answerGuard` may answer its own question about work left running; whether it did.
   */
  quit(answerGuard?: () => Promise<boolean>): Promise<void>;
  /** Starts Claude, without HTTP/3 when `options.quicOff`. */
  launch(options?: LaunchOptions): Promise<void>;
  seal(data: string): Buffer;
  unseal(data: Buffer): string;
  /**
   * Runs the draft helper on `job` while Claude is closed: it reads the drafts in the job's
   * private copy of Claude's Local Storage. Resolves only once the helper has exited or been
   * killed. Without it, no drafts are captured.
   */
  readDrafts?(job: DraftJob): Promise<DraftResult>;
  /** Why drafts cannot be captured on this machine, or undefined when they can. */
  draftsBlocked?(): Promise<string | undefined>;
  /** The Electron version inside Claude.app, which the draft helper checks its own against. */
  claudeElectron?(): Promise<string | undefined>;
  /** Where the draft step makes the helper's scratch dirs; os.tmpdir() when unset. */
  draftScratchDir?: string;
  /** How long Claude's main process has run, in ms; undefined when that cannot be told. */
  claudeUptimeMs?(): Promise<number | undefined>;
  /**
   * Called right before a launch: watches Claude's own log, so the launch's claude.ai page can
   * be told booted or stuck. Undefined when Claude's log cannot tell.
   */
  watchLaunch?(): Promise<LaunchWatch | undefined>;
  /**
   * Whether the Claude that runs signed itself out since it started (its page went to /logout
   * and no sign-in followed), from Claude's own log. Undefined when that cannot be told.
   */
  signedOut?(): Promise<boolean | undefined>;
  /** The accounts Claude's log shows signing out lately, each with its last time. */
  signOuts?(): Promise<ClaudeSignOut[]>;
  /**
   * The Claudes that run on their own data folder (`--user-data-dir`), next to the main one: the
   * separate windows. None of their processes count in `running`, `quit` or `launch`. macOS only.
   */
  windows?(): Promise<ClaudeWindowProcess[]>;
  /** Starts a new Claude on the data folder `dir`. */
  launchWindow?(dir: string, options?: LaunchOptions): Promise<void>;
  /** Asks the window whose main process is `pid` to quit; Claude may still ask the user first. */
  quitWindow?(pid: number): Promise<void>;
  /** Brings the window whose main process is `pid` forward. */
  activateWindow?(pid: number): Promise<void>;
  /**
   * The Claude the accessibility helper is to look at: undefined while no window runs, the main
   * Claude's pid while one does, and null while one does but the main Claude is closed.
   */
  automationTarget?(): Promise<number | null | undefined>;
  /** How many windows the last full process listing saw; 0 before one. */
  windowsSeen?(): number;
}
export interface LaunchOptions {
  /** Start Claude without HTTP/3 (QUIC), so its requests go over HTTP/2. */
  quicOff?: boolean;
}
interface SavedLogin {
  accountUuid: string;
  auth: JsonObject;
  cookies: Record<string, string | null>;
}
interface Backup {
  files: Record<string, string | null>;
  createdAt: string;
  historySeen?: string | null;
}
interface ApplyOptions {
  closedOnly?: boolean;
  canProceed?: () => boolean;
}
interface Pending {
  profileId: string;
  previousUuid?: string;
  startedAt: string;
}
export interface DesktopSwitchOptions {
  /** Relay switches by itself (auto-switch, the fleet, continuation): never while a window runs. */
  automatic?: boolean;
  closedOnly?: boolean;
  expectedActiveProfileId?: string;
  canProceed?: () => boolean;
  /** Runs right before Claude is asked to quit; throw `DesktopSwitchRefused` to call it off. */
  beforeQuit?: () => Promise<void>;
  /** While Claude, asked to quit, still runs: may answer its question about work left running. */
  answerQuitGuard?: () => Promise<boolean>;
}
/**
 * A switch called off by its guards before Claude was asked to quit: Claude kept running and
 * no file was written, so trying again later restarts nothing twice. Thrown when `canProceed`
 * refuses before the quit; a `beforeQuit` that refuses throws it itself and it passes unchanged.
 * Only the `canProceed` refusal shows as Desktop's error: auto-switch and a single continuation
 * give no other reason. A `beforeQuit` refusal is its caller's to tell, as the fleet's waiting does.
 */
export class DesktopSwitchRefused extends Error {}
const SWITCH_CANCELLED = "Automatic Desktop switch was cancelled before restart.";
/** Keys of the main Claude's config.json a window takes: how it looks, never who is signed in. */
const WINDOW_CONFIG_KEYS = ["locale", "userThemeMode"] as const;
export const SIGN_IN_ENDED =
  "This account’s saved Claude sign-in has ended. Sign in to it again in Relay.";
export const WINDOW_HOLDS_ACCOUNT =
  "This account is open in a separate Claude window. Close that window first.";
export const WINDOW_PAUSES_AUTOMATIC =
  "A separate Claude window is open, so Relay does not switch by itself.";
interface Operation {
  kind: DesktopOperationKind;
  profileId?: string;
}
/**
 * The lock Relay's processes share so that only one of them runs a Desktop operation. `ensure`
 * takes it, or throws when another process holds it; the function it returns gives it back.
 */
export interface OperationLock {
  ensure(kind: DesktopOperationKind): () => void;
}
/** How long observers (the tray, the windows) share one Desktop reading. */
export const DESKTOP_CACHE_MS = 2_500;
/**
 * How long the claude.ai page of a Claude that Relay restarted may take to boot before Relay
 * restarts Claude once more. A page boots 1–15 s after a start; a stuck one has stayed on the
 * loading skeleton for a minute or longer, and a second start then booted in seconds.
 */
export const PAGE_BOOT_MS = 30_000;
/** What a Desktop reading finds on disk and in the process list; the rest is Relay's own state. */
interface DesktopReading {
  available: boolean;
  running: boolean;
  windows: number;
  currentAccountUuid?: string;
  organizations: string[];
  /** Which of several workspaces the Claude app is in, when its own files say (desktop-org.ts). */
  orgHint?: OrgHint;
  recoveryRequired: boolean;
}
/**
 * What a capture says in the diagnosis log: the outcome, and per kept draft where it goes and
 * how long it is, as `alias8:length`, or `new:length` for the new-session screen. Never text.
 */
function captureFields(
  from: string,
  to: string,
  outcome: CaptureOutcome,
  captured: CapturedDraft[],
) {
  return {
    from: shortId(from),
    to: shortId(to),
    status: outcome.status,
    count: captured.length,
    ...(outcome.status === "failed" ? { error: safeMessage(outcome.error) } : {}),
    ...(outcome.status === "skipped" ? { reason: safeMessage(outcome.reason) } : {}),
    drafts: captured
      .map(
        (draft) =>
          `${draft.newSession ? "new" : (shortId(draft.targetAlias) ?? "none")}:${draft.text.length}`,
      )
      .join(","),
  };
}

export class DesktopManager {
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  private started = 0;
  /** How many operations have marked Desktop busy; it only grows. */
  get operations() {
    return this.started;
  }
  private pending?: Pending;
  private lastError?: string;
  private errorRevision = 0;
  private dismissedErrorRevision = -1;
  private lastBackup?: string;
  private vault: string;
  private pendingHistorySeen?: Buffer;
  /** The conversations the last `historyPlan` carries into its target. */
  private carried: CarriedConversation[] = [];
  /** How many conversation cards the last `historyPlan` writes into its target. */
  private written = 0;
  /** The conversations the last switch or merge wrote into the account switched to. */
  get carriedCount(): number {
    return this.written;
  }
  /** Shared with Relay's other processes; taken around every Desktop operation when set. */
  operationLock?: OperationLock;
  /**
   * Told right before an operation first quits Claude, and when that operation
   * ends; operations that never quit Claude report nothing.
   */
  onRestart?: (event: DesktopRestartEvent) => void;
  /**
   * Told when a switch ends and Desktop is free again, closed-only or not, and also when it
   * fails: one that fails late may already have changed the account and captured drafts.
   */
  onSwitched?: () => void;
  /**
   * Told what the draft steps did, for a diagnosis log: an event name and fields that are ids,
   * states, reasons, counts and times, never a draft's text. May throw; nothing depends on it.
   */
  onDraftEvent?: (event: string, fields?: Record<string, unknown>) => void;
  /**
   * How Relay starts Claude, asked right before each start: whether it starts without HTTP/3,
   * and a way to keep HTTP/3 off once a stuck start loaded without it. Either may throw.
   */
  launchChoice?: {
    quicOff(): boolean;
    learnQuicOff(): void;
  };
  /**
   * The separate Claude windows Relay keeps for accounts, asked by a switch: the accounts open in
   * one now (the main Claude cannot take them over while their window holds their sign-in), and
   * the data folder of an account's window, whose Code conversations the main Claude takes over
   * when it switches to that account.
   */
  windows?: {
    openAccounts(): Promise<string[]>;
    anyOpen(): Promise<boolean>;
    folder(accountUuid: string): string | undefined;
  };
  /**
   * Told each Desktop state read fresh from disk and the process list, by `snapshot()` and by
   * `cachedSnapshot()` when its shared reading had expired; never for a reused reading. May
   * throw; nothing depends on it.
   */
  onState?: (state: DesktopState) => void;
  /** The running operation, and whether it has reported its restart. */
  private operation?: Operation & { restarted: boolean };
  /** The account a running switch goes to, for the menu bar title; undefined for any other operation. */
  get switchingTo() {
    return this.operation?.kind === "switch" ? this.operation.profileId : undefined;
  }
  /** The drafts captured at switches, sealed, until they are re-typed or dismissed. */
  private drafts: DraftVault;
  /** What the account switched to lacks of its sources' sidebar organization. */
  private sidebar: SidebarGapVault;
  /** The Claude extension's sign-ins, sealed per account. */
  private extensionVault: ExtensionVault;
  /** The browser profile's claude.ai logins, sealed per account. */
  private cookieVault: CookieVault;
  private extensionSwitcher?: ExtensionSwitcher;
  private lastExtension?: ExtensionOutcome;
  private lastExtensionCheck?: ExtensionCurrent;
  private extensionChecking?: Promise<ExtensionCurrent | undefined>;
  /** The last extension check written to the diagnosis log, so a repeated one is not. */
  private extensionCheckLogged?: string;
  private extensionVerifyTimer?: ReturnType<typeof setTimeout>;
  /**
   * How long after a step reopened the browser Relay looks whether the extension could sign in:
   * it signs in again on its own within a second or two of starting (live, 2026-11-04).
   */
  extensionVerifyMs = 25_000;
  /**
   * Later looks after a step, in ms after it: a claude.ai login put back can work for minutes
   * before claude.ai refuses it (seen 2026-11-13: fine at 25 s, refused 3 minutes later), so one
   * early look misses most failures. None unless set (main sets them).
   */
  extensionRecheckMs: number[] = [];
  /** Counts verification runs: a newer step's run stops an older one's later looks. */
  private extensionVerifyRun = 0;
  /** The last scheduled look, settled once it ran; for tests. */
  extensionVerified?: Promise<void>;
  /**
   * Told when the extension could not sign in to `account` with the login a step put in place;
   * Relay forgot that login, and the user has to sign in again (Settings → Switching).
   */
  onExtensionBroken?: (account: Account) => void;
  /** Whether a copy of Claude's cookie files holds a claude.ai session; tests replace it. */
  sessionOf: (files: Record<string, Buffer | null>) => Promise<SessionPresence> = sessionPresence;
  /** When a saved sign-in's session cookies end (see `noteEndedSignIns`); replaced in tests. */
  sessionEnds: (files: Record<string, Buffer | null>) => Promise<number | undefined> = sessionEndsMs;
  /**
   * How long Relay waits, before it quits Claude, for a sign-in to reach Claude's cookie file:
   * Chromium writes it every 30 seconds, and a Claude quit sooner loses the session.
   */
  sessionSettleMs = 40_000;
  sessionPollMs = 2_000;
  /**
   * When, after a switch started Claude, Relay looks whether Claude signed the account out
   * again: claude.ai answers a session it no longer accepts with 403 within a second or two of
   * the page loading (seen 2026-11-10), and Claude then goes to /logout.
   */
  signInVerifyMs: readonly number[] = [8_000, 20_000];
  private signInVerifyTimer?: ReturnType<typeof setTimeout>;
  /** When `noteEndedSignIns` last looked; it looks at most every half hour. */
  private endedCheckedAt?: number;
  /** The last scheduled look, settled once it ran; for tests. */
  signInVerified?: Promise<void>;
  /**
   * Told when Claude signed `account` out right after a switch put its saved sign-in in place:
   * that sign-in ended, and the user has to sign in to the account again.
   */
  onSignInRejected?: (account: Account) => void;
  /** Whether Anthropic cannot be reached now; a failed sign-in then proves nothing. */
  extensionOffline: () => Promise<boolean> = () => anthropicUnreachable();
  /**
   * The browsers and the extension's storage, for keeping the Claude extension's sign-in with
   * the account at a switch. Without it (not macOS) the step never runs.
   */
  extension?: { system: BrowserSystem; storage: ExtensionStorage; cookies?: CookieStorage };
  /** Where an extension step keeps its backup of the extension's folder; the data folder's `extension-scratch` when unset. */
  extensionScratchDir?: string;
  /**
   * The terminal's Claude Code sign-in (Keychain item, `~/.claude.json`, its refresh lock), for
   * keeping it with the account at a switch. Without it (not macOS) the step never runs.
   */
  terminal?: TerminalPorts;
  /** The terminal's Claude Code sign-ins, sealed per account and organization. */
  private terminalVault: TerminalVault;
  private terminalSwitcher?: TerminalSwitcher;
  private lastTerminal?: TerminalOutcome;
  private lastTerminalCheck?: TerminalCurrent;
  /** The reading observers share; every Desktop operation drops it. */
  private shared?: { at: number; reading: Promise<DesktopReading> };
  constructor(
    readonly root: string,
    private store: Store,
    private host: DesktopHost,
    private transcriptRoot = path.join(os.homedir(), ".claude"),
    private readonly now: () => number = Date.now,
  ) {
    this.vault = path.join(store.root, "desktop-vault");
    this.drafts = new DraftVault(
      this.vault,
      (text) => this.host.seal(text),
      (data) => this.host.unseal(data),
      undefined,
      {
        onReadError: (stage, message) =>
          this.diagnose("vault-read-failed", { stage, message }),
        onRecordRejected: (index) =>
          this.diagnose("vault-record-rejected", { index }),
        onList: (count) => this.diagnose("vault-list", { count }),
      },
    );
    this.sidebar = new SidebarGapVault(this.vault, this.now);
    this.extensionVault = new ExtensionVault(
      this.vault,
      (text) => this.host.seal(text),
      (data) => this.host.unseal(data),
      this.now,
    );
    this.cookieVault = new CookieVault(
      this.vault,
      (text) => this.host.seal(text),
      (data) => this.host.unseal(data),
      this.now,
    );
    this.terminalVault = new TerminalVault(
      this.vault,
      (text) => this.host.seal(text),
      (data) => this.host.unseal(data),
      this.now,
    );
  }
  /** One diagnosis event; a log that fails changes nothing about the drafts. */
  private diagnose(event: string, fields?: Record<string, unknown>) {
    try {
      this.onDraftEvent?.(event, fields);
    } catch {
      // The log is an aid, never a part of a switch.
    }
  }
  async initialize() {
    await fs.mkdir(this.vault, { recursive: true, mode: 0o700 });
    // The first design kept plaintext copies of Claude's Local Storage there.
    await removeLegacyDraftBackups(this.vault);
    // A draft step that stopped with Relay leaves a copy and the helper's result behind.
    await sweepStaleDraftScratch(this.host.draftScratchDir ?? os.tmpdir());
    // So does an extension step: its backup of the extension's folder.
    await clearScratch(this.extensionScratch);
    await clearScratch(`${this.extensionScratch}-cookies`);
    await clearScratch(`${this.extensionScratch}-peek`);
    await this.refreshPending();
    const recovery = await readObject(this.vault, "journal.json");
    if (recovery)
      this.reportError("Desktop recovery is required before switching.");
  }
  /**
   * Re-reads the pending sign-in: another Relay process sharing the vault may have begun or
   * ended one. An unreadable file leaves what was known.
   */
  private async refreshPending() {
    try {
      const pending = await readObject(this.vault, "pending.json");
      this.pending =
        pending && uuid.safeParse(pending.profileId).success
          ? (pending as Pending)
          : undefined;
    } catch {
      // Keep the last known pending sign-in.
    }
  }
  private reportError(message: string) {
    if (this.lastError !== message) this.errorRevision++;
    this.lastError = message;
  }
  /** Shows a problem readying the vault at startup where Desktop errors show. */
  reportVaultError(message: string) {
    this.reportError(message);
  }
  dismissError(revision: number) {
    // A late dismissal must not hide an error from a newer operation.
    if (revision === this.errorRevision) this.dismissedErrorRevision = revision;
  }
  /** Desktop as it is now, read fresh with a full process check: for every decision. */
  async snapshot(): Promise<DesktopState> {
    return this.observed(
      this.state(await this.track(this.read(() => this.host.running()))),
    );
  }
  /**
   * Desktop for observers (the tray, the windows), which never decide a quit, launch or write:
   * concurrent callers share one reading, reused for DESKTOP_CACHE_MS and dropped by every
   * Desktop operation. Relay's own state (busy, sign-in, errors) is always current.
   */
  async cachedSnapshot(): Promise<DesktopState> {
    const shared = this.shared;
    const age = shared ? this.now() - shared.at : -1;
    const reused = !!shared && age >= 0 && age < DESKTOP_CACHE_MS;
    const reading =
      reused && shared
        ? shared.reading
        : this.track(
            this.read(() =>
              this.host.seemsRunning
                ? this.host.seemsRunning()
                : this.host.running(),
            ),
          );
    const state = this.state(await reading);
    return reused ? state : this.observed(state);
  }
  /** Tells `onState` about a state just read; a hook that throws changes nothing. */
  private observed(state: DesktopState): DesktopState {
    try {
      this.onState?.(state);
    } catch {
      // The hook is an aid, never a part of reading Desktop.
    }
    return state;
  }
  /** Shares `reading` with observers until it fails or a Desktop operation drops it. */
  private track(reading: Promise<DesktopReading>) {
    const entry = { at: this.now(), reading };
    this.shared = entry;
    reading.catch(() => {
      if (this.shared === entry) this.shared = undefined;
    });
    return reading;
  }
  /** Readings begun before now are not shared after it. */
  private invalidate() {
    this.shared = undefined;
  }
  private async read(running: () => Promise<boolean>): Promise<DesktopReading> {
    let currentAccountUuid: string | undefined;
    let organizations: string[] = [];
    let orgHint: OrgHint | undefined;
    try {
      const config = await readObject(this.root, "config.json");
      currentAccountUuid = identity(config);
      if (currentAccountUuid) {
        organizations = await directories(
          this.root,
          `claude-code-sessions/${currentAccountUuid}`,
        );
        const since = this.pending ? Date.parse(this.pending.startedAt) : NaN;
        orgHint = activeOrgHint(
          config,
          currentAccountUuid,
          organizations,
          Number.isFinite(since) ? since : undefined,
        );
      }
      if (
        this.lastError ===
        "Claude Desktop data could not be read. No files were changed."
      )
        this.lastError = undefined;
    } catch {
      this.reportError(
        "Claude Desktop data could not be read. No files were changed.",
      );
    }
    const recovery = !!(await readObject(this.vault, "journal.json"));
    await this.refreshPending();
    return {
      available: await this.host.available(),
      running: await running(),
      // From the same listing: the windows it saw.
      windows: this.host.windowsSeen?.() ?? 0,
      currentAccountUuid,
      organizations,
      ...(orgHint ? { orgHint } : {}),
      recoveryRequired: recovery,
    };
  }
  private state(reading: DesktopReading): DesktopState {
    const { currentAccountUuid, organizations } = reading;
    return {
      available: reading.available,
      running: reading.running,
      ...(reading.windows ? { windows: reading.windows } : {}),
      currentAccountUuid,
      organizations: [...organizations],
      ...(reading.orgHint ? { orgHint: { ...reading.orgHint } } : {}),
      activeProfileId: this.store.state.accounts.find(
        (a) =>
          !!a.desktop &&
          a.desktop.accountUuid === currentAccountUuid &&
          organizations.includes(a.desktop.orgId),
      )?.id,
      pendingProfileId: this.pending?.profileId,
      busy: this.busy,
      error:
        this.dismissedErrorRevision === this.errorRevision
          ? undefined
          : this.lastError,
      errorRevision: this.errorRevision,
      recoveryRequired: reading.recoveryRequired,
      lastBackup: this.lastBackup,
    };
  }
  async capture(profileId: string, orgId: string) {
    return this.exclusive({ kind: "save", profileId }, async () => {
      if (this.pending && this.pending.profileId !== profileId)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const account = this.store.account(profileId);
      const state = await this.snapshot();
      if (
        !state.currentAccountUuid ||
        !state.organizations.includes(uuid.parse(orgId))
      )
        throw new Error(
          "Open Claude Desktop, sign in and open the Code tab first.",
        );
      this.assertProfileIdentity(account, state.currentAccountUuid, orgId);
      if (
        this.store.state.accounts.some(
          (a) =>
            a.id !== profileId &&
            a.desktop?.accountUuid === state.currentAccountUuid,
        )
      )
        throw new Error(
          "This Desktop account is already saved in another profile.",
        );
      if (
        account.desktop &&
        account.desktop.accountUuid !== state.currentAccountUuid
      )
        throw new Error(
          "This profile belongs to another Desktop account. Create a new profile.",
        );
      if (
        account.desktop?.accountUuid === state.currentAccountUuid &&
        account.desktop.orgId === orgId &&
        !this.pending
      )
        return;
      // Before Claude is quit: a quit before the session reaches the cookie file loses it.
      await this.settleSession(true);
      await this.quitClaude();
      try {
        const saved = await this.saveCurrent(this.root, true);
        if (saved !== state.currentAccountUuid)
          throw new Error("Desktop account changed during setup. Try again.");
        await this.apply(
          await this.historyPlan({
            ...account,
            desktop: {
              accountUuid: saved!,
              orgId,
              savedAt: new Date().toISOString(),
            },
          }),
        );
        this.store.update((s) => {
          s.accounts.find((a) => a.id === profileId)!.desktop = {
            accountUuid: saved!,
            orgId,
            savedAt: new Date().toISOString(),
            email:
              account.auth?.accountUuid === saved &&
              account.auth.orgId === orgId
                ? account.auth.email
                : account.desktop?.email,
          };
        });
        if (this.pending?.profileId === profileId) {
          this.pending = undefined;
          await writeBytes(this.vault, "pending.json", null);
        }
      } finally {
        if (!(await readObject(this.vault, "journal.json")))
          await this.host.launch();
      }
    });
  }
  /**
   * Points a saved Claude app sign-in at another of the same account's Code workspaces, the one
   * its usage sign-in belongs to. Only the binding changes: the saved sign-in is the account's
   * and covers every workspace, so Claude is not restarted; the next switch or history sync
   * carries conversations into the new workspace. Answers whether anything changed.
   */
  async rebindOrg(profileId: string, orgId: string): Promise<boolean> {
    if (this.busy || this.pending) return false;
    const target = uuid.parse(orgId).toLowerCase();
    const account = this.store.account(profileId);
    const desktop = account.desktop;
    if (!desktop || desktop.orgId.toLowerCase() === target) return false;
    if (
      account.auth?.accountUuid?.toLowerCase() !== desktop.accountUuid.toLowerCase() ||
      account.auth.orgId?.toLowerCase() !== target
    )
      return false;
    const workspaces = await directories(
      this.root,
      `claude-code-sessions/${uuid.parse(desktop.accountUuid)}`,
    );
    const workspace = workspaces.find((org) => org.toLowerCase() === target);
    if (!workspace || this.busy || this.pending) return false;
    this.store.update((s) => {
      const stored = s.accounts.find((a) => a.id === profileId)?.desktop;
      if (stored && stored.accountUuid === desktop.accountUuid) stored.orgId = workspace;
    });
    this.invalidate();
    return true;
  }
  async beginLogin(profileId: string) {
    return this.exclusive({ kind: "link", profileId }, async () => {
      const account = this.store.account(profileId);
      if (account.desktop)
        this.assertProfileIdentity(
          account,
          account.desktop.accountUuid,
          account.desktop.orgId,
        );
      if (this.pending) {
        if (this.pending.profileId !== profileId)
          throw new Error(
            "Finish or cancel the current Desktop sign-in first.",
          );
        await this.host.launch();
        return;
      }
      await this.assertCurrentSaved();
      await this.restart(async () => {
        const current = await this.saveCurrent();
        // Never replace an unknown current account without a recoverable saved slot.
        if (
          current &&
          !this.store.state.accounts.some(
            (a) => a.desktop?.accountUuid === current,
          )
        )
          throw new Error(
            "Save the current Desktop account into a profile before adding another account.",
          );
        const config = (await readObject(this.root, "config.json")) ?? {};
        for (const key of AUTH_KEYS) delete config[key];
        const changes = new Map<string, Buffer | null>([
          ["config.json", jsonBytes(config)],
          ...COOKIE_FILES.map((f) => [f, null] as [string, null]),
        ]);
        await this.apply(changes);
        this.pending = {
          profileId,
          previousUuid: current,
          startedAt: new Date().toISOString(),
        };
        await writeBytes(this.vault, "pending.json", jsonBytes(this.pending));
      });
    });
  }
  async switchTo(profileId: string, options: DesktopSwitchOptions = {}) {
    let switched: Account | undefined;
    await this.exclusive({ kind: "switch", profileId }, async () => {
      if (this.pending)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const target = this.store.account(profileId);
      if (!target.desktop)
        throw new Error("Connect this account in Claude Desktop first.");
      this.assertProfileIdentity(
        target,
        target.desktop.accountUuid,
        target.desktop.orgId,
      );
      if ((await this.windows?.openAccounts())?.includes(target.desktop.accountUuid))
        throw new Error(WINDOW_HOLDS_ACCOUNT);
      // Its saved sign-in ended: an unattended switch would leave Claude signed out.
      if (target.desktop.rejectedAt && (options.automatic || options.closedOnly))
        throw new DesktopSwitchRefused(SIGN_IN_ENDED);
      // Its own processes and log lines sit beside the main Claude's: only a person switches.
      if (options.automatic && (await this.windows?.anyOpen()))
        throw new DesktopSwitchRefused(WINDOW_PAUSES_AUTOMATIC);
      const assertClosedSwitch = async () => {
        if (!options.closedOnly) return;
        if (
          !options.expectedActiveProfileId ||
          options.expectedActiveProfileId === profileId
        )
          throw new Error(
            "The active Desktop account must be known before automatic preparation.",
          );
        const state = await this.snapshot();
        if (state.running)
          throw new Error("Claude is still running. No files were changed.");
        if (state.activeProfileId !== options.expectedActiveProfileId)
          throw new Error(
            "Desktop account changed before automatic preparation.",
          );
        if (
          this.pending ||
          state.recoveryRequired ||
          options.canProceed?.() === false
        )
          throw new Error("Automatic preparation is no longer authorized.");
        const latest = this.store.account(profileId);
        if (
          latest.desktop?.accountUuid !== target.desktop!.accountUuid ||
          latest.desktop?.orgId !== target.desktop!.orgId
        )
          throw new Error(
            "The selected Desktop account changed before automatic preparation.",
          );
        this.assertProfileIdentity(
          latest,
          target.desktop!.accountUuid,
          target.desktop!.orgId,
        );
      };
      await assertClosedSwitch();
      await this.assertCurrentSaved();
      const saved = await this.readLogin(target.desktop.accountUuid);
      const change = async () => {
        await assertClosedSwitch();
        const current = await this.saveCurrent();
        if (
          current &&
          !this.store.state.accounts.some(
            (a) => a.desktop?.accountUuid === current,
          )
        )
          throw new Error("Save the current Desktop account before switching.");
        const config = (await readObject(this.root, "config.json")) ?? {};
        for (const key of AUTH_KEYS) {
          delete config[key];
          if (key in saved.auth) config[key] = saved.auth[key];
        }
        const changes = await this.historyPlan(target);
        const carried = this.carried;
        if (current !== saved.accountUuid) {
          if (current) await this.permissionPreferences(changes, current, target);
          changes.set("config.json", jsonBytes(config));
          for (const f of COOKIE_FILES)
            changes.set(
              f,
              saved.cookies[f] === null || saved.cookies[f] === undefined
                ? null
                : Buffer.from(saved.cookies[f]!, "base64"),
            );
        }
        await assertClosedSwitch();
        await this.apply(changes, {
          closedOnly: options.closedOnly,
          canProceed: options.canProceed,
        });
        // Still inside `change`, so a restart relaunches Claude only once the helper is gone.
        if (current && current !== saved.accountUuid)
          await this.carryDrafts(current, saved.accountUuid, target, carried);
        // Last, while Claude is still closed: a browser quit for it is open again before
        // Claude starts. A switch that keeps Claude closed never quits the browser.
        if (current !== saved.accountUuid)
          await this.extensionStep(target, !options.closedOnly);
      };
      if (options.closedOnly) await change();
      else
        await this.restart(
          change,
          options.canProceed,
          options.beforeQuit,
          options.answerQuitGuard,
        );
      switched = target;
      if (!options.closedOnly) this.verifySignInLater(target);
    }).finally(() => {
      try {
        this.onSwitched?.();
      } catch {
        // A listener never changes how a switch ends.
      }
    });
    // After the operation: it needs no app closed and waits on Claude Code's own lock, which
    // must not hold up the switch. Still awaited, so a CLI switch ends with it done.
    if (switched) await this.terminalStep(switched);
  }
  async cancelLogin() {
    return this.exclusive({ kind: "cancel-link" }, async () => {
      if (!this.pending) return;
      const previous = this.pending.previousUuid;
      const saved = previous ? await this.readLogin(previous) : undefined;
      await this.restart(async () => {
        await this.saveCurrent();
        if (saved) {
          const config = (await readObject(this.root, "config.json")) ?? {};
          for (const key of AUTH_KEYS) {
            delete config[key];
            if (key in saved.auth) config[key] = saved.auth[key];
          }
          const changes = new Map<string, Buffer | null>([
            ["config.json", jsonBytes(config)],
          ]);
          for (const f of COOKIE_FILES)
            changes.set(
              f,
              saved.cookies[f] == null
                ? null
                : Buffer.from(saved.cookies[f]!, "base64"),
            );
          await this.apply(changes);
        }
        this.pending = undefined;
        await writeBytes(this.vault, "pending.json", null);
      });
    });
  }
  async open() {
    let quicOff = false;
    try {
      quicOff = this.launchChoice?.quicOff() === true;
    } catch {
      // Unknown: open as Claude opens by itself.
    }
    try {
      // A Claude already running only comes forward; a new one starts as Relay starts it.
      await this.host.launch(quicOff ? { quicOff } : undefined);
    } finally {
      this.invalidate();
    }
  }
  /**
   * Decrypt every saved Desktop sign-in once without changing anything. After an
   * app identity change macOS asks before releasing the encryption key; doing it
   * while the user is present keeps an unattended switch from waiting on it.
   */
  async verifySavedLogins() {
    for (const account of this.store.state.accounts)
      if (account.desktop) await this.readLogin(account.desktop.accountUuid);
  }
  async historySummary(profileId: string) {
    const account = this.store.account(profileId);
    if (!account.desktop)
      throw new Error("Connect this account in Claude Desktop first.");
    return summarizeHistory(
      this.root,
      account.desktop,
      profileId,
      historySources(
        account,
        this.store.state.accounts,
        this.store.state.settings,
      ).length,
      this.transcriptRoot,
    );
  }
  async syncHistory(profileId: string) {
    return this.exclusive({ kind: "merge", profileId }, async () => {
      if (this.pending)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const account = this.store.account(profileId);
      if (!account.desktop)
        throw new Error("Connect this account in Claude Desktop first.");
      const state = await this.snapshot();
      if (state.activeProfileId !== profileId)
        throw new Error(
          "Switch to this Desktop account before syncing its history.",
        );
      this.assertProfileIdentity(
        account,
        account.desktop.accountUuid,
        account.desktop.orgId,
      );
      await this.restart(async () => {
        if (
          identity(await readObject(this.root, "config.json")) !==
          account.desktop!.accountUuid
        )
          throw new Error("Desktop account changed during setup. Try again.");
        await this.apply(await this.historyPlan(account));
      });
    });
  }
  private get extensionScratch() {
    return this.extensionScratchDir ?? path.join(this.store.root, "extension-scratch");
  }
  private switcher(): ExtensionSwitcher | undefined {
    const ports = this.extension;
    if (!ports) return undefined;
    this.extensionSwitcher ??= new ExtensionSwitcher({
      ...ports,
      vault: this.extensionVault,
      cookieVault: this.cookieVault,
      cookieScratch: `${this.extensionScratch}-cookies`,
      scratch: this.extensionScratch,
      now: this.now,
      // Key names only, so a renamed sign-in key can be found from the log.
      onUnknownLayout: (names) =>
        this.diagnose("extension-keys", {
          count: names.length,
          names: names.map((name) => name.slice(0, 40)).join(" "),
        }),
      // Cookie names and database versions only, never values.
      onCookieLayout: (detail) =>
        this.diagnose(
          "extension-cookie-layout",
          Object.fromEntries(
            Object.entries(detail).map(([key, value]) => [key, value.slice(0, 200)]),
          ),
        ),
      onForeignLogin: (account, other, why) =>
        this.diagnose("extension-foreign-login", {
          account: shortId(account),
          other: shortId(other),
          why,
        }),
      onFreshLogin: (account, from) =>
        this.diagnose("extension-fresh-login", { account: shortId(account), from: shortId(from) }),
    });
    return this.extensionSwitcher;
  }
  /**
   * Each account uuid's organization and each account's uuids (lower case), for telling
   * claude.ai logins apart (see ExtensionSwitcher's `foreignLogin`).
   */
  private extensionAccounts(): { orgs: Record<string, string>; groups: string[][] } {
    const orgs: Record<string, string> = {};
    const groups: string[][] = [];
    for (const account of this.store.state.accounts) {
      const uuids = accountUuids(account).map((uuid) => uuid.toLowerCase());
      groups.push(uuids);
      const org = (account.desktop?.orgId ?? account.auth?.orgId)?.toLowerCase();
      if (org) for (const uuid of uuids) orgs[uuid] = org;
    }
    return { orgs, groups };
  }
  /**
   * Runs `verifyExtension` once `extensionVerifyMs` has passed and again at each of
   * `extensionRecheckMs`, until a look finds the failure or the extension elsewhere; a newer step
   * replaces the run. `extensionVerified` settles after the first look.
   */
  private verifyExtensionLater(target: Account, after: string) {
    if (this.extensionVerifyTimer) clearTimeout(this.extensionVerifyTimer);
    const run = ++this.extensionVerifyRun;
    const times = [
      this.extensionVerifyMs,
      ...this.extensionRecheckMs.filter((ms) => ms > this.extensionVerifyMs).sort((x, y) => x - y),
    ];
    let first!: () => void;
    this.extensionVerified = new Promise<void>((resolve) => {
      first = resolve;
    });
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        this.extensionVerifyTimer = setTimeout(() => {
          this.extensionVerifyTimer = undefined;
          resolve();
        }, ms);
        this.extensionVerifyTimer.unref?.();
      });
    void (async () => {
      let elapsed = 0;
      for (const [index, at] of times.entries()) {
        await sleep(Math.max(0, at - elapsed));
        elapsed = at;
        if (run !== this.extensionVerifyRun) break;
        const done = await this.verifyExtension(target, after);
        if (index === 0) first();
        if (done) break;
      }
    })()
      .catch(() => undefined)
      .finally(() => first());
  }
  /**
   * After a step put a sign-in in place: when a check made since then finds the extension on
   * `target` but recording a failed sign-in, the claude.ai login put in place does not sign in to
   * that account (it is another account's, or it ended). That login is forgotten, so the next
   * switch does not put it back and sign the extension out again, and `onExtensionBroken` is told.
   * Whether later looks are pointless: the failure was found, or the extension is elsewhere now.
   * Never throws.
   */
  private async verifyExtension(target: Account, after: string): Promise<boolean> {
    try {
      // A check is skipped while a Desktop operation runs, and the switch that put the sign-in in
      // place may still wait for Claude to open: the look waits for it, up to five minutes.
      const pause = this.extensionVerifyMs > 0 ? 5_000 : 20;
      for (let tries = 0; this.busy && tries < 60; tries++)
        await new Promise<void>((resolve) => setTimeout(resolve, pause).unref?.());
      await this.checkExtension();
      const current = this.lastExtensionCheck;
      // Skipped while a Desktop operation ran: an older reading proves nothing.
      if (!current || Date.parse(current.at) <= Date.parse(after)) return false;
      const mine = accountUuids(target).map((uuid) => uuid.toLowerCase());
      const here =
        current.state === "signed-in" && !!current.accountUuid && mine.includes(current.accountUuid);
      const failed = here && current.state === "signed-in" && !!current.expired;
      this.diagnose("extension-verify", {
        to: shortId(target.desktop?.accountUuid ?? target.id),
        state: current.state,
        ...(current.state === "signed-in" && current.accountUuid
          ? { account: shortId(current.accountUuid) }
          : {}),
        signedIn: !failed,
      });
      // Moved to another account since: what it does there is not this step's.
      if (current.state === "signed-in" && current.accountUuid && !here) return true;
      if (!failed) return false;
      return await this.extensionFailed(target, current.accountUuid!, false);
    } catch {
      // A look that fails says nothing; the next check shows the state.
      return false;
    }
  }
  /**
   * The extension recorded a failed sign-in on `target` (`uuid`): the claude.ai login saved for
   * it does not work, so it is forgotten and the account waits for a reconnect; `onExtensionBroken`
   * is told, once while it waits when `quiet`. Not while Anthropic cannot be reached, where no
   * login could have worked. Whether it was taken as broken.
   */
  private async extensionFailed(target: Account, uuid: string, quiet: boolean): Promise<boolean> {
    const mine = accountUuids(target).map((x) => x.toLowerCase());
    if (quiet) {
      for (const x of mine) if (await this.cookieVault.isWaiting(x)) return true;
    }
    if (await this.extensionOffline().catch(() => false)) {
      this.diagnose("extension-verify-offline", { account: shortId(uuid) });
      return false;
    }
    const saved = await this.cookieVault.list();
    const held = mine.filter((x) => saved.some((s) => s.accountUuid === x));
    // With nothing saved, the account still waits for a reconnect, so it is told once.
    for (const x of held.length ? held : [uuid.toLowerCase()]) await this.cookieVault.reject(x);
    this.diagnose("extension-pair-broken", { account: shortId(uuid) });
    try {
      this.onExtensionBroken?.(target);
    } catch {
      // A listener never changes what was found.
    }
    return true;
  }
  /**
   * The background look: who the extension is signed in to, and whether its sign-in still works.
   * A sign-in that fails long after a switch (claude.ai refused the login later) is found here,
   * told once and offered a reconnect, instead of only when Settings is opened. Quiet while an
   * operation runs and in mode "off". Never throws.
   */
  async extensionHealth(): Promise<void> {
    try {
      const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
      if (setting.mode === "off" || this.busy || !this.switcher()) return;
      await this.checkExtension();
      const current = this.lastExtensionCheck;
      if (current?.state !== "signed-in" || !current.expired || !current.accountUuid) return;
      const uuid = current.accountUuid.toLowerCase();
      const account = this.store.state.accounts.find((a) =>
        accountUuids(a).some((x) => x.toLowerCase() === uuid),
      );
      if (account) await this.extensionFailed(account, uuid, true);
    } catch {
      // The next look tries again.
    }
  }
  /** What the last extension step did, or undefined when none ran since Relay started. */
  get extensionOutcome(): ExtensionOutcome | undefined {
    return this.lastExtension;
  }
  /**
   * Keeps the Claude extension's sign-in with `target`: saves what the extension holds and puts
   * the target's in place (see ExtensionSwitcher). Never throws, so it can never fail or hold up
   * a switch. Logs statuses and short ids only, never a key or a value.
   */
  private async extensionStep(
    target: Account,
    mayQuit: boolean,
    /** The mode the step runs in instead of the saved one; never one that reads less. */
    mode?: ExtensionMode,
  ): Promise<ExtensionOutcome | undefined> {
    try {
      const switcher = this.switcher();
      if (!switcher) return undefined;
      const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
      const outcome = await switcher.run({
        setting: mode && setting.mode !== "off" ? { ...setting, mode } : setting,
        mayQuit,
        target: accountUuids(target),
        known: this.store.state.accounts.flatMap(accountUuids),
        ...this.extensionAccounts(),
      });
      this.lastExtension = outcome;
      // Mode "guide" looked at who the extension is on: that is the newest check too.
      if (outcome.current) this.lastExtensionCheck = outcome.current;
      // The step removed the record of a failed sign-in: the last check's "expired" is no longer
      // true, and Settings and the account page read it until the next check.
      else if (outcome.cleared && this.lastExtensionCheck?.state === "signed-in") {
        const { expired: _gone, ...check } = this.lastExtensionCheck;
        this.lastExtensionCheck = { ...check, at: outcome.at };
      }
      this.diagnose("extension", {
        to: shortId(target.desktop?.accountUuid ?? target.id),
        result: outcome.result,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        restarted: outcome.restarted,
        ...(outcome.reopened === undefined ? {} : { reopened: outcome.reopened }),
        saved: outcome.saved,
        ...(outcome.cleared ? { cleared: true } : {}),
      });
      // A sign-in was put in place or a failure record removed: the extension signs in on its own
      // (right away when the browser was opened again, or once it is), and Relay looks whether
      // that worked, again over the next half hour.
      if (outcome.result === "switched" || outcome.cleared)
        this.verifyExtensionLater(target, outcome.at);
      // The account's saved login had ended: it waits for a reconnect, and the user is told.
      if (outcome.reason === "login-expired") {
        this.diagnose("extension-login-expired", {
          to: shortId(target.desktop?.accountUuid ?? target.id),
        });
        try {
          this.onExtensionBroken?.(target);
        } catch {
          // A listener never changes the outcome.
        }
      }
      return outcome;
    } catch {
      return undefined;
    }
  }
  /**
   * Runs the extension step for the account Desktop is on, without changing Claude: how to bring
   * the extension along after a switch that left it alone, and a way to test the setup. The user
   * asks for it, so it swaps as mode "restart" does in modes "guide" and "closed" too: a running
   * browser is quit and opened again. Mode "off" still leaves the extension alone.
   */
  async syncExtension(): Promise<ExtensionOutcome> {
    return this.exclusive({ kind: "switch" }, async () => {
      if (this.pending)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const state = await this.snapshot();
      const active = state.activeProfileId
        ? this.store.account(state.activeProfileId)
        : undefined;
      if (!active)
        throw new Error("Switch Claude Desktop to a saved account first.");
      const outcome = await this.extensionStep(active, true, "restart");
      if (!outcome)
        throw new Error("The Claude browser extension is not supported here.");
      return outcome;
    });
  }
  /**
   * The browser (its name) a switch now would quit for the extension step: the mode is "restart",
   * the extension is found and its browser runs. For a prompt that says so before it happens.
   */
  async extensionQuitsBrowser(): Promise<string | undefined> {
    const switcher = this.switcher();
    if (!switcher || !this.extension) return undefined;
    const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
    if (setting.mode !== "restart") return undefined;
    const target = chooseInstance(switcher.instances(), setting.browser);
    if (
      !target ||
      !(await this.extension.storage.available()) ||
      !(await browserRunning(this.extension.system, target.app))
    )
      return undefined;
    return BROWSERS[target.app].name;
  }
  /**
   * The panel's offer to bring the extension to the account Desktop is on (see ExtensionOffer),
   * from what Relay last saw: a check, or a switch whose step changed nothing. None while that
   * reading has the extension on Desktop's account, when it is older than a step that switched,
   * or when the account's extension sign-in or claude.ai login is not saved. Never throws.
   */
  async extensionOffer(): Promise<ExtensionOffer | undefined> {
    try {
      // What Relay last saw, from memory first: the panel asks every few seconds.
      const check = this.lastExtensionCheck;
      const last = this.lastExtension;
      const fromCheck = !!check && (!last || Date.parse(check.at) >= Date.parse(last.at));
      // Mode "closed" left a running browser alone at the switch; any other step is no miss.
      const leftAlone = last?.result === "skipped" && last.reason === "browser-running";
      if (fromCheck ? check!.state === "unreadable" : !leftAlone) return undefined;
      // An extension never opened has nothing to swap; it is opened and signed in to first.
      if (fromCheck && check!.state === "signed-out" && check!.unopened) return undefined;
      const switcher = this.switcher();
      if (!switcher || !this.extension) return undefined;
      const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
      if (setting.mode === "off") return undefined;
      const current = identity(await readObject(this.root, "config.json"))?.toLowerCase();
      const byUuid = (uuid: string) =>
        this.store.state.accounts.find((a) =>
          accountUuids(a).some((x) => x.toLowerCase() === uuid),
        );
      const active = current ? byUuid(current) : undefined;
      if (!active) return undefined;
      const mine = accountUuids(active).map((uuid) => uuid.toLowerCase());
      let on: string | undefined;
      let expired = false;
      const signedOut = fromCheck && check!.state === "signed-out";
      if (fromCheck && check!.state === "signed-in" && check!.accountUuid) {
        const uuid = check!.accountUuid.toLowerCase();
        // On Desktop's account: nothing to bring along, unless its sign-in expired there.
        if (mine.includes(uuid)) {
          if (!check!.expired) return undefined;
          expired = true;
        } else on = byUuid(uuid)?.name;
      }
      const saved = (list: { accountUuid: string }[]) =>
        list.some((x) => mine.includes(x.accountUuid.toLowerCase()));
      const paired =
        saved(await this.extensionVault.list()) && saved(await this.cookieVault.list());
      // Expired with no login to put in place: only signing in again helps, in Settings.
      if (!paired && !expired) return undefined;
      const instance = chooseInstance(switcher.instances(), setting.browser);
      if (!instance) return undefined;
      return {
        accountId: active.id,
        to: active.name,
        ...(on ? { on } : {}),
        ...(signedOut ? { signedOut } : {}),
        ...(expired ? { expired: true as const } : {}),
        ...(expired && !paired ? { reconnect: true as const } : {}),
        browser: BROWSERS[instance.app].name,
      };
    } catch {
      return undefined;
    }
  }
  /** The setting, the extension found, what is saved, and the last result; for the UI. */
  async extensionStatus(): Promise<ExtensionStatus | undefined> {
    const switcher = this.switcher();
    if (!switcher || !this.extension) return undefined;
    const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
    const instances = switcher.instances();
    const pick = pickInstance(instances, setting.browser);
    const target = pick?.instance;
    const { system } = this.extension;
    const broken = await this.cookieVault.waiting().catch(() => undefined);
    const denied = deniedBrowsers(system);
    return {
      setting,
      instances,
      target,
      picked: pick?.picked,
      ...(denied.length ? { denied } : {}),
      restoresTabs: target
        ? startupRestores(
            readJson(
              system,
              path.join(dataDir(system, target.app), target.profile, "Preferences"),
            ),
          )
        : undefined,
      saved: await this.extensionVault.list(),
      cookiesSaved: await this.cookieVault.list(),
      last: this.lastExtension,
      current: this.lastExtensionCheck,
      ...(broken ? { broken } : {}),
    };
  }
  /**
   * Opens claude.ai in the browser whose extension Relay manages, in front, for signing in there
   * with the account the extension should be on. Throws when there is no such browser.
   */
  async openClaudeWeb(): Promise<void> {
    const switcher = this.switcher();
    if (!switcher || !this.extension) throw new Error("The Claude browser extension is not supported here.");
    const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
    const instance = chooseInstance(switcher.instances(), setting.browser);
    if (!instance) throw new Error("No browser with the Claude extension was found.");
    await this.extension.system.openUrl(instance.app, "https://claude.ai/", instance.profile);
  }
  /**
   * Reads who the extension is signed in to from a copy of its storage, without quitting a
   * browser, and saves the sign-in when it is one of Relay's accounts (see
   * ExtensionSwitcher.check). Skipped while a Desktop operation runs, whose own step uses the
   * extension; one check at a time.
   */
  async checkExtension(claimFor?: string): Promise<ExtensionStatus | undefined> {
    const switcher = this.switcher();
    if (!switcher) return undefined;
    const claimed = claimFor ? this.store.account(claimFor) : undefined;
    if (claimFor && !claimed) throw new Error("Account not found.");
    const claim = claimed?.desktop?.accountUuid ?? claimed?.auth?.accountUuid;
    if (claimFor && !claim)
      throw new Error("Save this account’s Claude app sign-in first.");
    if (!this.busy) {
      const uuids = this.store.state.accounts.flatMap(accountUuids);
      // A claim must not ride on a check already running without it.
      if (claim) await this.extensionChecking?.catch(() => undefined);
      this.extensionChecking ??= switcher
        .check({
          setting: this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION,
          known: uuids,
          ...this.extensionAccounts(),
          ...(claim ? { claim } : {}),
        })
        .finally(() => {
          this.extensionChecking = undefined;
        });
      const current = await this.extensionChecking;
      const setting = this.store.state.settings.claudeExtension ?? DEFAULT_EXTENSION;
      const instances = setting.mode === "off" ? [] : switcher.instances();
      const target = chooseInstance(instances, setting.browser);
      if (current) {
        this.lastExtensionCheck = current;
        // Signed in to that account without a failure: it waits for no reconnect any more.
        if (current.state === "signed-in" && !current.expired && current.accountUuid)
          await this.cookieVault.reconnected(current.accountUuid).catch(() => undefined);
        const fields = {
          state: current.state,
          ...(current.state === "signed-in"
            ? {
                known: current.known,
                other: !!current.other,
                ...(current.accountUuid ? { account: shortId(current.accountUuid) } : {}),
                ...(current.expired ? { expired: true } : {}),
              }
            : {}),
          instances: instances.length,
          ...(target ? { target: `${target.app}:${target.profile}`, opened: target.opened } : {}),
        };
        // Settings checks every few seconds while a reconnect waits: only a change is logged.
        const logged = JSON.stringify(fields);
        if (logged !== this.extensionCheckLogged) {
          this.extensionCheckLogged = logged;
          this.diagnose("extension-check", fields);
        }
      } else if (setting.mode !== "off" && !instances.length)
        this.diagnose("extension-check", { state: "none", instances: 0 });
    }
    return this.extensionStatus();
  }
  private terminalStepper(): TerminalSwitcher | undefined {
    if (!this.terminal) return undefined;
    this.terminalSwitcher ??= new TerminalSwitcher(this.terminal, this.terminalVault, this.now);
    return this.terminalSwitcher;
  }
  /**
   * Keeps a sign-in made for the terminal in a scratch folder as `profileId`'s terminal sign-in,
   * then lets the terminal follow when that account is the one open now. Answers what became
   * of it.
   */
  async adoptTerminalSignIn(
    profileId: string,
    ports: Pick<TerminalPorts, "keychain" | "config" | "owner">,
  ): Promise<TerminalAdoption> {
    const result = await adoptTerminalSignIn(
      ports,
      terminalIdentities(this.store.account(profileId)),
      this.terminalVault,
    );
    this.diagnose("terminal-link", { result });
    if (result === "saved") await this.syncTerminal().catch(() => undefined);
    return result;
  }
  private get terminalMode() {
    return this.store.state.settings.terminalCli ?? DEFAULT_TERMINAL_MODE;
  }
  /**
   * Keeps the terminal's Claude Code sign-in with `target` (see TerminalSwitcher). Never throws,
   * so it can never fail or hold up a switch. Logs results and short ids only.
   */
  private async terminalStep(target: Account): Promise<TerminalOutcome | undefined> {
    try {
      const switcher = this.terminalStepper();
      if (!switcher) return undefined;
      const outcome = await switcher.run({
        mode: this.terminalMode,
        target: terminalIdentities(target),
        known: this.store.state.accounts.flatMap(terminalIdentities),
      });
      this.lastTerminal = outcome;
      if (outcome.current) this.lastTerminalCheck = outcome.current;
      this.diagnose("terminal", {
        to: shortId(target.desktop?.accountUuid ?? target.id),
        result: outcome.result,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
        saved: outcome.saved,
      });
      return outcome;
    } catch {
      return undefined;
    }
  }
  /**
   * Runs the terminal step for the account Desktop is on, without changing Claude: how to bring
   * the terminal along after a switch that left it, or after signing it in by hand.
   */
  async syncTerminal(): Promise<TerminalOutcome> {
    if (!this.terminalStepper())
      throw new Error("The terminal's Claude Code is not supported here.");
    const state = await this.snapshot();
    const active = state.activeProfileId
      ? this.store.state.accounts.find((a) => a.id === state.activeProfileId)
      : undefined;
    if (!active) throw new Error("Switch Claude Desktop to a saved account first.");
    return (await this.terminalStep(active))!;
  }
  /** The setting, who the terminal is on, what is saved and the last result; undefined outside macOS. */
  async terminalStatus(): Promise<TerminalStatus | undefined> {
    if (!this.terminalStepper()) return undefined;
    return {
      mode: this.terminalMode,
      current: this.lastTerminalCheck,
      saved: await this.terminalVault.list(),
      last: this.lastTerminal,
      ...(this.gatewayBound?.() ? { viaGateway: true } : {}),
    };
  }
  /** Whether Claude Code is connected to Relay's running gateway (set by the host). */
  gatewayBound?: () => boolean;
  /**
   * Reads who the terminal's Claude Code is signed in to, and saves that sign-in when it is one of
   * Relay's accounts: how an account is linked. Writes nothing to Claude Code.
   */
  async checkTerminal(): Promise<TerminalStatus | undefined> {
    const switcher = this.terminalStepper();
    if (!switcher) return undefined;
    const current = await switcher.check({
      mode: this.terminalMode,
      known: this.store.state.accounts.flatMap(terminalIdentities),
    });
    if (current) {
      this.lastTerminalCheck = current;
      this.diagnose("terminal-check", {
        state: current.state,
        ...(current.state === "signed-in"
          ? {
              known: !!current.known,
              ...(current.accountUuid ? { account: shortId(current.accountUuid) } : {}),
            }
          : {}),
      });
    }
    return this.terminalStatus();
  }
  /**
   * Adds Claude's preferences file to `changes` when the account switched to has not chosen
   * the permission modes that the one being left has (see `planPermissionPreferences`). Follows
   * the history policy, like the conversations; an unreadable file is left alone.
   */
  private async permissionPreferences(
    changes: Map<string, Buffer | null>,
    from: string,
    target: Account,
  ) {
    const settings = this.store.state.settings;
    const source = this.store.state.accounts.find(
      (a) => a.desktop?.accountUuid === from,
    );
    if (
      !target.desktop ||
      settings.desktopHistoryTransfer === "off" ||
      !source ||
      !allowedHistoryPair(source, target, settings)
    )
      return;
    let next: JsonObject | null;
    try {
      next = planPermissionPreferences(
        await readObject(this.root, DESKTOP_PREFERENCES),
        from,
        target.desktop.accountUuid,
      );
    } catch {
      return;
    }
    if (next) changes.set(DESKTOP_PREFERENCES, jsonBytes(next));
  }
  private async historyPlan(
    target: Account,
  ): Promise<Map<string, Buffer | null>> {
    this.pendingHistorySeen = undefined;
    this.carried = [];
    this.written = 0;
    if (!target.desktop) return new Map();
    // The account's own window holds its own conversations: no transfer between accounts.
    const window = this.windows?.folder(target.desktop.accountUuid);
    const off = this.store.state.settings.desktopHistoryTransfer === "off";
    if (off && !window) return new Map();
    const previous = (await readObject(this.vault, "history-seen.json")) ?? {};
    for (const [key, values] of Object.entries(previous)) {
      const parts = key.split("/");
      if (
        parts.length !== 2 ||
        !parts.every((part) => uuid.safeParse(part).success) ||
        !Array.isArray(values) ||
        values.length > 10_000 ||
        values.some(
          (value) => typeof value !== "string" || !value || value.length > 2048,
        )
      )
        throw new Error("Invalid Desktop history tracking data.");
    }
    const key = `${target.desktop.accountUuid}/${target.desktop.orgId}`;
    const sources = off
      ? []
      : historySources(target, this.store.state.accounts, this.store.state.settings);
    const { writes: plan, conversations } = await planHistoryDetailed(
      this.root,
      target.desktop,
      sources.map((a) => a.desktop!),
      {
        seenSpaceIds: previous[key],
        // The conversations the account had in its own window, which it no longer has open.
        ...(window ? { outside: [{ root: window, scope: target.desktop }] } : {}),
      },
    );
    const spacesPath = `${scopePath("local-agent-mode-sessions", target.desktop)}/spaces.json`;
    const planned = plan.get(spacesPath);
    const spaces = planned
      ? JSON.parse(planned.toString("utf8"))
      : await readObject(this.root, spacesPath);
    const seen = [
      ...new Set<string>([
        ...(previous[key] ?? []),
        ...(spaces?.spaces ?? []).map((space: JsonObject) => space.id),
      ]),
    ].sort();
    const next = { ...previous, [key]: seen };
    if (JSON.stringify(next) !== JSON.stringify(previous))
      this.pendingHistorySeen = jsonBytes(next);
    this.carried = conversations;
    const targetDir = `${scopePath("claude-code-sessions", target.desktop)}/`;
    this.written = [...plan].filter(
      ([relative, data]) => relative.startsWith(targetDir) && data !== null,
    ).length;
    return new Map(plan);
  }
  /**
   * Captures the unsent drafts of the account being left (`from`) in the conversations the
   * switch carries, to be re-typed for the one switched to (`to`). Runs once the switch's files
   * are written and while Claude is still closed; it reads only a copy of Claude's Local Storage
   * and keeps what it finds sealed in the vault. Drafts follow the history policy: nothing is
   * captured when it is off or does not allow this pair. Never throws, so a draft can never
   * fail, roll back or hold up a switch.
   *
   * The same read gives the sidebar organization, under the same rules: `planSidebar` keeps what
   * `to` lacks of it. Whatever the last switch offered goes first, so the offer always describes
   * this switch.
   */
  private async carryDrafts(
    from: string,
    to: string,
    target: Account,
    conversations: CarriedConversation[],
  ) {
    await this.sidebar.clear().catch(() => {});
    /** Why no capture was tried, for the diagnosis log: nothing else says. */
    const notRun = (reason: string) =>
      this.diagnose("capture", {
        from: shortId(from),
        to: shortId(to),
        status: "not-run",
        reason,
      });
    try {
      const host = this.host;
      if (!host.readDrafts) return notRun("no-draft-reader");
      const settings = this.store.state.settings;
      if (settings.desktopHistoryTransfer === "off") return notRun("history-off");
      const source = this.store.state.accounts.find(
        (a) => a.desktop?.accountUuid === from,
      );
      if (!source || !allowedHistoryPair(source, target, settings))
        return notRun("pair-not-allowed");
      let blocked: string | undefined;
      let claudeElectron: string | undefined;
      try {
        blocked = (await host.draftsBlocked?.()) || undefined;
        // The copy is made while Claude is closed; one Claude is writing could be torn.
        if (!blocked && (await host.running())) blocked = CLAUDE_RUNNING;
        if (!blocked) claudeElectron = await host.claudeElectron?.();
      } catch (error) {
        blocked = errorMessage(error);
      }
      let captured: CapturedDraft[] = [];
      const outcome = await captureDrafts({
        root: this.root,
        from,
        to,
        conversations,
        // Read only for a step that will run.
        titles:
          blocked || !claudeElectron
            ? {}
            : await this.draftTitles(target, conversations),
        run: (job) => host.readDrafts!(job),
        sidebar: (raw) => this.planSidebar(raw, from, target, conversations),
        store: (account, drafts, slots) => {
          captured = drafts;
          return this.drafts.add(account, drafts, slots);
        },
        lastJson: path.join(this.vault, "drafts", "last.json"),
        now: new Date(),
        blocked,
        claudeElectron,
        // Asked again once the copy is made: Claude can be opened meanwhile.
        running: () => host.running(),
        tmp: host.draftScratchDir,
      });
      this.diagnose("capture", captureFields(from, to, outcome, captured));
    } catch {
      // Drafts never change how a switch ends.
      this.diagnose("capture", {
        from: shortId(from),
        to: shortId(to),
        status: "threw",
      });
    }
  }
  /**
   * Keeps what the account switched to (`target`) lacks of its sources' Code sidebar organization,
   * from the sidebar keys the draft helper read (`raw`, undefined when it read none). The sources
   * are the accounts the history policy allows, the one being left (`from`) first; `conversations`
   * maps their sessions to the target's. Logs counts only, never names or aliases. Never throws.
   */
  private async planSidebar(
    raw: Record<string, string> | undefined,
    from: string,
    target: Account,
    conversations: CarriedConversation[],
  ): Promise<void> {
    const fields = { from: shortId(from), to: shortId(target.desktop!.accountUuid) };
    try {
      if (!raw) return this.diagnose("sidebar", { ...fields, status: "not-read" });
      const storage = readSidebarStorage(raw);
      const sources = historySources(
        target,
        this.store.state.accounts,
        this.store.state.settings,
      )
        .map((account) => account.desktop!)
        .sort(
          (a, b) =>
            Number(b.accountUuid === from) - Number(a.accountUuid === from),
        );
      const gap = planSidebarGap({
        sources: sources.map((scope) => ({
          accountUuid: scope.accountUuid,
          layout: storage.layout(scope),
        })),
        target: {
          accountUuid: target.desktop!.accountUuid,
          layout: storage.layout(target.desktop!),
        },
        conversations,
        starred: storage.starred,
      });
      if (!gap) return this.diagnose("sidebar", { ...fields, status: "none" });
      await this.sidebar.put(target.desktop!.accountUuid, gap);
      this.diagnose("sidebar", {
        ...fields,
        status: "planned",
        sections: gap.sections.length,
        missing: gap.missingSections,
        sessions: gap.sessions,
      });
    } catch (error) {
      this.diagnose("sidebar", {
        ...fields,
        status: error instanceof UnsupportedSidebar ? "unsupported" : "failed",
        reason: safeMessage(errorMessage(error)),
      });
    }
  }
  /** The account named for the sidebar offer: its Relay name, or a short id when it has none. */
  private accountName(accountUuid: string): string {
    return (
      this.store.state.accounts.find(
        (a) => a.desktop?.accountUuid.toLowerCase() === accountUuid.toLowerCase(),
      )?.name ?? shortId(accountUuid)!
    );
  }
  /** The sidebar offer, while Desktop is still on the account it was made for. */
  private async currentSidebarGap(): Promise<SidebarGapRecord | undefined> {
    const record = await this.sidebar.get();
    if (!record) return undefined;
    let current: string | undefined;
    try {
      current = identity(await readObject(this.root, "config.json"));
    } catch {
      return undefined;
    }
    return current?.toLowerCase() === record.to.toLowerCase() ? record : undefined;
  }
  /** What Desktop's current account lacks of its sources' sidebar sections, for the panel. */
  async sidebarGap(): Promise<SidebarGapSummary | undefined> {
    const record = await this.currentSidebarGap();
    if (!record) return undefined;
    return {
      id: record.id,
      to: this.accountName(record.to),
      from: record.gap.from.map((uuid) => this.accountName(uuid)),
      missingSections: record.gap.missingSections,
      sessions: record.gap.sessions,
    };
  }
  /** The recipe of sidebar gap `id`, while it is offered. Main process only. */
  async sidebarRecipe(id: string): Promise<string | undefined> {
    const record = await this.currentSidebarGap();
    if (record?.id !== id) return undefined;
    return sidebarRecipe(record.gap, {
      to: this.accountName(record.to),
      from: record.gap.from.map((uuid) => this.accountName(uuid)),
    });
  }
  async dismissSidebarGap(id: string): Promise<void> {
    await this.sidebar.remove(id);
  }
  /**
   * The title of each carried conversation on the target's card of it, as the merge left it:
   * what the user will see the conversation called. "" when the card has none or cannot be read.
   */
  private async draftTitles(
    target: Account,
    conversations: CarriedConversation[],
  ): Promise<Record<string, string>> {
    const dir = scopePath("claude-code-sessions", target.desktop!);
    const titles: Record<string, string> = {};
    for (const { targetAlias } of conversations) {
      let title: unknown;
      try {
        title = (await readObject(this.root, `${dir}/local_${targetAlias}.json`))
          ?.title;
      } catch {
        // An unreadable card has no title.
      }
      titles[targetAlias] = typeof title === "string" ? title : "";
    }
    return titles;
  }
  /** The captured drafts, newest first, for the panel: no text. */
  async pendingDrafts(): Promise<DraftSummary[]> {
    return (await this.drafts.list()).map(summarize);
  }
  /** The captured drafts with their text. Main process only: text never reaches the renderer. */
  async pendingDraftRecords(): Promise<DraftRecord[]> {
    return this.drafts.list();
  }
  /** The text of the captured draft `id`, or undefined when there is none. Main process only. */
  async draftText(id: string): Promise<string | undefined> {
    return (await this.drafts.list()).find((record) => record.id === id)?.text;
  }
  async markDraft(id: string, state: DraftState, reason?: string): Promise<void> {
    await this.drafts.update(id, { state, reason });
  }
  async dismissDraft(id: string): Promise<void> {
    await this.drafts.remove(id);
  }
  /** How long Claude has run, in ms; undefined when the host cannot tell. */
  async claudeUptimeMs(): Promise<number | undefined> {
    return this.host.claudeUptimeMs?.();
  }
  async recover() {
    return this.exclusive({ kind: "restore" }, async () => {
      const journal = await readObject(this.vault, "journal.json");
      if (!journal) return;
      await this.quitClaude();
      await this.restore(uuid.parse(journal.backup));
      await writeBytes(this.vault, "journal.json", null);
      this.lastError = undefined;
      await this.relaunch();
    }, true);
  }
  private async exclusive<T>(operation: Operation, fn: () => Promise<T>, recovery = false) {
    if (this.busy)
      throw new Error("A Desktop operation is already in progress.");
    // Acquire before any await; separate IPC calls must not both pass the guard.
    this.busy = true;
    this.started++;
    this.lastError = undefined;
    const current = { ...operation, restarted: false };
    this.operation = current;
    this.invalidate();
    let ok = false;
    let release: (() => void) | undefined;
    try {
      release = this.operationLock?.ensure(operation.kind);
      if (!(await this.host.available()))
        throw new Error("Claude Desktop was not found on this platform.");
      if (!recovery && (await readObject(this.vault, "journal.json")))
        throw new Error("Restore the interrupted Desktop switch first.");
      await this.refreshPending();
      const result = await fn();
      ok = true;
      return result;
    } catch (e: any) {
      if (!(e instanceof DesktopSwitchRefused) || e.message === SWITCH_CANCELLED)
        this.reportError(e.message);
      throw e;
    } finally {
      release?.();
      this.busy = false;
      this.invalidate();
      this.pendingHistorySeen = undefined;
      this.operation = undefined;
      if (current.restarted) this.report("end", current, ok);
    }
  }
  /** Quits Claude for the running operation, reporting the restart first. */
  private async quitClaude(answerQuitGuard?: () => Promise<boolean>) {
    const current = this.operation;
    if (current && !current.restarted) {
      current.restarted = true;
      this.report("start", current);
    }
    await this.settleSession();
    await this.host.quit(answerQuitGuard);
  }
  private report(phase: "start" | "end", operation: Operation, ok = false) {
    const base = {
      kind: operation.kind,
      ...(operation.profileId ? { profileId: operation.profileId } : {}),
    };
    try {
      this.onRestart?.(phase === "start" ? { phase, ...base } : { phase, ...base, ok });
    } catch {
      // A listener never changes how a Desktop operation ends.
    }
  }
  private assertProfileIdentity(
    account: Account,
    accountUuid: string,
    orgId: string,
  ) {
    if (
      account.auth?.accountUuid &&
      account.auth.accountUuid.toLowerCase() !== accountUuid.toLowerCase()
    )
      throw new Error(
        "This profile is connected to a different Claude account. Choose the matching Desktop account.",
      );
    if (
      account.auth?.orgId &&
      account.auth.orgId.toLowerCase() !== orgId.toLowerCase()
    )
      throw new Error(
        "This profile is connected to a different Claude organization. Choose its matching Code workspace.",
      );
  }
  private async assertCurrentSaved() {
    const current = identity(await readObject(this.root, "config.json"));
    if (
      current &&
      !this.store.state.accounts.some((a) => a.desktop?.accountUuid === current)
    )
      throw new Error("Save the current Desktop account before switching.");
  }
  private async restart(
    fn: () => Promise<void>,
    canProceed?: () => boolean,
    beforeQuit?: () => Promise<void>,
    answerQuitGuard?: () => Promise<boolean>,
  ) {
    // Check the live handoff guard immediately before asking Claude to quit.
    // File-write guards alone are too late to protect a newly started task.
    const refuse = () => new DesktopSwitchRefused(SWITCH_CANCELLED);
    if (canProceed && !canProceed()) throw refuse();
    await beforeQuit?.();
    if (canProceed && !canProceed()) throw refuse();
    await this.quitClaude(answerQuitGuard);
    try {
      await fn();
    } finally {
      if (!(await readObject(this.vault, "journal.json")))
        await this.relaunch();
    }
  }
  /**
   * Starts Claude after Relay quit it, and holds the operation until its claude.ai page boots.
   * A page that has not booted after PAGE_BOOT_MS while Claude still runs gets what the user
   * would do by hand: Claude is quit and started once more. A start without HTTP/3 that Claude
   * refuses (it exits before it logs its start, as it does for switches it will not run with) is
   * followed at once by a plain start, as from the Dock. A watch that cannot tell, or a quit
   * that fails, leaves Claude as it is; only a failed launch throws, as any launch does.
   */
  private async relaunch() {
    let quicOff = false;
    try {
      quicOff = this.launchChoice?.quicOff() === true;
    } catch {
      // Unknown: start as Claude starts by itself.
    }
    const first = await this.launchWatched(1, quicOff);
    if (first === "refused" && quicOff) {
      this.diagnose("claude-boot-refused", { attempt: 1, quicOff });
      await this.launchWatched(2, false);
      return;
    }
    if (first !== "stalled") return;
    try {
      await this.host.quit();
    } catch {
      this.diagnose("claude-boot-retry", { quit: false });
      return;
    }
    this.diagnose("claude-boot-retry", { quit: true });
    // The second start goes without HTTP/3, whose stalled transfers left pages grey on this
    // Mac while HTTP/2 loaded them; it is watched too, and there is never a third start.
    const second = await this.launchWatched(2, true);
    if (second === "loaded" && !quicOff)
      try {
        this.launchChoice?.learnQuicOff();
        this.diagnose("claude-quic-off", { learned: true });
      } catch {
        // Not kept: the next stuck start learns it again.
      }
  }
  /**
   * One launch, without HTTP/3 when `quicOff`; the watch then says how its page did. Undefined
   * when the watch cannot tell.
   */
  private async launchWatched(attempt: number, quicOff: boolean): Promise<PageOutcome | undefined> {
    const watch = await this.host.watchLaunch?.().catch(() => undefined);
    await this.host.launch(quicOff ? { quicOff: true } : undefined);
    if (!watch) return undefined;
    const begun = this.now();
    const outcome = await watch.wait(PAGE_BOOT_MS).catch(() => "unknown" as const);
    this.diagnose("claude-boot", { attempt, outcome, quicOff, waitedMs: this.now() - begun });
    return outcome;
  }
  /**
   * Puts `accountUuid`'s saved sign-in into a separate window's data folder `dir`, in place of
   * any other, so the window opens signed in. The window must not run yet.
   */
  async seedWindow(accountUuid: string, dir: string) {
    await this.windowOperation(async () => {
      const saved = await this.readLogin(accountUuid);
      const main = (await readObject(this.root, "config.json")) ?? {};
      const config = (await readObject(dir, "config.json")) ?? {};
      // The main Claude's language and theme, so the window looks like it.
      for (const key of WINDOW_CONFIG_KEYS) if (key in main) config[key] = main[key];
      for (const key of AUTH_KEYS) {
        delete config[key];
        if (key in saved.auth) config[key] = saved.auth[key];
      }
      await writeBytes(dir, "config.json", jsonBytes(config));
      for (const f of COOKIE_FILES) {
        const cookie = saved.cookies[f];
        await writeBytes(dir, f, cookie == null ? null : Buffer.from(cookie, "base64"));
      }
      // The user's MCP servers and preferences are the main Claude's.
      const preferences = await readBytes(this.root, DESKTOP_PREFERENCES);
      if (preferences) await writeBytes(dir, DESKTOP_PREFERENCES, preferences);
      // The account's own Code conversations, as the main Claude has them. Only its own: a
      // conversation of another account could then run in both Claudes at once.
      const account = this.store.state.accounts.find(
        (a) => a.desktop?.accountUuid.toLowerCase() === accountUuid.toLowerCase(),
      );
      if (account?.desktop) {
        const { writes } = await planHistoryDetailed(dir, account.desktop, [], {
          outside: [{ root: this.root, scope: account.desktop }],
        });
        for (const [relative, data] of writes) await writeBytes(dir, relative, data);
      }
    });
  }
  /**
   * Saves the sign-in a closed window left in `dir` back to the vault, so a token Claude renewed
   * there is the one the next switch uses. Only while it is still `accountUuid`'s: a window
   * signed out or into another account changes nothing. Whether it saved.
   */
  async sealWindow(accountUuid: string, dir: string): Promise<boolean> {
    return this.windowOperation(async () => {
      if (identity(await readObject(dir, "config.json")) !== accountUuid) return false;
      return (await this.saveCurrent(dir)) === accountUuid;
    });
  }
  /** A window's step, which never hides the error an earlier operation left to read. */
  private async windowOperation<T>(fn: () => Promise<T>): Promise<T> {
    const shown = this.lastError;
    try {
      return await this.exclusive({ kind: "window" }, fn);
    } finally {
      if (this.lastError === undefined) this.lastError = shown;
    }
  }
  private async liveCookieFiles(root = this.root) {
    const files: Record<string, Buffer | null> = {};
    for (const name of COOKIE_FILES)
      files[name] = await readBytes(root, name).catch(() => null);
    return files;
  }
  /**
   * While Claude runs signed in to an account whose session is not in the cookie file yet,
   * waits for it, up to `sessionSettleMs`. A Claude that signed itself out is not waited for:
   * its session is gone, not on its way. With `required`, a session still missing throws
   * before anything is quit or changed.
   */
  private async settleSession(required = false) {
    const absent = async () =>
      !!identity(await readObject(this.root, "config.json").catch(() => null)) &&
      (await this.sessionOf(await this.liveCookieFiles())) === "absent";
    if (!(await this.host.running().catch(() => false)) || !(await absent())) return;
    if (await this.host.signedOut?.().catch(() => undefined)) {
      if (required) throw new Error(CLAUDE_SIGNED_OUT);
      return;
    }
    const until = this.now() + this.sessionSettleMs;
    this.diagnose("sign-in-settle", { required });
    while (this.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, this.sessionPollMs));
      if (!(await absent())) return;
    }
    this.diagnose("sign-in-unsettled", { required });
    if (required) throw new SignInNotSettled();
  }
  /**
   * Saves the sign-in Claude holds into the vault and answers its account. A sign-in without
   * its session is never saved over one already kept: the kept one may still work, the new
   * one cannot. With `requireSession` (saving a sign-in the user just made) it throws instead.
   */
  private async saveCurrent(root = this.root, requireSession = false) {
    const config = await readObject(root, "config.json");
    const accountUuid = identity(config);
    if (!accountUuid) return;
    const auth: JsonObject = {};
    for (const key of AUTH_KEYS) if (key in config!) auth[key] = config![key];
    const files = await this.liveCookieFiles(root);
    const session = await this.sessionOf(files);
    if (session === "absent") {
      const kept = await this.readLogin(accountUuid).then(
        () => true,
        () => false,
      );
      this.diagnose("sign-in-without-session", { account: accountUuid.slice(0, 8), kept });
      if (requireSession) throw new Error(SIGN_IN_WITHOUT_SESSION);
      if (kept) return accountUuid;
    }
    const cookies: SavedLogin["cookies"] = {};
    for (const name of COOKIE_FILES) cookies[name] = files[name]?.toString("base64") ?? null;
    await writeBytes(
      this.vault,
      `accounts/${accountUuid}.bin`,
      this.host.seal(JSON.stringify({ accountUuid, auth, cookies })),
    );
    // Claude drops the cookies of a session claude.ai refuses, so one still here was accepted.
    if (session === "present") this.clearRejected(accountUuid);
    return accountUuid;
  }
  private clearRejected(accountUuid: string) {
    if (
      !this.store.state.accounts.some(
        (a) => a.desktop?.accountUuid === accountUuid && a.desktop.rejectedAt,
      )
    )
      return;
    this.store.update((s) => {
      for (const a of s.accounts)
        if (a.desktop?.accountUuid === accountUuid) delete a.desktop.rejectedAt;
    });
  }
  private markRejected(accountId: string, accountUuid: string, why: string): Account | undefined {
    const at = new Date(this.now()).toISOString();
    let marked: Account | undefined;
    this.store.update((s) => {
      const a = s.accounts.find((x) => x.id === accountId);
      if (a?.desktop?.accountUuid !== accountUuid) return;
      a.desktop.rejectedAt = at;
      marked = a;
    });
    if (!marked) return;
    this.diagnose("sign-in-rejected", { account: accountUuid.slice(0, 8), why });
    this.invalidate();
    try {
      this.onSignInRejected?.(marked);
    } catch {
      // A listener never changes what was found.
    }
    return marked;
  }
  /**
   * Signing out inside the Claude app ends that session at claude.ai, and with it the copy
   * Relay saved earlier: put back at a switch, Claude is refused and signs out again. Each
   * account Claude's log shows signing out after its copy was saved is marked, unless Claude is
   * signed in to it again now. Never throws; quiet while an operation runs.
   */
  async noteSignOuts(): Promise<void> {
    try {
      if (this.busy || this.pending || !this.host.signOuts) return;
      const outs = await this.host.signOuts();
      if (!outs.length) return;
      const live = identity(await readObject(this.root, "config.json").catch(() => null));
      for (const out of outs) {
        const account = this.store.state.accounts.find(
          (a) => a.desktop?.accountUuid.toLowerCase() === out.accountUuid,
        );
        if (!account?.desktop || account.desktop.rejectedAt) continue;
        if (live?.toLowerCase() === out.accountUuid) continue;
        const saved = await fs
          .stat(path.join(this.vault, "accounts", `${account.desktop.accountUuid}.bin`))
          .then(
            (st) => st.mtimeMs,
            () => undefined,
          );
        if (saved === undefined || saved >= out.at) continue;
        this.markRejected(account.id, account.desktop.accountUuid, "signed-out-in-claude");
      }
    } catch {
      // A log that cannot be read marks nothing.
    }
  }
  /**
   * claude.ai renews its session cookies each time a login is used, so a saved sign-in left
   * unused until they end opens signed out when a switch puts it back: the account asks to log
   * in again. Each account whose saved sign-in has ended (and that the Claude app is not on now)
   * is marked like one Claude refused, so the user is told before switching to it and automatic
   * switching skips it. At most every half hour; quiet while an operation runs. Never throws.
   */
  async noteEndedSignIns(): Promise<void> {
    try {
      if (this.busy || this.pending) return;
      const now = this.now();
      if (this.endedCheckedAt !== undefined && now - this.endedCheckedAt < 30 * 60_000) return;
      this.endedCheckedAt = now;
      const live = identity(await readObject(this.root, "config.json").catch(() => null));
      for (const account of this.store.state.accounts) {
        const desktop = account.desktop;
        if (!desktop || desktop.rejectedAt) continue;
        if (live?.toLowerCase() === desktop.accountUuid.toLowerCase()) continue;
        let saved: SavedLogin;
        try {
          saved = await this.readLogin(desktop.accountUuid);
        } catch {
          continue;
        }
        const files: Record<string, Buffer | null> = {};
        for (const [name, data] of Object.entries(saved.cookies))
          files[name] = typeof data === "string" ? Buffer.from(data, "base64") : null;
        const ends = await this.sessionEnds(files);
        if (ends !== undefined && ends <= now)
          this.markRejected(account.id, desktop.accountUuid, "saved-session-ended");
      }
    } catch {
      // The next look tries again.
    }
  }
  private verifySignInLater(target: Account) {
    if (this.signInVerifyTimer) clearTimeout(this.signInVerifyTimer);
    this.signInVerified = (async () => {
      let waited = 0;
      for (const at of this.signInVerifyMs) {
        await new Promise<void>((resolve) => {
          this.signInVerifyTimer = setTimeout(resolve, Math.max(0, at - waited));
          this.signInVerifyTimer.unref?.();
        });
        waited = at;
        if (await this.verifySignIn(target)) return;
      }
    })().catch(() => undefined);
  }
  /**
   * One look after a switch started Claude as `target`: when Claude signed itself out while it
   * still names the account, claude.ai refused the saved session. The account is marked, so no
   * unattended switch goes to it and the user is asked to sign in again. Answers whether the
   * look is final. Never throws.
   */
  private async verifySignIn(target: Account): Promise<boolean> {
    try {
      // Another operation since: what Claude holds is no longer this switch's.
      if (this.busy || this.pending || !target.desktop) return true;
      const out = await this.host.signedOut?.();
      if (out === undefined) return true;
      if (!out) return false;
      const live = identity(await readObject(this.root, "config.json").catch(() => null));
      if (live && live !== target.desktop.accountUuid) return true;
      this.markRejected(target.id, target.desktop.accountUuid, "refused-after-switch");
      return true;
    } catch {
      return true;
    }
  }
  /**
   * The cookie files of `accountUuid`'s Claude app sign-in, for a usage read: Claude's own while
   * it is signed in to that account (the newest), else the copy saved in the vault. Read only;
   * while an operation swaps files only the vault copy is used.
   */
  async loginCookieFiles(accountUuid: string): Promise<Record<string, Buffer | null>> {
    const read = async (root: string) => {
      const files: Record<string, Buffer | null> = {};
      for (const name of COOKIE_FILES) files[name] = await readBytes(root, name);
      return files;
    };
    const live = async () => identity(await readObject(this.root, "config.json").catch(() => null));
    if (!this.busy && (await live()) === accountUuid) {
      const files = await read(this.root);
      // Another account could have come in while the files were read.
      if (!this.busy && (await live()) === accountUuid) return files;
    }
    const saved = await this.readLogin(accountUuid);
    return Object.fromEntries(
      COOKIE_FILES.map((name) => {
        const data = saved.cookies[name];
        return [name, typeof data === "string" ? Buffer.from(data, "base64") : null];
      }),
    );
  }
  private async readLogin(accountUuid: string): Promise<SavedLogin> {
    const data = await readBytes(
      this.vault,
      `accounts/${uuid.parse(accountUuid)}.bin`,
    );
    if (!data)
      throw new Error(
        "Saved Desktop sign-in is missing. Connect this account again.",
      );
    const saved = JSON.parse(this.host.unseal(data)) as SavedLogin;
    if (
      identity(saved.auth) !== accountUuid ||
      saved.accountUuid !== accountUuid ||
      !saved.cookies ||
      typeof saved.cookies !== "object"
    )
      throw new Error("Invalid saved Desktop sign-in.");
    return saved;
  }
  private async apply(
    changes: Map<string, Buffer | null>,
    options: ApplyOptions = {},
  ) {
    const historySeen = this.pendingHistorySeen;
    this.pendingHistorySeen = undefined;
    if (!changes.size && !historySeen) return;
    const guard = async () => {
      if (options.canProceed && !options.canProceed())
        throw new Error(
          "Automatic Desktop switch was cancelled because its conditions changed.",
        );
      if (await this.host.running())
        throw new Error("Claude is still running. No files were changed.");
    };
    await guard();
    const id = randomUUID();
    const backup: Backup = { files: {}, createdAt: new Date().toISOString() };
    if (historySeen)
      backup.historySeen =
        (await readBytes(this.vault, "history-seen.json"))?.toString(
          "base64",
        ) ?? null;
    for (const relative of changes.keys())
      backup.files[relative] =
        (await readBytes(this.root, relative))?.toString("base64") ?? null;
    await writeBytes(
      this.vault,
      `backups/${id}.bin`,
      this.host.seal(JSON.stringify(backup)),
    );
    await writeBytes(this.vault, "journal.json", jsonBytes({ backup: id }));
    this.lastBackup = id;
    // The journal names the new backup, so it is kept; older ones beyond the newest 20 go.
    // Never throws: pruning never fails a switch.
    await pruneSwitchBackups(this.vault);
    try {
      for (const [relative, data] of changes) {
        await guard();
        await writeBytes(this.root, relative, data);
      }
      if (historySeen) {
        await guard();
        await writeBytes(this.vault, "history-seen.json", historySeen);
      }
      await guard();
      await writeBytes(this.vault, "journal.json", null);
    } catch (error) {
      // Claude may have been opened by the user during a closed-app transaction.
      // Keep the recoverable journal; neither continue writing nor roll back live data.
      if (await this.host.running())
        throw new Error(
          "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
        );
      await this.restore(id); // If restore fails, journal blocks subsequent writes and launches.
      await writeBytes(this.vault, "journal.json", null);
      throw error;
    }
  }
  private async restore(id: string) {
    const data = await readBytes(this.vault, `backups/${uuid.parse(id)}.bin`);
    if (!data) throw new Error("Desktop recovery backup is missing.");
    const backup: Backup = JSON.parse(this.host.unseal(data));
    if (!backup.files || typeof backup.files !== "object")
      throw new Error("Invalid Desktop backup.");
    if (
      backup.historySeen !== undefined &&
      backup.historySeen !== null &&
      typeof backup.historySeen !== "string"
    )
      throw new Error("Invalid recovery data.");
    for (const [relative, value] of Object.entries(backup.files)) {
      if (!(
        relative === "config.json" ||
        COOKIE_FILES.includes(relative) ||
        /^claude-code-sessions\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/local_[a-f0-9-]{36}\.json$/i.test(
          relative,
        ) ||
        /^local-agent-mode-sessions\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/spaces\.json$/i.test(
          relative,
        )
      ))
        throw new Error("Invalid recovery path.");
      if (value !== null && typeof value !== "string")
        throw new Error("Invalid recovery data.");
    }
    for (const [relative, value] of Object.entries(backup.files)) {
      if (await this.host.running())
        throw new Error(
          "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
        );
      await writeBytes(
        this.root,
        relative,
        value === null ? null : Buffer.from(value, "base64"),
      );
    }
    if (backup.historySeen !== undefined)
      await writeBytes(
        this.vault,
        "history-seen.json",
        backup.historySeen === null
          ? null
          : Buffer.from(backup.historySeen, "base64"),
      );
  }
}
