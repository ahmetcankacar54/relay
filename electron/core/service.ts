import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store";
import { AuthManager } from "./auth";
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
      authFlows: this.auth.list(),
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
      authFlows: this.auth.list(),
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
      throw new Error("Bu hesap bir Claude hesabı değil; kendi sağlayıcısıyla bağlanır.");
    if (
      this.runner
        .list()
        .some((r) => r.accountId === id && r.status === "running")
    )
      throw new Error("Bu hesapta çalışan oturumu önce durdur.");
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
      await this.executable(),
      this.store.profile(id),
      profileEnvironment(this.store.profile(id)),
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
    if (this.auth.active(account.id))
      throw new Error("Önce bu hesabın limit okuma girişini tamamla ya da iptal et.");
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now())
      throw new Error(
        "Bu hesap beklemede. Hesaplar ekranından beklemeyi kaldır veya başka hesap seç.",
      );
    const source = input.sessionKey
      ? this.session(input.sessionKey)
      : undefined;
    const cwd = source?.projectDir ?? input.cwd;
    if (!cwd || !path.isAbsolute(cwd) || !(await fs.stat(cwd)).isDirectory())
      throw new Error("Proje klasörü bulunamadı. Klasörü yeniden seç.");
    const actualCwd = await fs.realpath(cwd);
    if (
      this.runner
        .list()
        .some((r) => r.status === "running" && r.cwd === actualCwd)
    )
      throw new Error(
        "Bu projede çalışan oturumu önce Canlı çalışma sekmesinden durdur.",
      );
    if (input.desktop && !input.desktopConsent)
      throw new Error("Claude uygulamasında doğru hesabın açık olduğunu doğrula.");
    if (
      input.desktop &&
      !(await this.currentDiagnostics()).desktopSupported
    )
      throw new Error(
        "Claude uygulamasına aktarım bu platformda veya CLI sürümünde desteklenmiyor.",
      );
    if (
      input.desktop &&
      source &&
      source.accountId !== account.id &&
      source.accountId !== "imported"
    )
      throw new Error(
        "Önce Relay içinde seçilen hesapla devam et; ardından o oturumu Claude uygulamasına gönder.",
      );
    const auth = await this.checkAuth(account.id);
    if (!auth.auth?.loggedIn)
      throw new Error(auth.auth?.error || "Önce bu hesapla giriş yap.");
    const args: string[] = [];
    let sessionKey: string;
    if (source) {
      let resumeId = source.id;
      if (source.accountId !== account.id) {
        if (source.accountId === "imported") {
          if (!input.importConsent)
            throw new Error(
              "İçe aktarılan oturum için hedef hesap onayı gerekiyor.",
            );
        } else if (
          this.store.account(source.accountId).group !== account.group
        ) {
          throw new Error(
            "Bu hesaplar aynı paylaşım grubunda değil. Şirket oturumları yalnızca aynı gruptaki hesaplara aktarılabilir.",
          );
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
      throw new Error("Yalnızca çalışma oturumlarında hesap değiştirilebilir.");
    if (run.accountId === targetId) throw new Error("Oturum zaten bu hesapta.");
    const target = this.store.account(targetId);
    if (this.store.account(run.accountId).group !== target.group)
      throw new Error("Hesaplar aynı paylaşım grubunda olmalı.");
    if (target.cooldownUntil && Date.parse(target.cooldownUntil) > Date.now())
      throw new Error("Hedef hesap beklemede. Önce beklemeyi kaldır.");
    if (!(await this.checkAuth(targetId)).auth?.loggedIn)
      throw new Error("Hedef hesaba giriş yap. Mevcut çalışma durdurulmadı.");
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
      throw new Error("Bu hesapta çalışan oturumu önce durdur.");
    if (this.auth.active(id))
      throw new Error("Önce bu hesabın limit okuma girişini tamamla ya da iptal et.");
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
    if (!s) throw new Error("Oturum bulunamadı. Kataloğu yenile.");
    return s;
  }
  private async executable() {
    const result = await this.currentDiagnostics();
    if (!result.executable || result.error)
      throw new Error(result.error || "Claude Code bulunamadı.");
    return result.executable;
  }
}
