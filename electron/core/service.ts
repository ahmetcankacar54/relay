import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store";
import { AuthManager, SignInBusyError, authPending, type BackgroundSignIn } from "./auth";
import { Runner } from "./runner";
import type { ProfileLockKind } from "./profile-lock";
import { readProfileAuth, signedOut } from "./profile-auth";
import { readProfileIdentity } from "./profile-identity";
import { removeAccount, type AccountRemoval } from "./account-removal";
import { diagnoseCli } from "./cli-diagnostics";
import { command, profileEnvironment } from "./environment";
import { readsUsage } from "../../shared/cli-version";
import {
  scanSessions,
  copyTranscript,
  readTranscript,
  type IndexedSession,
} from "./sessions";
import type {
  Account,
  AccountRemoved,
  AuthFlow,
  Diagnostics,
  LaunchRequest,
  Snapshot,
  TerminalEvent,
} from "../../shared/types";

export const launchSchema = z
  .object({
    accountId: z.uuid(),
    cwd: z.string().max(4096).optional(),
    sessionKey: z.string().max(100).optional(),
    importConsent: z.boolean().optional(),
    desktop: z.boolean().optional(),
    desktopConsent: z.boolean().optional(),
  })
  .strict();

function hasVerifiedStoredIdentity(account: Account): boolean {
  const auth = account.auth;
  if (
    !auth?.loggedIn ||
    auth.error ||
    !z.uuid().safeParse(auth.accountUuid).success ||
    !z.uuid().safeParse(auth.orgId).success
  )
    return false;
  return (
    !account.desktop ||
    (auth.accountUuid!.toLowerCase() ===
      account.desktop.accountUuid.toLowerCase() &&
      auth.orgId!.toLowerCase() === account.desktop.orgId.toLowerCase())
  );
}

/** A diagnosis that found a CLI recent enough to read limits; Relay keeps it for the process. */
const usableDiagnostics = (d: Diagnostics) =>
  !!d.executable && !d.error && !!d.version && readsUsage(d.version);

export class Service {
  readonly store: Store;
  readonly runner: Runner;
  readonly auth: AuthManager;
  /**
   * Set by the app: whether a usage sign-in that just finished belongs to the profile's Claude
   * app sign-in. Answers the reason it does not (the sign-in flow fails with it), or nothing.
   */
  signInFit?: (account: Account) => Promise<string | undefined>;
  /**
   * Sign-ins made for the terminal: `claude auth login` in a scratch folder per account, so the
   * sign-in the terminal holds is not touched. Relay keeps the result for the next switch.
   */
  readonly terminalAuth: AuthManager;
  /**
   * Set by the app: keeps the sign-in a finished terminal link left in `dir` for the account.
   * Answers true, or why it was not kept (the flow fails with it).
   */
  terminalLinkFit?: (accountId: string, dir: string) => Promise<true | string>;
  /** The scratch folder of an account's terminal link. */
  terminalLinkDir(id: string) {
    return path.join(this.store.root, "terminal-link", id);
  }
  /**
   * Starts a sign-in for the terminal with the account: the page opens in the browser, and the
   * approval there is all it needs. Asked again while its page waits, the page comes back.
   */
  async linkTerminal(id: string) {
    const account = this.store.account(id);
    if ((account.provider ?? "claude") !== "claude")
      throw new Error("This account is not a Claude account; it connects through its own provider.");
    if (!account.desktop && !(account.auth?.accountUuid && account.auth.orgId))
      throw new Error("Save the Claude app sign-in first.");
    const waiting = this.terminalAuth
      .list()
      .find((f) => f.accountId === id && f.status === "waiting" && f.browserReady);
    if (waiting) {
      await this.terminalAuth.reopen(id, waiting.id, "browser").catch(() => {});
      return waiting;
    }
    if (this.terminalAuth.active(id))
      return this.terminalAuth.list().find((f) => f.accountId === id)!;
    const dir = this.terminalLinkDir(id);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    return this.terminalAuth.start(id, await this.executable(), dir, profileEnvironment(dir));
  }
  private index = new Map<string, IndexedSession>();
  private diagnostics?: Diagnostics;
  private diagnosedAt = 0;
  /** How long an unusable diagnosis stands before a snapshot runs it again. */
  static readonly REDIAGNOSE_MS = 20_000;
  /** The clock of that throttle; tests replace it. */
  now: () => number = Date.now;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    root: string,
    emit: (event: TerminalEvent & { sequence?: number }) => void,
    readonly importedRoot = path.join(os.homedir(), ".claude"),
    emitAuth: (flow: AuthFlow) => void = () => {},
    openBrowser: (url: string) => Promise<void> = async () => {},
    /** Takes an account's profile lock, shared with Relay's other processes. */
    profileLock?: (accountId: string, kind: ProfileLockKind) => () => void,
  ) {
    this.store = new Store(root);
    this.runner = new Runner(
      emit,
      profileLock && ((id) => profileLock(id, "shared")),
    );
    this.auth = new AuthManager(
      async (id) => {
        // A startup/status request started before login must not decide its result.
        await this.authChecks.get(id);
        const account = await this.checkAuth(id);
        if (!account.auth?.loggedIn) return false;
        return (await this.signInFit?.(account)) ?? true;
      },
      emitAuth,
      openBrowser,
      undefined,
      profileLock && ((id) => profileLock(id, "exclusive")),
    );
    this.terminalAuth = new AuthManager(
      async (id) => {
        const dir = this.terminalLinkDir(id);
        try {
          return (
            (await this.terminalLinkFit?.(id, dir)) ??
            "Terminal sign-ins cannot be kept on this system."
          );
        } finally {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      },
      emitAuth,
      openBrowser,
    );
  }
  // Serialize operations whose checks and writes must be a single transaction.
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.catch(() => {});
    return result;
  }
  /**
   * The cached diagnosis. While it is unusable (no CLI, an error, or a CLI too old to read
   * limits) it runs again, at most once per REDIAGNOSE_MS, so a CLI installed or updated after
   * Relay started is noticed without a restart.
   */
  private async currentDiagnostics(): Promise<Diagnostics> {
    const cached = this.diagnostics;
    if (
      cached &&
      (usableDiagnostics(cached) ||
        this.now() - this.diagnosedAt < Service.REDIAGNOSE_MS)
    )
      return cached;
    return this.diagnose();
  }
  async diagnose(): Promise<Diagnostics> {
    this.diagnosedAt = this.now();
    return (this.diagnostics = await diagnoseCli(
      this.store.state.executable,
      this.store.root,
    ));
  }
  async panelSnapshot(): Promise<Snapshot> {
    return {
      settings: structuredClone(this.store.state.settings),
      usage: {},
      accounts: structuredClone(this.store.state.accounts),
      authFlows: this.auth.list().filter((f) => !f.background),
      terminalFlows: this.terminalAuth.list(),
      runs: this.runner.list(),
      sessions: [],
      diagnostics: await this.currentDiagnostics(),
      importEnabled: this.store.state.importEnabled,
      warnings: [],
    };
  }
  async snapshot(): Promise<Snapshot> {
    const diagnostics = await this.currentDiagnostics();
    const accounts = structuredClone(this.store.state.accounts);
    const sources = accounts.map((a) => ({
      root: this.store.profile(a.id),
      id: a.id,
    }));
    if (this.store.state.importEnabled)
      sources.push({ root: this.importedRoot, id: "imported" });
    const found = await Promise.all(
      sources.map((s) =>
        scanSessions(
          s.root,
          s.id,
          this.store.state.pinned,
          this.store.state.lineage,
        ),
      ),
    );
    this.index = new Map(
      found.flatMap((f) => f.sessions).map((s) => [s.key, s]),
    );
    const sessions = [...this.index.values()]
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .map(({ file, root, projectFolder, ...session }) => session);
    return {
      settings: structuredClone(this.store.state.settings),
      usage: {},
      accounts,
      authFlows: this.auth.list().filter((f) => !f.background),
      terminalFlows: this.terminalAuth.list(),
      sessions,
      runs: this.runner.list(),
      diagnostics,
      importEnabled: this.store.state.importEnabled,
      warnings: [...new Set(found.flatMap((f) => f.warnings))],
    };
  }
  private authChecks = new Map<string, Promise<Account>>();
  checkAuth(id: string): Promise<Account> {
    const existing = this.authChecks.get(id);
    if (existing) return existing;
    const result = this.readAuth(id).finally(() => this.authChecks.delete(id));
    this.authChecks.set(id, result);
    return result;
  }
  private async readAuth(id: string): Promise<Account> {
    const account = this.store.account(id);
    // Only a Claude profile has a Claude Code sign-in to ask about; another provider's
    // sign-in is set when it is connected, and the Claude CLI would only call it signed out.
    if ((account.provider ?? "claude") !== "claude") return account;
    let auth: NonNullable<Account["auth"]>;
    try {
      auth = await readProfileAuth(
        await this.executable(),
        this.store.profile(id),
        account.auth,
      );
    } catch {
      auth = signedOut(account.auth);
    }
    this.store.update((s) => {
      const stored = s.accounts.find((a) => a.id === id)!;
      stored.auth = auth;
      // The plan comes from the sign-in, not a choice: a read plan replaces the saved one and
      // keeps the relative capacity set for a Team seat.
      if (auth.loggedIn && auth.plan && stored.planning?.plan !== auth.plan)
        stored.planning = { plan: auth.plan, capacityWeight: stored.planning?.capacityWeight ?? 1 };
    });
    return this.store.account(id);
  }
  async login(id: string) {
    // The Claude Code sign-in is a Claude account's: a Codex or Antigravity account signs in
    // with its own provider, never through Claude's.
    if ((this.store.account(id).provider ?? "claude") !== "claude")
      throw new Error("This account is not a Claude account; it connects through its own provider.");
    if (
      this.runner
        .list()
        .some((r) => r.accountId === id && r.status === "running")
    )
      throw new Error("Stop the running session for this account first.");
    // Resolved before anything is looked at: nothing may change between the checks and the start.
    const executable = await this.executable();
    // A renewal Relay runs by itself in the background gives way to the user's own sign-in.
    await this.cancelBackgroundSignIn(id);
    // Asked again while its page waits for approval: the page comes back, where the user
    // last had it. Starting returns the same attempt, which alone shows nothing new.
    const waiting = this.auth
      .list()
      .find((f) => f.accountId === id && f.status === "waiting" && f.browserReady);
    if (waiting) {
      await this.auth
        .reopen(id, waiting.id, waiting.inWindow ? "window" : "browser")
        .catch(() => {});
      return waiting;
    }
    return this.auth.start(
      id,
      executable,
      this.store.profile(id),
      profileEnvironment(this.store.profile(id)),
    );
  }
  /** Stops a renewal Relay runs by itself on this account, if one runs: the user's action wins. */
  private async cancelBackgroundSignIn(id: string) {
    const quiet = this.auth.list().find((f) => f.accountId === id && f.background && authPending(f));
    if (quiet) await this.auth.cancel(id, quiet.id).catch(() => {});
  }
  /**
   * Starts a Claude Code sign-in Relay runs by itself: the CLI's page goes to `background`, a
   * hidden window holding the account's claude.ai session, never to the user's browser. Refused
   * while the account is in use or already signing in.
   */
  async loginInBackground(id: string, background: BackgroundSignIn) {
    const account = this.store.account(id);
    if ((account.provider ?? "claude") !== "claude" || !account.auth?.loggedIn)
      throw new Error("not a signed-in Claude account");
    // Resolved first: the checks below and the start run with no wait between them, so a sign-in
    // the user starts meanwhile is seen (and `start` refuses to hand back another's flow).
    const executable = await this.executable();
    if (this.auth.active(id)) throw new SignInBusyError("a sign-in is already running");
    if (this.runner.list().some((r) => r.accountId === id && r.status === "running"))
      throw new SignInBusyError("a session runs on this account");
    return this.auth.start(
      id,
      executable,
      this.store.profile(id),
      profileEnvironment(this.store.profile(id)),
      background,
    );
  }
  /**
   * Fills each signed-in Claude account's plan from the sign-in metadata Claude Code saved in its
   * profile. Only that file is read (no CLI, no Keychain), and only for the sign-in it matches.
   */
  async syncDetectedPlans() {
    for (const account of this.store.state.accounts) {
      if ((account.provider ?? "claude") !== "claude" || !account.auth?.loggedIn) continue;
      const metadata = await readProfileIdentity(this.store.profile(account.id));
      const auth = account.auth;
      if (
        !metadata?.plan ||
        !auth.email ||
        metadata.email.toLowerCase() !== auth.email.toLowerCase() ||
        !auth.orgId ||
        metadata.orgId !== auth.orgId
      )
        continue;
      const plan = metadata.plan;
      this.store.update((state) => {
        const stored = state.accounts.find((a) => a.id === account.id);
        if (!stored?.auth?.loggedIn || stored.auth.email !== auth.email || stored.auth.orgId !== auth.orgId) return;
        stored.auth.plan = plan;
        if (stored.planning?.plan !== plan)
          stored.planning = { plan, capacityWeight: stored.planning?.capacityWeight ?? 1 };
      });
    }
  }
  async reconcileAuth(platform = process.platform) {
    await this.syncDetectedPlans().catch(() => {});
    // Official CLI status can prompt for legacy Keychain access and initialize
    // an OAuth rotation. Startup is never an interactive authentication action.
    if (platform === "darwin") return;
    const ids = this.store.state.accounts
      .filter((a) => (a.provider ?? "claude") === "claude")
      .map((a) => a.id);
    await Promise.all(
      Array.from({ length: Math.min(3, ids.length) }, async () => {
        for (let id; (id = ids.shift());) {
          // CLI status may rotate OAuth credentials before exiting. Keep an
          // enrolled identity across restarts instead of launching that command
          // just to rediscover it. This is not live quota verification: usage
          // checks independently corroborate the current profile and account.
          if (
            !this.auth.active(id) &&
            !hasVerifiedStoredIdentity(this.store.account(id))
          )
            await this.checkAuth(id).catch(() => {});
        }
      }),
    );
  }
  async launch(raw: LaunchRequest) {
    const input = launchSchema.parse(raw);
    const account = this.store.account(input.accountId);
    // A renewal the user cannot see never blocks what they do.
    await this.cancelBackgroundSignIn(account.id);
    if (this.auth.active(account.id))
      throw new Error("Finish or cancel this account’s usage sign-in first.");
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now())
      throw new Error("This account is on hold. Remove the hold on Accounts, or select another account.");
    const source = input.sessionKey
      ? this.session(input.sessionKey)
      : undefined;
    const cwd = source?.projectDir ?? input.cwd;
    if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory())
      throw new Error("Relay cannot find the project folder. Select it again.");
    const actualCwd = await fs.realpath(cwd);
    if (
      this.runner
        .list()
        .some((r) => r.status === "running" && r.cwd === actualCwd)
    )
      throw new Error("Stop this project’s running session on the Live tab first.");
    if (input.desktop && !input.desktopConsent)
      throw new Error("Check that the right account is open in the Claude app.");
    if (
      input.desktop &&
      !(await this.currentDiagnostics()).desktopSupported
    )
      throw new Error("Sending to the Claude app is not supported on this platform or CLI version.");
    if (
      input.desktop &&
      source &&
      source.accountId !== account.id &&
      source.accountId !== "imported"
    )
      throw new Error("Continue with the chosen account in Relay first, then send that session to the Claude app.");
    const auth = await this.checkAuth(account.id);
    if (!auth.auth?.loggedIn)
      throw new Error(auth.auth?.error || "Sign in with this account first.");
    const args: string[] = [];
    let sessionKey: string;
    if (source) {
      let resumeId = source.id;
      if (source.accountId !== account.id) {
        if (source.accountId === "imported") {
          if (!input.importConsent)
            throw new Error("An imported session needs the target account confirmed.");
        } else if (
          this.store.account(source.accountId).group !== account.group
        ) {
          throw new Error("These accounts are not in the same sharing group. Work sessions can move only to accounts in the same group.");
        }
        resumeId = await copyTranscript(source, this.store.profile(account.id));
        const copiedKey = `${account.id}:${resumeId}`;
        this.store.update((s) => {
          s.lineage[copiedKey] = source.key;
        });
        // Fresh branch per handoff, preserving both accounts' previous history.
        sessionKey = copiedKey;
      } else sessionKey = source.key;
      args.push("--resume", resumeId);
    } else {
      const id = randomUUID();
      sessionKey = `${account.id}:${id}`;
      if (!input.desktop) args.push("--session-id", id);
    }
    if (input.desktop) args.unshift("--desktop");
    return this.runner.start(
      await this.executable(),
      args,
      profileEnvironment(this.store.profile(account.id)),
      {
        accountId: account.id,
        cwd: actualCwd,
        kind: input.desktop ? "desktop" : "session",
        title: source?.title ?? path.basename(actualCwd),
        sessionKey,
      },
    );
  }
  async transcript(key: string) {
    return readTranscript(this.session(key));
  }
  async switchAccount(runId: string, targetId: string) {
    const run = this.runner.list().find((r) => r.id === runId);
    if (!run || run.kind !== "session" || !run.sessionKey)
      throw new Error("Only work sessions can change accounts.");
    if (run.accountId === targetId) throw new Error("Oturum zaten bu hesapta.");
    const target = this.store.account(targetId);
    if (this.store.account(run.accountId).group !== target.group)
      throw new Error("The accounts must be in the same sharing group.");
    if (target.cooldownUntil && Date.parse(target.cooldownUntil) > Date.now())
      throw new Error("The target account is on hold. Remove the hold first.");
    if (!(await this.checkAuth(targetId)).auth?.loggedIn)
      throw new Error("Sign in to the target account. The current work was not stopped.");
    await this.snapshot();
    this.session(run.sessionKey); // Do not stop an unsaved/new terminal.
    await this.runner.stop(runId);
    await this.snapshot(); // Read final persisted transcript only after process exit.
    return this.launch({ accountId: targetId, sessionKey: run.sessionKey });
  }
  pin(key: string, pinned: boolean) {
    this.session(key);
    this.store.update((s) => {
      s.pinned = s.pinned.filter((k) => k !== key);
      if (pinned) s.pinned.push(key);
    });
  }
  /**
   * Forgets an account (`removeAccount`, shared with `relay remove`): refused while one of its
   * terminals runs or its usage sign-in is in progress; its usage sign-in is signed out with the
   * CLI in its profile when one is found.
   */
  async remove(
    id: string,
    options: Omit<AccountRemoval, "store" | "signOut">,
  ): Promise<AccountRemoved> {
    this.store.account(id);
    if (
      this.runner
        .list()
        .some((r) => r.accountId === id && r.status === "running")
    )
      throw new Error("Stop the running session for this account first.");
    await this.cancelBackgroundSignIn(id);
    if (this.auth.active(id))
      throw new Error("Finish or cancel this account’s usage sign-in first.");
    const executable = await this.executable().catch(() => undefined);
    return removeAccount(id, {
      ...options,
      store: this.store,
      signOut: executable
        ? async (profile) => {
            await command(executable, ["auth", "logout"], profileEnvironment(profile), profile);
            return true;
          }
        : undefined,
    });
  }
  cooldown(id: string, hours: number) {
    this.store.account(id);
    this.store.update((s) => {
      s.accounts.find((a) => a.id === id)!.cooldownUntil = hours
        ? new Date(Date.now() + hours * 3600_000).toISOString()
        : undefined;
    });
  }
  private session(key: string) {
    const s = this.index.get(key);
    if (!s) throw new Error("Session not found. Refresh the catalog.");
    return s;
  }
  private async executable() {
    const result = await this.currentDiagnostics();
    if (!result.executable || result.error)
      throw new Error(
        result.error ||
          "Claude Code was not found. Open Code once in the Claude app (it downloads Claude Code itself) or pick it in Settings → Advanced → Claude Code CLI → Choose file.",
      );
    return result.executable;
  }
}
