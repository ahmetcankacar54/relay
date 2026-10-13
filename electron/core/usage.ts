import type { Account, AccountUsage, UsageWindow } from "../../shared/types";
import { Store } from "./store";
import { UsageError, type UsageCredential } from "./usage-credentials";
import type { RefreshUsageCredential } from "./usage-refresh";

type Json = Record<string, any>;
export function parseUsage(
  value: unknown,
): Pick<AccountUsage, "fiveHour" | "sevenDay"> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError("unsupported");
  const root = value as Json;
  const parse = (v: unknown): UsageWindow | undefined => {
    if (v === undefined || v === null) return;
    if (typeof v !== "object" || Array.isArray(v))
      throw new UsageError("unsupported");
    const w = v as Json;
    if (w.utilization === null || w.utilization === undefined) return;
    if (
      typeof w.utilization !== "number" ||
      !Number.isFinite(w.utilization) ||
      w.utilization < 0 ||
      w.utilization > 100
    )
      throw new UsageError("unsupported");
    const resetsAt =
      w.resets_at == null
        ? undefined
        : typeof w.resets_at === "string" &&
            Number.isFinite(Date.parse(w.resets_at))
          ? new Date(w.resets_at).toISOString()
          : null;
    if (resetsAt === null) throw new UsageError("unsupported");
    return { usedPercent: w.utilization, resetsAt };
  };
  const fiveHour = parse(root.five_hour),
    sevenDay = parse(root.seven_day);
  if (!fiveHour && !sevenDay) throw new UsageError("unsupported");
  return { fiveHour, sevenDay };
}
export function retryTime(header: string | null, now: number) {
  const seconds = header && /^\d+(\.\d+)?$/.test(header) ? Number(header) : NaN;
  const date = header ? Date.parse(header) : NaN;
  return Math.max(
    now + 60_000,
    Number.isFinite(seconds)
      ? now + seconds * 1000
      : Number.isFinite(date)
        ? date
        : now + 300_000,
  );
}
export async function requestUsageJson(
  endpoint: "profile" | "usage",
  token: string,
): Promise<unknown> {
  const response = await fetch(
    `https://api.anthropic.com/api/oauth/${endpoint}`,
    {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) throw new UsageError("expired");
    if (response.status === 403) throw new UsageError("scope");
    if (response.status === 429)
      throw new UsageError(
        "rate-limited",
        retryTime(response.headers.get("retry-after"), Date.now()),
      );
    throw new UsageError("unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new UsageError("unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 262_144) throw new UsageError("unsupported");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function verifyIdentity(account: Account, value: unknown) {
  const v = value as Json | null;
  const email =
    v?.account?.email_address ?? v?.account?.emailAddress ?? v?.account?.email;
  const uuid = v?.account?.uuid ?? v?.account?.account_uuid;
  const org = v?.organization?.uuid ?? v?.organization?.organization_uuid;
  const emailMatches =
    !!account.auth?.email &&
    typeof email === "string" &&
    email.trim().toLowerCase() === account.auth.email.trim().toLowerCase();
  if (
    (account.auth?.accountUuid
      ? uuid !== account.auth.accountUuid
      : !emailMatches) ||
    (account.auth?.orgId && org !== account.auth.orgId) ||
    (account.desktop &&
      (uuid !== account.desktop.accountUuid || org !== account.desktop.orgId))
  )
    throw new UsageError("identity-mismatch");
}
function identityKey(a: Account) {
  return JSON.stringify([
    a.auth?.loggedIn,
    a.auth?.email?.trim().toLowerCase(),
    a.auth?.accountUuid,
    a.auth?.orgId,
    a.desktop?.accountUuid,
    a.desktop?.orgId,
  ]);
}
export class UsageManager {
  private identities = new Map<string, string>();
  private cache = new Map<string, AccountUsage>();
  private inflight = new Map<string, Promise<AccountUsage>>();
  private generations = new Map<string, number>();
  private nextAttempt = new Map<string, number>();
  private serverRetryUntil = new Map<string, number>();
  private failures = new Map<string, number>();
  private active = 0;
  private waiting: (() => void)[] = [];
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    private credentials: (
      profile: string,
      allowPrompt: boolean,
    ) => Promise<UsageCredential>,
    private request: typeof requestUsageJson = requestUsageJson,
    private now = Date.now,
    private onSample: (
      account: Account,
      usage: AccountUsage,
    ) => void = () => {},
    private refreshCredential?: RefreshUsageCredential,
    private refreshCredentialPending?: (account: Account) => boolean,
  ) {}
  invalidate(id: string) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    this.inflight.delete(id);
    this.cache.delete(id);
    this.identities.delete(id);
    this.failures.delete(id);
    // A confirmed login makes old auth/transient failures obsolete, but not a server's Retry-After.
    const retryAt = this.serverRetryUntil.get(id) ?? 0;
    if (retryAt > this.now()) {
      this.nextAttempt.set(id, retryAt);
      this.cache.set(id, {
        accountId: id,
        status: "error",
        stale: false,
        issue: "rate-limited",
        retryAt: new Date(retryAt).toISOString(),
      });
    } else {
      this.nextAttempt.delete(id);
      this.serverRetryUntil.delete(id);
    }
  }
  snapshot(): Record<string, AccountUsage> {
    return Object.fromEntries(
      this.store.state.accounts.map((a) => [a.id, this.view(a)]),
    );
  }
  private view(account: Account): AccountUsage {
    if (!account.auth?.loggedIn)
      return {
        accountId: account.id,
        status: "idle",
        stale: false,
        issue: "connect-cli",
      };
    if (
      this.identities.has(account.id) &&
      this.identities.get(account.id) !== identityKey(account)
    )
      return { accountId: account.id, status: "idle", stale: false };
    const u: AccountUsage = structuredClone(
      this.cache.get(account.id) ?? {
        accountId: account.id,
        status: "idle",
        stale: false,
      },
    );
    if (
      u.checkedAt &&
      (this.now() - Date.parse(u.checkedAt) >= 35 * 60_000 ||
        [u.fiveHour, u.sevenDay].some(
          (w) => w?.resetsAt && Date.parse(w.resetsAt) <= this.now(),
        ))
    )
      u.stale = true;
    return u;
  }
  start() {
    if (!this.timer) {
      this.tick();
      this.timer = setInterval(() => this.tick(), 30_000);
      this.timer.unref();
    }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  tick() {
    const minutes = this.store.state.settings.usageRefreshMinutes;
    if (!minutes) return;
    for (const a of this.store.state.accounts) {
      const cached = this.view(a);
      if (
        a.auth?.loggedIn &&
        (!cached?.checkedAt ||
          // Poll a little early: automation accepts data up to five minutes old
          // and this timer only ticks every 30 seconds.
          this.now() - Date.parse(cached.checkedAt) >=
            minutes * 60_000 - 45_000 ||
          this.view(a).stale) &&
        this.now() >= (this.nextAttempt.get(a.id) ?? 0)
      )
        void this.refresh(a.id);
    }
  }
  refreshAfterRequest(id: string): Promise<AccountUsage> {
    const previous = this.view(this.store.account(id));
    // A confirmed model request needs a new server read rather than the
    // success cache from its preflight. This never bypasses a failure backoff,
    // a server Retry-After, or an already-running read and never prompts.
    if (
      previous.status === "ready" &&
      !this.inflight.has(id) &&
      (this.serverRetryUntil.get(id) ?? 0) <= this.now()
    )
      this.nextAttempt.delete(id);
    return this.refresh(id, false);
  }
  refresh(id: string, allowPrompt = false): Promise<AccountUsage> {
    const account = this.store.account(id);
    const existing = this.inflight.get(id);
    if (existing) return existing;
    if (!account.auth?.loggedIn) return Promise.resolve(this.view(account));
    const previous = this.view(account);
    if (
      this.now() < (this.nextAttempt.get(id) ?? 0) &&
      !(
        allowPrompt &&
        this.now() >= (this.serverRetryUntil.get(id) ?? 0) &&
        (previous.connectionRenewalRequired === true ||
          ["keychain-locked", "renewal-required"].includes(
            previous.issue ?? "",
          ))
      )
    )
      return Promise.resolve(previous);
    this.nextAttempt.set(id, this.now() + 60_000);
    this.identities.set(id, identityKey(account));
    this.cache.set(id, { ...previous, status: "loading" });
    const generation = this.generations.get(id) ?? 0;
    const job = this.run(account, previous, allowPrompt, generation).finally(
      () => {
        // An earlier login's completion must not remove a newer read from deduplication.
        if (this.inflight.get(id) === job) this.inflight.delete(id);
      },
    );
    this.inflight.set(id, job);
    return job;
  }
  private async run(
    account: Account,
    previous: AccountUsage,
    allowPrompt: boolean,
    generation: number,
  ) {
    if (this.active >= 2)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    const current = () =>
      (this.generations.get(account.id) ?? 0) === generation;
    try {
      if (!current()) return this.view(this.store.account(account.id));
      let credential = await this.credentials(
        this.store.profile(account.id),
        allowPrompt,
      );
      if (!current()) return this.view(this.store.account(account.id));
      let refreshed = false;
      let renewalRequired = false;
      const pendingRefresh = this.refreshCredentialPending?.(account) ?? false;
      const renew = async (force: boolean) => {
        if (
          !this.refreshCredential ||
          (!credential.refreshToken && !pendingRefresh)
        )
          throw new UsageError("expired");
        refreshed = true;
        credential = await this.refreshCredential(
          account,
          credential,
          force,
          allowPrompt,
        );
      };
      if (!credential.scopes.includes("user:profile"))
        throw new UsageError("scope");
      if (
        this.refreshCredential &&
        (pendingRefresh ||
          (credential.refreshToken &&
            credential.expiresAt !== undefined &&
            credential.expiresAt <= this.now() + 5 * 60_000))
      ) {
        try {
          await renew(false);
        } catch (error) {
          // macOS background reads may keep using a verified, still-valid
          // access token without allowing the CLI to open a Keychain dialog.
          if (
            pendingRefresh ||
            !(error instanceof UsageError) ||
            error.issue !== "renewal-required" ||
            !Number.isFinite(credential.expiresAt) ||
            credential.expiresAt! <= this.now()
          )
            throw error;
          refreshed = false;
          renewalRequired = true;
        }
      }
      if (!current()) return this.view(this.store.account(account.id));
      if (
        credential.expiresAt !== undefined &&
        credential.expiresAt <= this.now()
      )
        throw new UsageError("expired");
      if (!credential.scopes.includes("user:profile"))
        throw new UsageError("scope");
      // Verify on every poll: a reconnect may have changed the account behind this isolated profile.
      let profile: unknown;
      try {
        profile = await this.request("profile", credential.accessToken);
      } catch (error) {
        if (
          !(error instanceof UsageError) ||
          error.issue !== "expired" ||
          refreshed
        )
          throw error;
        await renew(true);
        if (!current()) return this.view(this.store.account(account.id));
        if (
          credential.expiresAt !== undefined &&
          credential.expiresAt <= this.now()
        )
          throw new UsageError("expired");
        if (!credential.scopes.includes("user:profile"))
          throw new UsageError("scope");
        profile = await this.request("profile", credential.accessToken);
      }
      if (!current()) return this.view(this.store.account(account.id));
      verifyIdentity(account, profile);
      const rawLimits = await this.request("usage", credential.accessToken);
      if (!current()) return this.view(this.store.account(account.id));
      const limits = parseUsage(rawLimits);
      const latest = this.store.account(account.id);
      if (identityKey(latest) !== identityKey(account))
        throw new UsageError("identity-mismatch");
      this.failures.delete(account.id);
      this.serverRetryUntil.delete(account.id);
      this.cache.set(account.id, {
        accountId: account.id,
        status: "ready",
        stale: false,
        checkedAt: new Date(this.now()).toISOString(),
        ...(renewalRequired ? { connectionRenewalRequired: true } : {}),
        ...limits,
      });
      // History is optional: failed local persistence must not turn a verified
      // live quota response into an authentication/usage error.
      try {
        this.onSample(latest, structuredClone(this.cache.get(account.id)!));
      } catch {}
    } catch (e) {
      if (!current()) return this.view(this.store.account(account.id));
      const error = e instanceof UsageError ? e : new UsageError("unavailable");
      const failures = (this.failures.get(account.id) ?? 0) + 1;
      this.failures.set(account.id, failures);
      const retryAt =
        error.retryAt ??
        this.now() + Math.min(30, 2 ** Math.min(failures, 5)) * 60_000;
      if (error.issue === "rate-limited")
        this.serverRetryUntil.set(account.id, retryAt);
      this.nextAttempt.set(account.id, retryAt);
      const retained = [
        "identity-mismatch",
        "expired",
        "scope",
        "credentials-missing",
      ].includes(error.issue)
        ? { accountId: account.id }
        : previous;
      this.cache.set(account.id, {
        ...retained,
        status: "error",
        stale: !!("checkedAt" in retained && retained.checkedAt),
        issue: error.issue,
        retryAt: new Date(retryAt).toISOString(),
      });
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
    return this.view(this.store.account(account.id));
  }
}
