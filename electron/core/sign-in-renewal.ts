import fs from "node:fs/promises";
import path from "node:path";
import type { Account, AccountUsage } from "../../shared/types";
import { desktopCliMismatch } from "../../shared/account-state";

/**
 * Renews Claude Code sign-ins before they end.
 *
 * Anthropic gives each browser sign-in about 30 days (18 to 29 measured by others); renewing the
 * access token keeps that end date, so past it every account needs a new browser sign-in. Claude
 * Code itself only warns 3 days ahead ("run /login"). Relay starts that sign-in by itself when an
 * account's end is that close: the CLI's own `auth login`, its page approved in a hidden window
 * that holds the account's claude.ai session from the Claude app. When that cannot run or does
 * not finish, the user hears it once per end date, with a click to sign in.
 */

/** How long before a sign-in's end Relay renews it (Claude Code warns this far ahead). */
export const RENEW_BEFORE_MS = 3 * 86_400_000;
/** How long after a failed or impossible attempt the next one may run. */
export const RENEW_RETRY_MS = 6 * 3_600_000;

/**
 * How recent a claude.ai sign-in must be for claude.ai to grant a new Claude Code sign-in: older
 * sessions get `403 session_stale_relogin` ("Session is not fresh enough…"). Reports put the
 * limit at 18 to 36 hours; the shortest is used.
 */
export const FRESH_SIGN_IN_MS = 18 * 3_600_000;

export type RenewalResult =
  | { result: "connected" }
  /** Not tried for a passing reason (the Claude app busy, another sign-in running): no notice, no wait. */
  | { result: "busy"; detail: string }
  /**
   * Not tried: the account's claude.ai sign-in is too old for claude.ai to approve a new one.
   * Tried again on every pass, so a fresh sign-in in the Claude app is used within minutes.
   */
  | { result: "waiting"; detail: string }
  /** Nothing to renew with: no claude.ai session Relay may read, or the account is busy. */
  | { result: "unavailable"; detail: string }
  | { result: "failed"; detail: string };

interface Entry {
  attemptAt?: string;
  result?: RenewalResult["result"];
  detail?: string;
  /** The end date the user was told about, so each end is said once. */
  notifiedFor?: string;
}
interface Saved {
  version: 1;
  accounts: Record<string, Entry>;
}

/** When the account's Claude Code sign-in has to be renewed; undefined when not yet. */
export function renewalDue(
  account: Account,
  usage: AccountUsage | undefined,
  now: number,
): { endsAt?: string } | undefined {
  if ((account.provider ?? "claude") !== "claude" || !account.auth?.loggedIn || !account.desktop)
    return;
  // A Claude Code sign-in of another account or workspace than the Claude app's: renewing it
  // from the app's session would replace it with the app's identity.
  if (desktopCliMismatch(account)) return;
  if (usage?.cliSignInEnded) return usage.cliSignInEndsAt ? { endsAt: usage.cliSignInEndsAt } : {};
  const endsAt = usage?.cliSignInEndsAt ? Date.parse(usage.cliSignInEndsAt) : NaN;
  if (Number.isFinite(endsAt) && endsAt - now <= RENEW_BEFORE_MS)
    return { endsAt: usage!.cliSignInEndsAt };
}

export class SignInRenewal {
  private running = false;
  private saved?: Saved;
  constructor(
    private deps: {
      file: string;
      accounts: () => Account[];
      usage: (id: string) => AccountUsage | undefined;
      /** Runs one renewal to its end. */
      renew: (account: Account) => Promise<RenewalResult>;
      /** Told once per end date when Relay could not renew it. */
      notify: (account: Account, endsAt?: string) => void;
      now?: () => number;
    },
  ) {}
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private async load(): Promise<Saved> {
    if (this.saved) return this.saved;
    try {
      const value = JSON.parse(await fs.readFile(this.deps.file, "utf8")) as Saved;
      if (value?.version === 1 && value.accounts && typeof value.accounts === "object")
        return (this.saved = value);
    } catch {}
    return (this.saved = { version: 1, accounts: {} });
  }
  private async save() {
    if (!this.saved) return;
    await fs.mkdir(path.dirname(this.deps.file), { recursive: true });
    const temp = `${this.deps.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    await fs.rename(temp, this.deps.file);
  }
  /**
   * After the user allowed what an attempt lacked (the Keychain read of the Claude app's
   * sign-in): attempts that could not run may run again at once.
   */
  async retryUnavailable(): Promise<void> {
    const saved = await this.load();
    for (const entry of Object.values(saved.accounts))
      if (entry.result === "unavailable") delete entry.attemptAt;
    await this.save().catch(() => {});
    await this.tick();
  }
  /** Renews one account now, asked by the user: due or not, and told nobody but the caller. */
  async renewNow(account: Account): Promise<RenewalResult> {
    if (this.running) return { result: "busy", detail: "another renewal is running" };
    this.running = true;
    try {
      const saved = await this.load();
      const outcome = await this.attempt(account);
      // Nothing was tried: the automatic passes keep their own schedule.
      if (outcome.result === "busy" || outcome.result === "waiting") return outcome;
      const entry = (saved.accounts[account.id] ??= {});
      entry.attemptAt = new Date(this.now()).toISOString();
      entry.result = outcome.result;
      if (outcome.result === "connected") {
        delete entry.detail;
        delete entry.notifiedFor;
      } else entry.detail = outcome.detail;
      await this.save().catch(() => {});
      return outcome;
    } finally {
      this.running = false;
    }
  }
  private async attempt(account: Account): Promise<RenewalResult> {
    try {
      return await this.deps.renew(account);
    } catch (error) {
      return { result: "failed", detail: String((error as Error)?.message ?? error).slice(0, 200) };
    }
  }
  /** One pass: renews at most one account, the one whose sign-in ends first. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const saved = await this.load();
      const now = this.now();
      const accounts = new Set(this.deps.accounts().map((a) => a.id));
      for (const id of Object.keys(saved.accounts)) if (!accounts.has(id)) delete saved.accounts[id];
      const due = this.deps
        .accounts()
        .map((account) => ({ account, due: renewalDue(account, this.deps.usage(account.id), now) }))
        .filter((c): c is { account: Account; due: { endsAt?: string } } => !!c.due)
        .filter(({ account }) => {
          const at = Date.parse(saved.accounts[account.id]?.attemptAt ?? "");
          return !Number.isFinite(at) || now - at >= RENEW_RETRY_MS || at > now;
        })
        .sort((a, b) => (Date.parse(a.due.endsAt ?? "") || 0) - (Date.parse(b.due.endsAt ?? "") || 0));
      // One real attempt per pass; accounts only waiting for a fresh sign-in cost a cookie read.
      for (const next of due) {
        const { account } = next;
        const entry = (saved.accounts[account.id] ??= {});
        const before = entry.attemptAt;
        entry.attemptAt = new Date(now).toISOString();
        await this.save().catch(() => {});
        const outcome = await this.attempt(account);
        // Nothing was tried: the next pass looks again.
        if (outcome.result === "waiting" || outcome.result === "busy") {
          if (before) entry.attemptAt = before;
          else delete entry.attemptAt;
        }
        if (outcome.result === "busy") {
          await this.save().catch(() => {});
          continue;
        }
        entry.result = outcome.result;
        if (outcome.result === "connected") {
          delete entry.detail;
          delete entry.notifiedFor;
        } else {
          entry.detail = outcome.detail;
          const key = next.due.endsAt ?? "ended";
          if (entry.notifiedFor !== key) {
            entry.notifiedFor = key;
            try {
              this.deps.notify(account, next.due.endsAt);
            } catch {}
          }
        }
        await this.save().catch(() => {});
        if (outcome.result !== "waiting") break;
      }
    } finally {
      this.running = false;
    }
  }
}
