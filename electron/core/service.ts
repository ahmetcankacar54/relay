import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Store } from "./store";
import { AuthManager } from "./auth";
import { Runner } from "./runner";
import { authStatus, readProfileIdentity } from "./profile-identity";
import {
  command,
  profileEnvironment,
  resolveExecutable,
  supportsDesktop,
} from "./environment";
import {
  scanSessions,
  copyTranscript,
  readTranscript,
  type IndexedSession,
} from "./sessions";
import type {
  Account,
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

export class Service {
  readonly store: Store;
  readonly runner: Runner;
  readonly auth: AuthManager;
  private index = new Map<string, IndexedSession>();
  private diagnostics?: Diagnostics;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    root: string,
    emit: (event: TerminalEvent & { sequence?: number }) => void,
    readonly importedRoot = path.join(os.homedir(), ".claude"),
    emitAuth: (flow: AuthFlow) => void = () => {},
    openBrowser: (url: string) => Promise<void> = async () => {},
  ) {
    this.store = new Store(root);
    this.runner = new Runner(emit);
    this.auth = new AuthManager(
      async (id) => {
        // A startup/status request started before login must not decide its result.
        await this.authChecks.get(id);
        return !!(await this.checkAuth(id)).auth?.loggedIn;
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
  async diagnose(): Promise<Diagnostics> {
    const executable = resolveExecutable(this.store.state.executable);
    const base = {
      executable,
      platform: process.platform,
      dataDir: this.store.root,
      desktopSupported: false,
    };
    if (!executable)
      return (this.diagnostics = {
        ...base,
        error:
          "Claude Code bulunamadı. Resmi native CLI kurulumunu yap veya çalıştırılabilir dosyayı seç.",
      });
    try {
      const { stdout } = await command(
        executable,
        ["--version"],
        profileEnvironment(path.join(this.store.root, "diagnostic")),
        this.store.root,
      );
      const version = stdout.trim().slice(0, 150);
      return (this.diagnostics = {
        ...base,
        version,
        desktopSupported: supportsDesktop(version),
      });
    } catch {
      return (this.diagnostics = {
        ...base,
        error:
          "Claude Code sürümü okunamadı. Çalıştırılabilir dosyayı kontrol et.",
      });
    }
  }
  async panelSnapshot(): Promise<Snapshot> {
    return {
      settings: structuredClone(this.store.state.settings),
      usage: {},
      accounts: structuredClone(this.store.state.accounts),
      authFlows: this.auth.list(),
      runs: this.runner.list(),
      sessions: [],
      diagnostics: this.diagnostics ?? (await this.diagnose()),
      importEnabled: this.store.state.importEnabled,
      warnings: [],
    };
  }
  async snapshot(): Promise<Snapshot> {
    const diagnostics = this.diagnostics ?? (await this.diagnose());
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
    let auth: NonNullable<Account["auth"]>;
    try {
      const executable = await this.executable();
      let stdout: string;
      try {
        stdout = (
          await command(
            executable,
            ["auth", "status", "--json"],
            profileEnvironment(this.store.profile(id)),
            this.store.profile(id),
          )
        ).stdout;
      } catch (e: any) {
        if (typeof e.stdout !== "string" || !e.stdout.trim()) throw e;
        stdout = e.stdout;
      }
      auth = authStatus(
        JSON.parse(stdout),
        account.auth,
        await readProfileIdentity(this.store.profile(id)),
        new Date().toISOString(),
      );
    } catch {
      auth = {
        ...account.auth,
        loggedIn: false,
        checkedAt: new Date().toISOString(),
        error: "Giriş durumu doğrulanamadı. Hesabı yeniden bağla.",
      };
    }
    this.store.update((s) => {
      s.accounts.find((a) => a.id === id)!.auth = auth;
    });
    return this.store.account(id);
  }
  async login(id: string) {
    this.store.account(id);
    if (
      this.runner
        .list()
        .some((r) => r.accountId === id && r.status === "running")
    )
      throw new Error("Bu hesapta çalışan oturumu önce durdur.");
    return this.auth.start(
      id,
      await this.executable(),
      this.store.profile(id),
      profileEnvironment(this.store.profile(id)),
    );
  }
  async reconcileAuth(platform = process.platform) {
    // Official CLI status can prompt for legacy Keychain access and initialize
    // an OAuth rotation. Startup is never an interactive authentication action.
    if (platform === "darwin") return;
    const ids = this.store.state.accounts.map((a) => a.id);
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
      throw new Error("Önce bu hesabın giriş işlemini tamamla veya iptal et.");
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
      throw new Error("Desktop’ta doğru hesabın açık olduğunu doğrula.");
    if (
      input.desktop &&
      !(this.diagnostics ?? (await this.diagnose())).desktopSupported
    )
      throw new Error(
        "Desktop aktarımı bu platform veya CLI sürümünde desteklenmiyor.",
      );
    if (
      input.desktop &&
      source &&
      source.accountId !== account.id &&
      source.accountId !== "imported"
    )
      throw new Error(
        "Önce Relay içinde seçilen hesapla devam et; ardından o oturumu Desktop’a gönder.",
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
    const result = this.diagnostics ?? (await this.diagnose());
    if (!result.executable || result.error)
      throw new Error(result.error || "Claude Code bulunamadı.");
    return result.executable;
  }
}
