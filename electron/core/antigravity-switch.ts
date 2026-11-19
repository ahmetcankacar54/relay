import fsp from "node:fs/promises";
import path from "node:path";
import { readBytes, writeBytes } from "./desktop-files";
import { runDetached } from "./detached-exec";
import { securityKeychain, type TerminalKeychain } from "./terminal-identity";
import { ANTIGRAVITY_BUNDLE_ID } from "./antigravity-app";
import type { Account, AntigravityAppResult } from "../../shared/types";

/**
 * Moving Google's Antigravity app (and the `agy` CLI) from one Google account to another, the way
 * Relay moves the Claude app: each account's sign-in is kept sealed in Relay's vault, and a switch
 * closes the app, puts the other sign-in in its place and opens the app again.
 *
 * Antigravity 2.x keeps its sign-in in one Keychain item, service `gemini`, account `antigravity`,
 * which the app and `agy` share: `go-keyring-base64:` and the base64 of a JSON object holding the
 * OAuth token and `id_token_email`. Both read it when they start, so a running `agy` stays on the
 * account it started with. The app may write its own sign-in back while it shuts down, so the new
 * one is written only once every Antigravity process has gone.
 *
 * Relay never signs out inside the app (that may end the sign-in at Google) and never talks to
 * Google with these tokens: the official app does, as it always would. Google's FAQ says automated
 * account rotation is not supported on consumer plans, so a switch only ever starts from a click.
 */

export const ANTIGRAVITY_SERVICE = "gemini";
export const ANTIGRAVITY_ITEM_ACCOUNT = "antigravity";
const PREFIX = "go-keyring-base64:";
/** The app's settings keys that record which account last accepted its terms (`agy.` and older `jetski.`). */
const ONBOARDING_KEY = /^[a-z]+\.onboarding\.lastLogin[A-Za-z]*$/;
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
const MAX_ITEM_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIR = "antigravity-app";

/** What a sign-in says about itself: its Google account, when the item is one Relay understands. */
export function parseSignIn(raw: string | undefined): { email?: string; valid: boolean } {
  if (!raw || raw.length > MAX_ITEM_BYTES || !raw.startsWith(PREFIX)) return { valid: false };
  try {
    const data = JSON.parse(Buffer.from(raw.slice(PREFIX.length), "base64").toString("utf8"));
    const token = data?.token;
    if (!token || typeof token.refresh_token !== "string" || !token.refresh_token) return { valid: false };
    let email = typeof data.id_token_email === "string" ? data.id_token_email : undefined;
    if (!email && typeof data.id_token === "string") {
      const claims = JSON.parse(Buffer.from(data.id_token.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof claims?.email === "string") email = claims.email;
    }
    return { valid: true, ...(email && /^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email) ? { email: email.toLowerCase() } : {}) };
  } catch {
    return { valid: false };
  }
}

/** One account's saved sign-in, sealed in the vault. */
interface Saved {
  email: string;
  raw: string;
  /** The app's terms-acceptance keys as they stood for this account, put back at a switch to it. */
  onboarding?: Record<string, string>;
  savedAt: string;
}

export class AntigravityVault {
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(accountId: string) {
    if (!UUID.test(accountId)) throw new Error("Invalid account id.");
    return path.join(DIR, `${accountId.toLowerCase()}.bin`);
  }

  async save(accountId: string, entry: Omit<Saved, "savedAt">): Promise<void> {
    const saved: Saved = { ...entry, savedAt: new Date(this.now()).toISOString() };
    await writeBytes(this.vault, this.file(accountId), this.seal(JSON.stringify(saved)));
  }

  /** The sign-in saved for an account; undefined when there is none or it cannot be opened. */
  async load(accountId: string): Promise<Saved | undefined> {
    const data = await readBytes(this.vault, this.file(accountId)).catch(() => null);
    if (!data) return undefined;
    try {
      const saved = JSON.parse(this.unseal(data)) as Saved;
      return saved && typeof saved.raw === "string" && parseSignIn(saved.raw).valid ? saved : undefined;
    } catch {
      return undefined;
    }
  }

  /** The last sign-in of a Google account Relay does not have, kept so a switch never loses it. */
  async saveOther(raw: string): Promise<void> {
    const saved = { email: parseSignIn(raw).email, raw, savedAt: new Date(this.now()).toISOString() };
    await writeBytes(this.vault, path.join(DIR, "other.bin"), this.seal(JSON.stringify(saved)));
  }

  async remove(accountId: string): Promise<void> {
    await writeBytes(this.vault, this.file(accountId), null);
  }

  /** The accounts with a sign-in saved. */
  async list(): Promise<string[]> {
    const names = await fsp.readdir(path.join(this.vault, DIR)).catch(() => [] as string[]);
    return names.flatMap((name) => {
      const id = /^(.+)\.bin$/.exec(name)?.[1];
      return id && UUID.test(id) ? [id] : [];
    });
  }
}

export interface AntigravitySwitchPorts {
  keychain: TerminalKeychain;
  /** The app's settings file (`app_storage.json`). */
  settings: {
    read(): Promise<Record<string, unknown> | undefined>;
    /** Sets these keys, keeping every other one; only while the app is closed. */
    write(values: Record<string, string>): Promise<void>;
  };
  /** Whether any Antigravity app process runs (the app, its helpers, its language server), and how many `agy` do. */
  processes(): Promise<{ app: boolean; agy: number }>;
  /** Asks the app to quit, as the user would; resolves once asked. */
  quit(): Promise<void>;
  launch(): Promise<void>;
  sleep(ms: number): Promise<void>;
}

/** Why a switch or a sign-in stopped. */
export type AntigravitySwitchReason =
  | "not-saved"
  | "still-running"
  | "keychain"
  | "verify-failed"
  | "busy"
  | "timeout";

export class AntigravitySwitchError extends Error {
  constructor(readonly reason: AntigravitySwitchReason) {
    super(reason);
  }
}

const QUIT_WAIT_MS = 30_000;
const SIGN_IN_WAIT_MS = 10 * 60_000;
const POLL_MS = 1_000;
const SIGN_IN_POLL_MS = 2_000;
const PEEK_TTL_MS = 15_000;

/** Which Antigravity account the app and `agy` use now, read from the Keychain item itself. */
export interface AntigravityCurrent {
  accountId?: string;
  /** Signed in with a Google account Relay does not have. */
  other?: boolean;
  signedOut?: boolean;
}

type Accounts = () => readonly Pick<Account, "id" | "provider" | "auth">[];

export class AntigravitySwitcher {
  private running: Promise<unknown> = Promise.resolve();
  private op?: "switching" | "signing-in";
  private signInFor?: string;
  private signInCancel?: () => void;
  private result?: AntigravityAppResult;
  private saved?: Set<string>;
  private peeked?: { at: number; current: AntigravityCurrent };

  constructor(
    private readonly ports: AntigravitySwitchPorts,
    private readonly vault: AntigravityVault,
    private readonly accounts: Accounts,
    private readonly onChange: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** What the snapshot carries: saved accounts, the operation under way, the last outcome. */
  async state() {
    this.saved ??= new Set(await this.vault.list());
    const ids = new Set(this.accounts().filter((a) => a.provider === "antigravity").map((a) => a.id));
    return {
      saved: [...this.saved].filter((id) => ids.has(id)),
      ...(this.op ? { busy: this.op } : {}),
      ...(this.signInFor ? { signInFor: this.signInFor } : {}),
      ...(this.result ? { result: this.result } : {}),
    };
  }

  private matchEmail(email: string | undefined) {
    if (!email) return undefined;
    return this.accounts().find((a) => a.provider === "antigravity" && a.auth?.email?.toLowerCase() === email);
  }

  /**
   * The account the Keychain item belongs to, read at most every 15 s. A Relay account's sign-in is
   * saved (or refreshed) on the way, so the vault always holds the latest one the app used.
   */
  async current(force = false): Promise<AntigravityCurrent> {
    if (!force && this.peeked && this.now() - this.peeked.at < PEEK_TTL_MS) return this.peeked.current;
    // While a switch or a sign-in moves the item, the last reading stands.
    if (this.op && this.peeked) return this.peeked.current;
    let current: AntigravityCurrent;
    try {
      current = (await this.captureCurrent()).current;
    } catch {
      current = this.peeked?.current ?? {};
    }
    this.peeked = { at: this.now(), current };
    return current;
  }

  /** Reads the item and saves it for its Relay account when it is new or changed. */
  private async captureCurrent(): Promise<{ current: AntigravityCurrent; raw?: string }> {
    const raw = await this.ports.keychain.read();
    if (raw === undefined) return { current: { signedOut: true } };
    const sign = parseSignIn(raw);
    const account = this.matchEmail(sign.email);
    if (!sign.valid || !sign.email || !account) return { current: { other: true }, raw };
    const before = await this.vault.load(account.id);
    if (before?.raw !== raw) {
      const onboarding = await this.onboarding(sign.email);
      await this.vault.save(account.id, {
        email: sign.email,
        raw,
        ...(onboarding ? { onboarding } : before?.onboarding ? { onboarding: before.onboarding } : {}),
      });
      (this.saved ??= new Set(await this.vault.list())).add(account.id);
    }
    return { current: { accountId: account.id }, raw };
  }

  /** The app's terms keys, when they name this e-mail (they were written for this account). */
  private async onboarding(email: string): Promise<Record<string, string> | undefined> {
    const settings = await this.ports.settings.read().catch(() => undefined);
    if (!settings) return undefined;
    const keys = Object.entries(settings).filter(([key, value]) => ONBOARDING_KEY.test(key) && typeof value === "string");
    const named = keys.some(([key, value]) => /Username$/.test(key) && String(value).toLowerCase() === email);
    return named ? Object.fromEntries(keys) as Record<string, string> : undefined;
  }

  private exclusive<T>(op: "switching" | "signing-in", action: () => Promise<T>): Promise<T> {
    if (this.op) return Promise.reject(new AntigravitySwitchError("busy"));
    this.op = op;
    this.onChange();
    const run = this.running.then(action).finally(() => {
      if (this.op === op && op === "switching") this.op = undefined;
      this.peeked = undefined;
      this.onChange();
    });
    this.running = run.catch(() => {});
    return run;
  }

  /** Closes the app and waits until every one of its processes is gone. Whether it was open. */
  private async closeApp(): Promise<boolean> {
    if (!(await this.ports.processes()).app) return false;
    await this.ports.quit();
    for (let waited = 0; waited < QUIT_WAIT_MS; waited += POLL_MS) {
      await this.ports.sleep(POLL_MS);
      if (!(await this.ports.processes()).app) return true;
    }
    throw new AntigravitySwitchError("still-running");
  }

  /** Writes a sign-in into the item and reads it back. */
  private async put(raw: string) {
    try {
      await this.ports.keychain.write(raw);
    } catch {
      throw new AntigravitySwitchError("keychain");
    }
    const back = await this.ports.keychain.read().catch(() => undefined);
    if (back !== raw) throw new AntigravitySwitchError("verify-failed");
  }

  private finish(result: Omit<AntigravityAppResult, "at">) {
    this.result = { ...result, at: this.now() };
  }

  /**
   * Moves the app and `agy` to a saved account: saves the sign-in in use, closes the app, puts the
   * other sign-in in the Keychain, sets the app's terms keys for it, and opens the app again if it
   * was open. A running `agy` keeps its account until it restarts; the outcome counts them.
   */
  switchTo(accountId: string): Promise<AntigravityAppResult> {
    return this.exclusive("switching", async () => {
      try {
        const target = await this.vault.load(accountId);
        if (!target) throw new AntigravitySwitchError("not-saved");
        const before = await this.captureCurrent().catch(() => undefined);
        if (before?.current.accountId === accountId) {
          // Already on it: nothing to close or write.
          this.finish({ kind: "switched", accountId });
          return this.result!;
        }
        const wasOpen = await this.closeApp();
        // The app may have written its sign-in on the way out: save that one, not the earlier copy.
        const leaving = await this.captureCurrent().catch(() => undefined);
        if (leaving?.current.other && leaving.raw) await this.keepOther(leaving.raw);
        await this.put(target.raw);
        if (target.onboarding) await this.ports.settings.write(target.onboarding).catch(() => undefined);
        if (wasOpen) await this.ports.launch();
        const { agy } = await this.ports.processes();
        this.finish({ kind: "switched", accountId, ...(agy ? { agyRunning: agy } : {}) });
      } catch (error) {
        this.finish({ kind: "failed", accountId, reason: reasonOf(error) });
      }
      return this.result!;
    });
  }

  /** A sign-in of an account Relay does not have, kept once so a switch never loses it. */
  private async keepOther(raw: string) {
    await this.vault.saveOther(raw).catch(() => undefined);
  }

  /**
   * Saves another account's sign-in through the official app: saves the one in use, closes the app,
   * takes the sign-in off this Mac (no sign-out at Google), opens the app on its sign-in screen and
   * waits up to 10 minutes for the user to sign in. The sign-in that appears is saved for the Relay
   * account with its e-mail; `cancelSignIn` puts the earlier one back.
   */
  beginSignIn(accountId: string): Promise<void> {
    return this.exclusive("signing-in", async () => {
      this.signInFor = accountId;
      this.result = undefined;
      let previous: string | undefined;
      try {
        previous = (await this.captureCurrent().catch(() => undefined))?.raw;
        await this.closeApp();
        previous = (await this.captureCurrent().catch(() => undefined))?.raw ?? previous;
        if (previous && parseSignIn(previous).valid && !this.matchEmail(parseSignIn(previous).email)) await this.keepOther(previous);
        try {
          await this.ports.keychain.remove();
        } catch {
          throw new AntigravitySwitchError("keychain");
        }
        await this.ports.launch();
      } catch (error) {
        if (previous) await this.ports.keychain.write(previous).catch(() => undefined);
        this.op = undefined;
        this.signInFor = undefined;
        this.finish({ kind: "failed", accountId, reason: reasonOf(error) });
        return;
      }
      // The wait runs on after the click returns; the snapshot shows it.
      void this.waitForSignIn(accountId, previous);
    });
  }

  private async waitForSignIn(accountId: string, previous: string | undefined) {
    let cancelled = false;
    this.signInCancel = () => {
      cancelled = true;
    };
    const done = (result: Omit<AntigravityAppResult, "at">) => {
      this.op = undefined;
      this.signInFor = undefined;
      this.signInCancel = undefined;
      this.peeked = undefined;
      this.finish(result);
      this.onChange();
    };
    // Nothing was signed in (cancelled, or 10 minutes passed): the app sits on its sign-in screen,
    // so close it, put the earlier sign-in back and open it again.
    const restore = async (result: Omit<AntigravityAppResult, "at">) => {
      try {
        if ((await this.ports.keychain.read().catch(() => undefined)) === undefined && previous) {
          const wasOpen = await this.closeApp();
          await this.put(previous);
          if (wasOpen) await this.ports.launch();
        }
        done(result);
      } catch (error) {
        done({ kind: "failed", accountId, reason: reasonOf(error) });
      }
    };
    for (let waited = 0; waited < SIGN_IN_WAIT_MS; waited += SIGN_IN_POLL_MS) {
      await this.ports.sleep(SIGN_IN_POLL_MS);
      if (cancelled) return restore({ kind: "cancelled", accountId });
      const raw = await this.ports.keychain.read().catch(() => undefined);
      if (raw === undefined) continue;
      try {
        const { current } = await this.captureCurrent();
        if (current.accountId) done({ kind: current.accountId === accountId ? "saved" : "saved-other", accountId: current.accountId });
        else done({ kind: "other", accountId });
      } catch (error) {
        done({ kind: "failed", accountId, reason: reasonOf(error) });
      }
      return;
    }
    return restore({ kind: "failed", accountId, reason: "timeout" });
  }

  /** Stops waiting for a sign-in and puts the earlier one back when none was made. */
  cancelSignIn(): void {
    this.signInCancel?.();
  }
}

function reasonOf(error: unknown): AntigravitySwitchReason {
  return error instanceof AntigravitySwitchError ? error.reason : "keychain";
}

// --- macOS ----------------------------------------------------------------------------------------

/** Antigravity's processes in a `ps -axo pid=,comm=` listing: the app bundle's, and the `agy` CLI. */
export function antigravityProcesses(stdout: string): { app: boolean; agy: number } {
  let app = false;
  let agy = 0;
  for (const line of stdout.split("\n")) {
    const comm = /^\s*\d+\s+(.+)$/.exec(line)?.[1]?.trim();
    if (!comm) continue;
    if (/\/Antigravity\.app\/Contents\//.test(comm)) app = true;
    else if (path.basename(comm) === "agy") agy++;
  }
  return { app, agy };
}

/** Sets keys in the app's settings file, keeping every other key; refused for an odd file. */
export async function writeAntigravitySettings(file: string, values: Record<string, string>): Promise<void> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) throw new Error("Unexpected Antigravity settings file.");
  const data = JSON.parse(await fsp.readFile(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unexpected Antigravity settings file.");
  for (const [key, value] of Object.entries(values)) if (ONBOARDING_KEY.test(key)) data[key] = value;
  const tmp = `${file}.relay-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(data), { mode: stat.mode & 0o777 });
  await fsp.rename(tmp, file);
}

export function macAntigravityPorts(dataDir: string): AntigravitySwitchPorts {
  const settingsFile = path.join(dataDir, "app_storage.json");
  return {
    // Read and written through /usr/bin/security like the app and agy themselves (go-keyring),
    // so the item's access list stays as it is and no dialog appears.
    keychain: securityKeychain(ANTIGRAVITY_ITEM_ACCOUNT, "/usr/bin/security", ANTIGRAVITY_SERVICE),
    settings: {
      async read() {
        const stat = await fsp.lstat(settingsFile).catch(() => undefined);
        if (!stat?.isFile() || stat.size > MAX_SETTINGS_BYTES) return undefined;
        const data = JSON.parse(await fsp.readFile(settingsFile, "utf8"));
        return data && typeof data === "object" && !Array.isArray(data) ? data : undefined;
      },
      write: (values) => writeAntigravitySettings(settingsFile, values),
    },
    async processes() {
      const { stdout } = await runDetached("/bin/ps", ["-axo", "pid=,comm="], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
      if (!/^\s*\d+\s+\S/m.test(stdout)) throw new Error("The process list could not be read.");
      return antigravityProcesses(stdout);
    },
    async quit() {
      // Guarded: `tell … to quit` on an app that is not running would start it first.
      await runDetached(
        "/usr/bin/osascript",
        ["-e", `if application id "${ANTIGRAVITY_BUNDLE_ID}" is running then tell application id "${ANTIGRAVITY_BUNDLE_ID}" to quit`],
        { timeout: 20_000 },
      ).catch(() => undefined);
    },
    async launch() {
      const os = await import("node:os");
      await runDetached("/usr/bin/open", ["-b", ANTIGRAVITY_BUNDLE_ID], {
        timeout: 15_000,
        env: { HOME: os.homedir(), USER: os.userInfo().username, PATH: "/usr/bin:/bin" },
      });
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
