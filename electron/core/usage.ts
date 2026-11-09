import type {
  Account,
  AccountUsage,
  UsageIssue,
  UsageWindow,
} from "../../shared/types";
import { Store } from "./store";
import { UsageError, type UsageCredential } from "./usage-credentials";
import type { RefreshUsageCredential } from "./usage-refresh";

type Json = Record<string, any>;
export function parseUsage(
  value: unknown,
): Pick<
  AccountUsage,
  "fiveHour" | "sevenDay" | "otherLimitReached" | "modelWindows"
> {
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
  // Model-specific windows such as `seven_day_opus` stop work on that model.
  const otherLimitReached = Object.entries(root).some(
    ([key, window]) =>
      /^(?:five_hour|seven_day)_[a-z0-9_]+$/.test(key) &&
      typeof (window as Json | null)?.utilization === "number" &&
      (window as Json).utilization >= 100,
  );
  const modelWindows = Object.entries(root)
    .filter(([key]) => /^(?:five_hour|seven_day)_[a-z0-9_]+$/.test(key))
    .flatMap(([key, raw]) => {
      let window: UsageWindow | undefined;
      try {
        window = parse(raw);
      } catch {
        return []; // A malformed model window must not fail the whole read.
      }
      if (!window) return [];
      const label = key
        .replace(/^(?:five_hour|seven_day)_/, "")
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      return [
        {
          key,
          label,
          usedPercent: window.usedPercent,
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        },
      ];
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    fiveHour,
    sevenDay,
    ...(modelWindows.length ? { modelWindows } : {}),
    ...(otherLimitReached ? { otherLimitReached } : {}),
  };
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
/** The error type and message of a refused response, from at most 4 KiB of its body. */
async function errorBody(response: Response): Promise<{ type?: string; message?: string }> {
  try {
    const text = (await response.text()).slice(0, 4_096);
    const error = JSON.parse(text)?.error;
    return {
      ...(typeof error?.type === "string" && /^[a-z_]{1,64}$/.test(error.type)
        ? { type: error.type }
        : {}),
      ...(typeof error?.message === "string" ? { message: error.message.slice(0, 300) } : {}),
    };
  } catch {
    return {};
  }
}
/** A 403 that says the token lacks a scope: Anthropic's permission_error naming a scope. */
export function scopeRefusal(error: { type?: string; message?: string }): boolean {
  return error.type === "permission_error" && /scope/i.test(error.message ?? "");
}
/** What a request that never got an answer says: no network, a timeout, a refused connection. */
export function networkDetail(error: unknown): string {
  const e = error as { name?: string; message?: string; cause?: { code?: string } } | undefined;
  const code = typeof e?.cause?.code === "string" ? ` ${e.cause.code}` : "";
  return `no answer: ${e?.name ?? "Error"}${code}`.slice(0, 120);
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
    const error = await errorBody(response);
    const detail = `${endpoint} ${response.status}${error.type ? ` ${error.type}` : ""}`;
    if (response.status === 401) throw new UsageError("expired", undefined, detail);
    // Only a refusal for the token's scopes asks for a new sign-in. Any other 403 (a gateway
    // or a passing refusal, seen while the saved sign-in had every scope) passes on its own.
    if (response.status === 403)
      throw scopeRefusal(error)
        ? new UsageError("scope", undefined, detail)
        : new UsageError("unavailable", undefined, detail);
    if (response.status === 429)
      throw new UsageError(
        "rate-limited",
        retryTime(response.headers.get("retry-after"), Date.now()),
        detail,
      );
    throw new UsageError("unavailable", undefined, detail);
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
/**
 * Identity fields a verified profile response can supply when the registry lacks
 * them (for example after an older Relay rewrote it with its own schema). Only
 * missing fields are returned, and only when the response matches the account's
 * saved Desktop binding, so a verified read never changes an existing identity.
 */
export function missingIdentity(account: Account, value: unknown) {
  const v = value as Json | null;
  const uuid = v?.account?.uuid ?? v?.account?.account_uuid;
  const org = v?.organization?.uuid ?? v?.organization?.organization_uuid;
  const orgName = v?.organization?.name;
  const email =
    v?.account?.email_address ?? v?.account?.emailAddress ?? v?.account?.email;
  if (
    !account.auth?.loggedIn ||
    !account.desktop ||
    typeof uuid !== "string" ||
    typeof org !== "string" ||
    uuid.toLowerCase() !== account.desktop.accountUuid.toLowerCase() ||
    org.toLowerCase() !== account.desktop.orgId.toLowerCase()
  )
    return;
  const repair: {
    accountUuid?: string;
    orgId?: string;
    orgName?: string;
    desktopEmail?: string;
  } = {};
  if (!account.auth.accountUuid) repair.accountUuid = uuid.toLowerCase();
  if (!account.auth.orgId) repair.orgId = org.toLowerCase();
  if (
    !account.auth.orgName &&
    typeof orgName === "string" &&
    orgName.trim() &&
    orgName.trim().length <= 150
  )
    repair.orgName = orgName.trim();
  if (
    !account.desktop.email &&
    typeof email === "string" &&
    email.trim() &&
    email.trim().length <= 254 &&
    email.trim().toLowerCase() === account.auth.email?.trim().toLowerCase()
  )
    repair.desktopEmail = email.trim();
  return Object.keys(repair).length ? repair : undefined;
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
    /** Told once each time an account's issue changes; never given a credential. */
    private onIssue?: (account: Account, issue: UsageIssue, detail?: string) => void,
    /**
     * The second source: the account's Claude app sign-in, for an account without a Claude Code
     * sign-in. Answers with the usage endpoint's shape. Undefined where it cannot be read.
     */
    private desktopUsage?: {
      usable: (account: Account) => boolean;
      read: (account: Account, allowPrompt: boolean) => Promise<unknown>;
    },
  ) {}
  /** Which sign-in a read of this account goes through; undefined when it has none. */
  private source(account: Account): AccountUsage["source"] {
    if (account.auth?.loggedIn) return "cli";
    if (this.desktopUsage?.usable(account)) return "desktop";
  }
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
  /**
   * Drops everything kept for a removed account. A read still running is ignored when it ends,
   * and its failure to find the account is nobody's to report.
   */
  forget(id: string) {
    this.inflight.get(id)?.catch(() => {});
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    for (const map of [
      this.inflight,
      this.cache,
      this.identities,
      this.nextAttempt,
      this.serverRetryUntil,
      this.failures,
    ])
      map.delete(id);
  }
  snapshot(): Record<string, AccountUsage> {
    return Object.fromEntries(
      this.store.state.accounts.map((a) => [a.id, this.view(a)]),
    );
  }
  private view(account: Account): AccountUsage {
    if (!this.source(account))
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
    // The source this account is read through, also before its first read.
    u.source ??= this.source(account);
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
        this.source(a) &&
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
    if (!this.source(account)) return Promise.resolve(this.view(account));
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
      // Before any Claude sign-in is read: a Codex or Antigravity profile has none, and a read
      // that fails on it would report "signed out" and offer a Claude sign-in for it.
      if (account.provider && account.provider !== "claude") {
        // Neither the OpenAI API nor Gemini API supplies Claude-style five-hour
        // and seven-day quota windows. An invented 0% usage reading misleads
        // routing and makes the account look verified.
        throw new UsageError("unsupported", undefined, "provider quota endpoint unavailable");
      }
      if (this.source(account) === "desktop") {
        const raw = await this.desktopUsage!.read(account, allowPrompt);
        if (!current()) return this.view(this.store.account(account.id));
        const limits = parseUsage(raw);
        const latest = this.store.account(account.id);
        if (identityKey(latest) !== identityKey(account))
          throw new UsageError("identity-mismatch");
        this.succeed(latest, limits, "desktop", false);
        return this.view(latest);
      }
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
          throw new UsageError("expired", undefined, "saved sign-in has no refresh token");
        refreshed = true;
        credential = await this.refreshCredential(
          account,
          credential,
          force,
          allowPrompt,
        );
      };
      if (!credential.scopes.includes("user:profile"))
        throw new UsageError("scope", undefined, "saved sign-in lacks user:profile");
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
        throw new UsageError("expired", undefined, "saved sign-in expired, not renewed");
      if (!credential.scopes.includes("user:profile"))
        throw new UsageError("scope", undefined, "saved sign-in lacks user:profile");
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
          throw new UsageError("expired", undefined, "renewed sign-in already expired");
        if (!credential.scopes.includes("user:profile"))
          throw new UsageError("scope", undefined, "renewed sign-in lacks user:profile");
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
      this.succeed(latest, limits, "cli", renewalRequired);
      const repair = missingIdentity(latest, profile);
      if (repair) {
        this.store.update((state) => {
          const stored = state.accounts.find((a) => a.id === account.id);
          if (!stored?.auth || !stored.desktop) return;
          stored.auth.accountUuid ??= repair.accountUuid;
          stored.auth.orgId ??= repair.orgId;
          stored.auth.orgName ??= repair.orgName;
          stored.desktop.email ??= repair.desktopEmail;
        });
        // The repaired identity is the one this verified result belongs to.
        this.identities.set(
          account.id,
          identityKey(this.store.account(account.id)),
        );
      }
    } catch (e) {
      if (!current()) return this.view(this.store.account(account.id));
      const error =
        e instanceof UsageError ? e : new UsageError("unavailable", undefined, networkDetail(e));
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
        ...(this.source(account) ? { source: this.source(account) } : {}),
      });
      // Only a change is worth a log line: a failing poll repeats every few minutes.
      if (error.issue !== previous.issue) {
        try {
          this.onIssue?.(account, error.issue, error.detail);
        } catch {
          // The diagnosis log must never turn a usage failure into another one.
        }
      }
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
    return this.view(this.store.account(account.id));
  }
  private succeed(
    account: Account,
    limits: ReturnType<typeof parseUsage>,
    source: NonNullable<AccountUsage["source"]>,
    renewalRequired: boolean,
  ) {
    this.failures.delete(account.id);
    this.serverRetryUntil.delete(account.id);
    this.cache.set(account.id, {
      accountId: account.id,
      status: "ready",
      stale: false,
      checkedAt: new Date(this.now()).toISOString(),
      source,
      ...(renewalRequired ? { connectionRenewalRequired: true } : {}),
      ...limits,
    });
    // History is optional: failed local persistence must not turn a verified
    // live quota response into an authentication/usage error.
    try {
      this.onSample(account, structuredClone(this.cache.get(account.id)!));
    } catch {}
  }
}
