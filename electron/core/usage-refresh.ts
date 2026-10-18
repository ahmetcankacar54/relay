import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { Account } from "../../shared/types";
import { profileEnvironment } from "./environment";
import { readPrivateJson, writePrivateJson } from "./continuation-journal";
import { requestUsageJson, verifyIdentity } from "./usage";
import { UsageError, type UsageCredential } from "./usage-credentials";
import { ProfileLockBusyError } from "./profile-lock";

export const USAGE_REFRESH_BEFORE_MS = 5 * 60_000;
export type RefreshUsageCredential = (
  account: Account,
  credential: UsageCredential,
  force?: boolean,
  allowInteraction?: boolean,
) => Promise<UsageCredential>;

export function needsUsageCredentialRefresh(
  credential: UsageCredential,
  now = Date.now(),
) {
  return (
    credential.expiresAt !== undefined &&
    credential.expiresAt <= now + USAGE_REFRESH_BEFORE_MS
  );
}

export interface UsageRefreshCommand {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}
interface Dependencies {
  executable: () => Promise<string>;
  read: (profile: string, allowPrompt: boolean) => Promise<UsageCredential>;
  request?: typeof requestUsageJson;
  canProceed?: (
    account: Account,
    profile: string,
  ) => boolean | Promise<boolean>;
  run?: (command: UsageRefreshCommand) => Promise<void>;
  now?: () => number;
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /**
   * Takes the account's exclusive profile lock, shared with Relay's other processes, and
   * returns its release; it throws ProfileLockBusyError while another process holds it.
   */
  profileLock?: (accountId: string) => () => void;
}
interface Attempt {
  version: 1;
  id: string;
  accountUuid: string;
  orgId: string;
  generation: string;
  attemptedAt: number;
  scopes: string[];
  /** Exchanges tried for this unchanged credential pair. */
  attempts?: number;
}
/** An unconfirmed exchange is retried only after this delay, at most MAX times. */
export const USAGE_REFRESH_RETRY_MS = 30 * 60_000;
export const USAGE_REFRESH_MAX_ATTEMPTS = 3;
interface Owner {
  pid: number;
  token: string;
  official?: { dev: number; ino: number };
}
const pending = new Map<
  string,
  { accountId: string; identity: string; promise: Promise<UsageCredential> }
>();
const fingerprint = (credential: UsageCredential) =>
  createHash("sha256")
    .update(credential.accessToken)
    .update("\0")
    .update(credential.refreshToken ?? "")
    .digest("hex");
const identity = (account: Account) =>
  JSON.stringify([account.auth?.accountUuid, account.auth?.orgId]);
const fresh = (credential: UsageCredential, now: number) =>
  credential.expiresAt !== undefined &&
  Number.isFinite(credential.expiresAt) &&
  credential.expiresAt > now &&
  credential.scopes.includes("user:profile");

/** No terminal, model request, callback browser, renderer output or shell. */
async function runRefresh(command: UsageRefreshCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.env,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let failed = false;
    const timeout = setTimeout(() => {
      failed = true;
      child.kill("SIGKILL");
    }, command.timeoutMs);
    timeout.unref();
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failed || code !== 0) reject(new UsageError("expired"));
      else resolve();
    });
  });
}

/**
 * Supported CLI exchange: https://code.claude.com/docs/en/env-vars
 * CLAUDE_CODE_OAUTH_REFRESH_TOKEN + CLAUDE_CODE_OAUTH_SCOPES, auth login.
 * A failed/uncertain rotation is never repeated for the same credential pair.
 */
export class UsageCredentialRefresher {
  private now: () => number;
  constructor(private deps: Dependencies) {
    this.now = deps.now ?? Date.now;
  }
  get anyActive() {
    return pending.size > 0;
  }
  isRefreshing(accountIdOrProfile: string) {
    return [...pending.entries()].some(
      ([profile, job]) =>
        job.accountId === accountIdOrProfile || profile === accountIdOrProfile,
    );
  }
  hasPending(profile: string) {
    return fs.existsSync(path.join(profile, ".relay-usage-refresh.json"));
  }
  refresh(
    account: Account,
    profile: string,
    credential: UsageCredential,
    force = false,
    allowInteraction = false,
  ): Promise<UsageCredential> {
    if (!path.isAbsolute(profile))
      return Promise.reject(new UsageError("credentials-missing"));
    const key = path.resolve(profile);
    const existing = pending.get(key);
    if (existing) {
      if (existing.identity !== identity(account))
        return Promise.reject(new UsageError("identity-mismatch"));
      return existing.promise;
    }
    const job = this.run(
      account,
      key,
      credential,
      force,
      allowInteraction,
    ).finally(() => {
      if (pending.get(key)?.promise === job) pending.delete(key);
    });
    pending.set(key, {
      accountId: account.id,
      identity: identity(account),
      promise: job,
    });
    return job;
  }
  private async verified(account: Account, credential: UsageCredential) {
    if (!fresh(credential, this.now())) throw new UsageError("expired");
    verifyIdentity(
      account,
      await (this.deps.request ?? requestUsageJson)(
        "profile",
        credential.accessToken,
      ),
    );
    return credential;
  }
  private async allowed(account: Account, profile: string) {
    if (this.deps.canProceed && !(await this.deps.canProceed(account, profile)))
      throw new UsageError("unavailable");
  }
  private async run(
    account: Account,
    profile: string,
    supplied: UsageCredential,
    force: boolean,
    allowInteraction: boolean,
  ) {
    const homeDefault = path.resolve(os.homedir(), ".claude");
    const info = fs.lstatSync(profile);
    if (
      !path.isAbsolute(profile) ||
      profile === homeDefault ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      fs.realpathSync(profile) !== profile
    )
      throw new UsageError("credentials-missing");
    if (
      !account.auth?.loggedIn ||
      !account.auth.accountUuid ||
      !account.auth.orgId
    )
      throw new UsageError("identity-mismatch");
    if (
      account.desktop &&
      (account.desktop.accountUuid !== account.auth.accountUuid ||
        account.desktop.orgId !== account.auth.orgId)
    )
      throw new UsageError("identity-mismatch");
    await this.allowed(account, profile);
    let releaseProfile: (() => void) | undefined;
    try {
      releaseProfile = this.deps.profileLock?.(account.id);
    } catch (error) {
      if (error instanceof ProfileLockBusyError) throw new UsageError("unavailable");
      throw error;
    }
    try {
      return await this.locked(account, profile, supplied, force, allowInteraction);
    } finally {
      releaseProfile?.();
    }
  }
  private async locked(
    account: Account,
    profile: string,
    supplied: UsageCredential,
    force: boolean,
    allowInteraction: boolean,
  ) {
    return this.withProfileLock(profile, async () => {
      const file = path.join(profile, ".relay-usage-refresh.json");
      const current = await this.deps.read(profile, false);
      const generation = fingerprint(current);
      let attempt: Attempt | undefined;
      try {
        const saved = readPrivateJson(file) as Attempt;
        if (
          saved.version !== 1 ||
          typeof saved.id !== "string" ||
          typeof saved.accountUuid !== "string" ||
          typeof saved.orgId !== "string" ||
          !/^[a-f0-9]{64}$/.test(saved.generation) ||
          !Number.isFinite(saved.attemptedAt) ||
          !Array.isArray(saved.scopes) ||
          saved.scopes.some(
            (scope) =>
              typeof scope !== "string" ||
              !/^[A-Za-z0-9:._/-]{1,150}$/.test(scope),
          ) ||
          !saved.scopes.includes("user:profile") ||
          !saved.scopes.includes("user:inference")
        )
          throw new UsageError("expired");
        attempt = saved;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new UsageError("expired");
      }
      // A replacement saved by a prior CLI/browser login can reconcile an
      // uncertain attempt. Presence alone never clears the rotation barrier.
      let previousAttempts = 0;
      if (attempt?.generation === generation) {
        // Nothing new was saved. The old pair may already be consumed, in which
        // case another exchange simply fails; it cannot cost a saved login. Retry
        // after a delay (or when the user asks), then require browser reconnect.
        previousAttempts = attempt.attempts ?? 1;
        if (
          previousAttempts >= USAGE_REFRESH_MAX_ATTEMPTS ||
          (!allowInteraction &&
            this.now() - attempt.attemptedAt < USAGE_REFRESH_RETRY_MS)
        )
          throw new UsageError("expired");
        attempt = undefined;
        force = true;
      }
      if (attempt) {
        if (
          attempt.accountUuid !== account.auth!.accountUuid ||
          attempt.orgId !== account.auth!.orgId
        )
          throw new UsageError("identity-mismatch");
        if (attempt.scopes.some((scope) => !current.scopes.includes(scope)))
          throw new UsageError("scope");
        const verified = await this.verified(account, current);
        fs.unlinkSync(file);
        this.syncDirectory(profile);
        return verified;
      }
      if (
        fingerprint(supplied) !== generation ||
        (!force && !needsUsageCredentialRefresh(current, this.now()))
      ) {
        if (supplied.scopes.some((scope) => !current.scopes.includes(scope)))
          throw new UsageError("scope");
        return this.verified(account, current);
      }
      if (
        !current.refreshToken ||
        (current.refreshTokenExpiresAt !== undefined &&
          current.refreshTokenExpiresAt <= this.now()) ||
        !current.scopes.includes("user:profile") ||
        !current.scopes.includes("user:inference") ||
        current.scopes.some((scope) => !/^[A-Za-z0-9:._/-]{1,150}$/.test(scope))
      )
        throw new UsageError("expired");
      // The vendor CLI updates its own Keychain item through `/usr/bin/security`,
      // the item's trusted application, exactly as it does during normal use, so
      // a background renewal does not need a consent dialog.
      const executable = await this.deps.executable();
      if (!path.isAbsolute(executable)) throw new UsageError("unavailable");
      await this.allowed(account, profile);
      return this.withOfficialRefreshLock(profile, async (assertOwned) => {
        await this.allowed(account, profile);
        const lockedCurrent = await this.deps.read(profile, false);
        if (fingerprint(lockedCurrent) !== generation) {
          if (
            current.scopes.some(
              (scope) => !lockedCurrent.scopes.includes(scope),
            )
          )
            throw new UsageError("scope");
          return this.verified(account, lockedCurrent);
        }
        const env = profileEnvironment(profile, this.deps.environment);
        env.CLAUDE_CODE_OAUTH_REFRESH_TOKEN = current.refreshToken!;
        env.CLAUDE_CODE_OAUTH_SCOPES = current.scopes.join(" ");
        // In 2.1.296 auth subcommands initialize an unawaited refresh. This
        // child-only access source has no refresh token, suppressing that race;
        // auth login still explicitly exchanges and saves the supplied refresh.
        env.CLAUDE_CODE_OAUTH_TOKEN = current.accessToken;
        if (current.clientId)
          env.CLAUDE_CODE_OAUTH_CLIENT_ID = current.clientId;
        writePrivateJson(file, {
          version: 1,
          id: randomUUID(),
          accountUuid: account.auth!.accountUuid!,
          orgId: account.auth!.orgId!,
          generation,
          attemptedAt: this.now(),
          scopes: current.scopes,
          attempts: previousAttempts + 1,
        } satisfies Attempt);
        assertOwned();
        try {
          await (this.deps.run ?? runRefresh)({
            executable,
            args: [
              "--safe-mode",
              "--settings",
              '{"disableAllHooks":true}',
              "auth",
              "login",
              "--claudeai",
            ],
            cwd: profile,
            env,
            timeoutMs: this.deps.timeoutMs ?? 90_000,
          });
        } catch {
          // The authoritative saved credential below may positively reconcile
          // an error after exchange/save. Never execute a second command.
        }
        // Even a successful CLI exit is insufficient; only persisted fresh
        // replacement credentials plus server UUID/org proof complete it.
        const saved = await this.deps.read(profile, false);
        if (fingerprint(saved) === generation || !fresh(saved, this.now()))
          throw new UsageError("expired");
        if (current.scopes.some((scope) => !saved.scopes.includes(scope)))
          throw new UsageError("scope");
        const verified = await this.verified(account, saved);
        await this.allowed(account, profile);
        // A timeout can occur after an atomic save. That positive saved+server
        // receipt reconciles it without making a second exchange.
        assertOwned();
        fs.unlinkSync(file);
        this.syncDirectory(profile);
        return verified;
      });
    });
  }
  private syncDirectory(directory: string) {
    if (process.platform === "win32") return;
    const fd = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  private removeOwnedOfficial(profile: string, owner: Owner) {
    const file = path.join(profile, ".oauth_refresh.lock");
    try {
      const stat = fs.lstatSync(file);
      if (
        owner.official &&
        stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.dev === owner.official.dev &&
        stat.ino === owner.official.ino
      )
        fs.rmdirSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async withProfileLock<T>(
    profile: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const file = path.join(profile, ".relay-usage-refresh.lock");
    let fd: number | undefined;
    for (let count = 0; count < 2; count++) {
      try {
        fd = fs.openSync(file, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new UsageError("unavailable");
        const before = fs.lstatSync(file);
        const previous = readPrivateJson(file) as Owner;
        if (
          !Number.isSafeInteger(previous.pid) ||
          previous.pid <= 0 ||
          typeof previous.token !== "string"
        )
          throw new UsageError("expired");
        try {
          process.kill(previous.pid, 0);
          throw new UsageError("unavailable");
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH")
            throw new UsageError("unavailable");
        }
        const named = fs.lstatSync(file);
        const retained = readPrivateJson(file) as Owner;
        if (
          named.isSymbolicLink() ||
          named.dev !== before.dev ||
          named.ino !== before.ino ||
          retained.token !== previous.token ||
          retained.pid !== previous.pid
        )
          throw new UsageError("unavailable");
        fs.unlinkSync(file);
      }
    }
    if (fd === undefined) throw new UsageError("unavailable");
    const stat = fs.fstatSync(fd);
    const owner: Owner = { pid: process.pid, token: randomUUID() };
    try {
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
      this.syncDirectory(profile);
      return await action();
    } finally {
      fs.closeSync(fd);
      try {
        const named = fs.lstatSync(file);
        if (
          !named.isSymbolicLink() &&
          named.dev === stat.dev &&
          named.ino === stat.ino
        ) {
          fs.unlinkSync(file);
          this.syncDirectory(profile);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private async withOfficialRefreshLock<T>(
    profile: string,
    action: (assertOwned: () => void) => Promise<T>,
  ) {
    const directory = path.join(profile, ".oauth_refresh.lock");
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch {
      throw new UsageError("unavailable");
    }
    const stat = fs.lstatSync(directory);
    const ownerFile = path.join(profile, ".relay-usage-refresh.lock");
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const owner = readPrivateJson(ownerFile) as Owner;
      // Rewrite the existing inode: the live owner descriptor remains valid.
      const fd = fs.openSync(
        ownerFile,
        fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        fs.ftruncateSync(fd, 0);
        fs.writeFileSync(
          fd,
          JSON.stringify({
            ...owner,
            official: { dev: stat.dev, ino: stat.ino },
          }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.syncDirectory(profile);
      const touch = () => {
        try {
          const named = fs.lstatSync(directory);
          if (
            named.dev === stat.dev &&
            named.ino === stat.ino &&
            !named.isSymbolicLink()
          ) {
            const now = new Date();
            fs.utimesSync(directory, now, now);
          }
        } catch {}
      };
      timer = setInterval(touch, 5_000);
      timer.unref();
      const assertOwned = () => {
        const named = fs.lstatSync(directory);
        if (
          !named.isDirectory() ||
          named.isSymbolicLink() ||
          named.dev !== stat.dev ||
          named.ino !== stat.ino
        )
          throw new UsageError("expired");
      };
      const result = await action(assertOwned);
      assertOwned();
      return result;
    } finally {
      if (timer) clearInterval(timer);
      this.removeOwnedOfficial(profile, {
        pid: process.pid,
        token: "",
        official: { dev: stat.dev, ino: stat.ino },
      });
      this.syncDirectory(profile);
    }
  }
}
