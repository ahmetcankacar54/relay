import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  readBytes,
  safeFile,
  writeBytes,
  type JsonObject,
} from "./desktop-files";
import { credentialService, decodeSecret } from "./usage-credentials";
import { requestUsageJson } from "./usage";
import { LockBusyError, withCliRefreshLock } from "./cli-refresh-lock";
import {
  sameIdentity,
  type TerminalCurrent,
  type TerminalIdentity,
  type TerminalMode,
  type TerminalOutcome,
  type TerminalReason,
  type TerminalSaved,
} from "../../shared/terminal-identity";

/** The Keychain service of Claude Code's sign-in when CLAUDE_CONFIG_DIR is not set. */
export const TERMINAL_SERVICE = "Claude Code-credentials";
/** Exit status of `security find-generic-password` when no item matches. */
const ITEM_NOT_FOUND = 44;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a terminal step stopped, carried as an error inside this module only. */
export class TerminalError extends Error {
  constructor(readonly reason: TerminalReason) {
    super(reason);
  }
}

/** The stored credential item: Claude Code's JSON text, which may hold other sign-ins (MCP servers) too. */
export interface TerminalKeychain {
  /** The item's text; undefined when there is none. Throws TerminalError "locked". */
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  remove(): Promise<void>;
}

/** Claude Code's global config file (`~/.claude.json`), whose `oauthAccount` names the sign-in. */
export interface TerminalConfig {
  read(): Promise<JsonObject | undefined>;
  /** Sets `oauthAccount` (removes it for undefined), keeping every other key. */
  writeAccount(account: JsonObject | undefined): Promise<void>;
}

export interface TerminalPorts {
  keychain: TerminalKeychain;
  config: TerminalConfig;
  /** Holds Claude Code's own refresh lock while `action` runs; throws TerminalError "busy". */
  lock: <T>(action: () => Promise<T>) => Promise<T>;
  /**
   * Who an access token belongs to, asked of Anthropic (the OAuth profile endpoint); undefined
   * when that cannot be told (offline, refused). Without it nothing can be verified.
   */
  owner?: (accessToken: string) => Promise<TerminalIdentity | undefined>;
}

// --- macOS -----------------------------------------------------------------------------------

/**
 * The longest command line interactive `security -i` takes whole. It reads one command per line
 * into a 4 KB buffer and silently cuts a longer one (measured 2026-11-04: a 4,016-character line
 * was stored whole, an 8,016-character one kept 2,013 of its 4,008 bytes). Claude Code writes
 * through stdin up to this length and through the arguments above it; Relay does the same. Before,
 * an item holding several MCP servers' sign-ins was cut, which left Claude Code with an unreadable
 * item: every MCP sign-in and the terminal's Claude sign-in were lost at once.
 */
export const SECURITY_STDIN_LIMIT = 4032;

/**
 * The Keychain item, read and written through `/usr/bin/security` exactly as Claude Code does
 * (its trusted application, so no dialog). The secret goes in on stdin when its command fits
 * `SECURITY_STDIN_LIMIT`, and in the arguments when it does not, as Claude Code does too.
 */
export function securityKeychain(
  user = os.userInfo().username,
  tool = "/usr/bin/security",
  service = TERMINAL_SERVICE,
): TerminalKeychain {
  // Checked at use, so a name it cannot quote only stops the terminal step.
  const unsupported = !user || /["\\\n\r]/.test(user);
  const run = (args: string[]) =>
    unsupported
      ? Promise.reject(new TerminalError("unsupported"))
      : new Promise<{ code?: number | string | null; stdout: string }>(
          (resolve) =>
            execFile(
              tool,
              args,
              {
                timeout: 15_000,
                killSignal: "SIGKILL",
                maxBuffer: 1024 * 1024,
                windowsHide: true,
              },
              (error, stdout) =>
                resolve({
                  code: error ? (error.code ?? "failed") : undefined,
                  stdout: String(stdout),
                }),
            ),
        );
  return {
    async read() {
      const found = await run([
        "find-generic-password",
        "-a",
        user,
        "-s",
        service,
        "-w",
      ]);
      if (found.code === ITEM_NOT_FOUND) return undefined;
      if (found.code !== undefined) throw new TerminalError("locked");
      return decodeSecret(found.stdout);
    },
    async write(text) {
      if (unsupported) throw new TerminalError("unsupported");
      const hex = Buffer.from(text, "utf8").toString("hex");
      const line = `add-generic-password -U -a "${user}" -s "${service}" -X "${hex}"\n`;
      if (line.length > SECURITY_STDIN_LIMIT) {
        // Too long for one interactive line: the arguments, briefly visible to this user's processes.
        const done = await run(["add-generic-password", "-U", "-a", user, "-s", service, "-X", hex]);
        if (done.code !== undefined) throw new TerminalError("write-failed");
        return;
      }
      // Interactive `security` exits 0 whatever happens: the caller reads the item back.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(tool, ["-i"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end(`${line}quit\n`);
      });
    },
    async remove() {
      const done = await run([
        "delete-generic-password",
        "-a",
        user,
        "-s",
        service,
      ]);
      if (done.code !== undefined && done.code !== ITEM_NOT_FOUND)
        throw new TerminalError("write-failed");
    },
  };
}

/**
 * Claude Code's global config: `<config dir>/.config.json` when that legacy file exists, as
 * Claude Code reads it, otherwise `~/.claude.json`.
 */
export function claudeConfigFile(
  home = os.homedir(),
  configDir = path.join(home, ".claude"),
) {
  const legacy = path.join(configDir, ".config.json");
  return fs.existsSync(legacy) ? legacy : path.join(home, ".claude.json");
}

export function jsonConfig(file: string): TerminalConfig {
  const parse = (text: string) => {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new TerminalError("unreadable");
    return value as JsonObject;
  };
  const readText = async () => {
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
        throw new TerminalError("unreadable");
      return {
        text: await fsp.readFile(file, "utf8"),
        mode: stat.mode & 0o777,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error instanceof TerminalError
        ? error
        : new TerminalError("unreadable");
    }
  };
  return {
    async read() {
      const found = await readText();
      return found ? parse(found.text) : undefined;
    },
    async writeAccount(account) {
      // Claude Code rewrites this file often; a write that raced one is made again on the new text.
      for (let attempt = 0; attempt < 3; attempt++) {
        const found = await readText();
        const config = found ? parse(found.text) : {};
        if (account === undefined) delete config.oauthAccount;
        else config.oauthAccount = account;
        const tmp = `${file}.relay-${randomUUID()}`;
        try {
          await fsp.writeFile(tmp, JSON.stringify(config, null, 2), {
            mode: found?.mode ?? 0o600,
            flag: "wx",
          });
          if ((await readText())?.text !== found?.text) continue;
          await fsp.rename(tmp, file);
          return;
        } finally {
          await fsp.rm(tmp, { force: true });
        }
      }
      throw new TerminalError("busy");
    },
  };
}

/** The account and organization the OAuth profile endpoint names for `accessToken`. */
export async function profileOwner(
  accessToken: string,
): Promise<TerminalIdentity | undefined> {
  try {
    const value = (await requestUsageJson("profile", accessToken)) as any;
    const accountUuid = value?.account?.uuid ?? value?.account?.account_uuid;
    const orgId =
      value?.organization?.uuid ?? value?.organization?.organization_uuid;
    return typeof accountUuid === "string" &&
      typeof orgId === "string" &&
      UUID.test(accountUuid) &&
      UUID.test(orgId)
      ? { accountUuid: accountUuid.toLowerCase(), orgId: orgId.toLowerCase() }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The ports for the plain `claude` of this Mac user; undefined elsewhere. */
export function macTerminalPorts(
  home = os.homedir(),
  platform = process.platform,
): TerminalPorts | undefined {
  if (platform !== "darwin") return undefined;
  const configDir = path.join(home, ".claude");
  return {
    keychain: securityKeychain(
      (() => {
        try {
          return os.userInfo().username;
        } catch {
          return "";
        }
      })(),
    ),
    config: jsonConfig(claudeConfigFile(home, configDir)),
    lock: async (action) => {
      try {
        return await withCliRefreshLock(configDir, action, { waitMs: 10_000 });
      } catch (error) {
        throw error instanceof LockBusyError
          ? new TerminalError("busy")
          : error;
      }
    },
    owner: profileOwner,
  };
}

/**
 * Where a `claude auth login` run with `CLAUDE_CONFIG_DIR=dir` leaves its sign-in: the Keychain
 * item named after the folder (a private file in it when the Keychain refused the write) and
 * the folder's `.claude.json`. Relay signs in there to get an account's terminal sign-in
 * without touching the one the terminal holds.
 */
export function scratchSignInPorts(
  dir: string,
  platform = process.platform,
): Pick<TerminalPorts, "keychain" | "config" | "owner"> {
  const item =
    platform === "darwin"
      ? securityKeychain(
          (() => {
            try {
              return os.userInfo().username;
            } catch {
              return "";
            }
          })(),
          "/usr/bin/security",
          credentialService(dir),
        )
      : undefined;
  const file = path.join(dir, ".credentials.json");
  return {
    keychain: {
      async read() {
        const stored = await item?.read();
        if (stored !== undefined) return stored;
        try {
          const stat = await fsp.lstat(file);
          if (!stat.isFile() || stat.size > 65_536) return undefined;
          return await fsp.readFile(file, "utf8");
        } catch {
          return undefined;
        }
      },
      async write() {
        throw new TerminalError("unsupported");
      },
      async remove() {
        await item?.remove().catch(() => undefined);
        await fsp.rm(file, { force: true });
      },
    },
    config: jsonConfig(path.join(dir, ".claude.json")),
    owner: profileOwner,
  };
}

/** What became of a sign-in made for the terminal in a scratch folder. */
export type TerminalAdoption = "saved" | "signed-out" | "other-account";

/**
 * Keeps the sign-in `ports` hold as the terminal sign-in of the account with `expected`
 * identities: it must name one of them, and its token must be that account's when Anthropic can
 * be asked. Saved as taken away (`parked`): nothing else holds it, so it stays good until a
 * switch puts it in the terminal.
 */
export async function adoptTerminalSignIn(
  ports: Pick<TerminalPorts, "keychain" | "config" | "owner">,
  expected: TerminalIdentity[],
  vault: TerminalVault,
): Promise<TerminalAdoption> {
  const reading = await readTerminal(ports as TerminalPorts);
  if (!reading.oauth || !reading.account) return "signed-out";
  const { identity } = reading;
  if (!identity || !expected.some((x) => sameIdentity(x, identity))) return "other-account";
  const owner = await ports.owner?.(String(reading.oauth.accessToken)).catch(() => undefined);
  if (owner && !sameIdentity(owner, identity)) return "other-account";
  await vault.save(identity, reading.oauth, reading.account, true);
  return "saved";
}

// --- The vault -------------------------------------------------------------------------------

/** Inside the vault, one sealed file per account and organization: `terminal/<uuid>.<org>.bin`. */
const DIR = "terminal";

interface Saved {
  accountUuid: string;
  orgId: string;
  savedAt: string;
  /**
   * Taken away from the terminal at a switch, so it is the only copy and still good. A copy
   * saved by a check while the sign-in stayed in use goes stale once Claude Code renews it.
   */
  parked: boolean;
  /** Claude Code's `claudeAiOauth`. */
  oauth: JsonObject;
  /** Claude Code's `oauthAccount`. */
  account: JsonObject;
}

const vaultFile = (id: TerminalIdentity) => {
  if (!UUID.test(id.accountUuid) || !UUID.test(id.orgId))
    throw new Error("Invalid identity.");
  return `${DIR}/${id.accountUuid.toLowerCase()}.${id.orgId.toLowerCase()}.bin`;
};

/** The terminal's sign-ins, sealed like the rest of the vault, each under the identity it names. */
export class TerminalVault {
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  async save(
    id: TerminalIdentity,
    oauth: JsonObject,
    account: JsonObject,
    parked: boolean,
  ): Promise<void> {
    const saved: Saved = {
      accountUuid: id.accountUuid.toLowerCase(),
      orgId: id.orgId.toLowerCase(),
      savedAt: new Date(this.now()).toISOString(),
      parked,
      oauth,
      account,
    };
    await writeBytes(
      this.vault,
      vaultFile(id),
      this.seal(JSON.stringify(saved)),
    );
  }

  /** The sign-in saved for the first of `ids` that has one. Throws for a damaged file. */
  async load(ids: TerminalIdentity[]): Promise<Saved | undefined> {
    for (const id of ids) {
      const data = await readBytes(this.vault, vaultFile(id));
      if (!data) continue;
      const saved = JSON.parse(this.unseal(data)) as Saved;
      if (
        !saved ||
        !sameIdentity(saved, id) ||
        !validOauth(saved.oauth) ||
        !saved.account ||
        typeof saved.account !== "object"
      )
        throw new Error("Invalid saved terminal sign-in.");
      return { ...saved, parked: saved.parked === true };
    }
    return undefined;
  }

  async remove(id: TerminalIdentity): Promise<void> {
    await writeBytes(this.vault, vaultFile(id), null);
  }

  /** Which identities have a sign-in saved, when, and whether it was taken away at a switch. */
  async list(): Promise<TerminalSaved[]> {
    let names: string[];
    let dir: string;
    try {
      dir = await safeFile(this.vault, DIR);
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: TerminalSaved[] = [];
    for (const name of names) {
      const match = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.bin$/.exec(name);
      if (!match || !UUID.test(match[1]) || !UUID.test(match[2])) continue;
      const id = { accountUuid: match[1], orgId: match[2] };
      try {
        const saved = await this.load([id]);
        if (saved)
          out.push({ ...id, savedAt: saved.savedAt, parked: saved.parked });
      } catch {
        // Damaged or gone since the listing: not offered.
      }
    }
    return out;
  }
}

// --- The step --------------------------------------------------------------------------------

function validOauth(value: unknown): value is JsonObject {
  const oauth = value as JsonObject | undefined;
  return (
    !!oauth &&
    typeof oauth === "object" &&
    typeof oauth.accessToken === "string" &&
    !!oauth.accessToken &&
    typeof oauth.refreshToken === "string" &&
    !!oauth.refreshToken
  );
}

/** Tells two credentials apart without keeping either in the clear. */
const fingerprint = (oauth: JsonObject | undefined) =>
  oauth
    ? createHash("sha256")
        .update(`${oauth.accessToken}\0${oauth.refreshToken}`)
        .digest("hex")
    : "";

/** An access token this close to its expiry is not asked about: it may lapse on the way. */
const VERIFY_MARGIN_MS = 60_000;

interface Reading {
  /** The item's text as stored, for putting it back; undefined when there is none. */
  raw?: string;
  item: JsonObject;
  oauth?: JsonObject;
  account?: JsonObject;
  identity?: TerminalIdentity;
}

async function readTerminal(ports: TerminalPorts): Promise<Reading> {
  const raw = await ports.keychain.read();
  let item: JsonObject = {};
  if (raw !== undefined) {
    try {
      item = JSON.parse(raw);
    } catch {
      throw new TerminalError("unreadable");
    }
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new TerminalError("unreadable");
  }
  const oauth = validOauth(item.claudeAiOauth) ? item.claudeAiOauth : undefined;
  const config = await ports.config.read();
  const account =
    config?.oauthAccount && typeof config.oauthAccount === "object"
      ? (config.oauthAccount as JsonObject)
      : undefined;
  const identity =
    oauth &&
    typeof account?.accountUuid === "string" &&
    typeof account.organizationUuid === "string" &&
    UUID.test(account.accountUuid) &&
    UUID.test(account.organizationUuid)
      ? {
          accountUuid: account.accountUuid.toLowerCase(),
          orgId: account.organizationUuid.toLowerCase(),
        }
      : undefined;
  return { raw, item, oauth, account, identity };
}

function describeTerminal(
  reading: Reading,
  known: TerminalIdentity[],
  at: string,
  mismatch = false,
): TerminalCurrent {
  if (!reading.oauth) return { state: "signed-out", at };
  const { identity, account } = reading;
  return {
    state: "signed-in",
    ...(identity ?? {}),
    ...(typeof account?.emailAddress === "string"
      ? { email: account.emailAddress }
      : {}),
    ...(typeof account?.organizationName === "string"
      ? { orgName: account.organizationName }
      : {}),
    known:
      !mismatch && !!identity && known.some((x) => sameIdentity(x, identity)),
    ...(mismatch ? { mismatch: true } : {}),
    at,
  };
}

/** Who the terminal is signed in to, reading only: nothing is saved or written, nothing asked. */
export async function peekTerminal(
  ports: TerminalPorts,
  known: TerminalIdentity[],
  now: () => number = Date.now,
): Promise<TerminalCurrent> {
  try {
    return describeTerminal(
      await readTerminal(ports),
      known,
      new Date(now()).toISOString(),
    );
  } catch {
    return { state: "unreadable", at: new Date(now()).toISOString() };
  }
}

export interface TerminalRequest {
  mode: TerminalMode;
  /** The account to put in place: its identities. */
  target: TerminalIdentity[];
  /** Every Relay account's identities: the only terminal sign-ins ever saved or replaced. */
  known: TerminalIdentity[];
}

type Core = Pick<
  TerminalOutcome,
  "result" | "reason" | "saved" | "current" | "unconfirmed"
>;

/** What `keep` did with a reading. */
type Kept = "saved" | "same" | "not-known" | "mismatch" | "unverified";

/**
 * Keeps the terminal's Claude Code sign-in with the account: at a switch it saves the sign-in
 * the terminal holds, under the account and organization it names, and puts the target's saved
 * one in place. Claude Code reads the stored sign-in again before every renewal and adopts one
 * that changed, so a running terminal session never uses up a sign-in put away here. Never throws.
 */
export class TerminalSwitcher {
  constructor(
    private readonly ports: TerminalPorts,
    private readonly vault: TerminalVault,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Whether the token really is the account `~/.claude.json` names: that file and the Keychain
   * item are written apart (a sign-in by hand, a session saving a cached copy), so the file
   * alone can name the wrong account. "unknown" when the token cannot be asked about.
   */
  private async verify(
    reading: Reading,
  ): Promise<"match" | "mismatch" | "unknown"> {
    const { oauth, identity } = reading;
    if (!oauth || !identity || !this.ports.owner) return "unknown";
    if (
      typeof oauth.expiresAt === "number" &&
      oauth.expiresAt <= this.now() + VERIFY_MARGIN_MS
    )
      return "unknown";
    const owner = await this.ports
      .owner(oauth.accessToken)
      .catch(() => undefined);
    if (!owner) return "unknown";
    return sameIdentity(owner, identity) ? "match" : "mismatch";
  }

  /**
   * Saves the reading for its account when that is one of Relay's, it differs from the saved
   * copy and its token is verified to be that account's. A switch (`parked`) also keeps a token
   * that cannot be asked about: it is expired, so it is no sign-in made a moment ago, or the Mac
   * is offline, and it is taken away under Claude Code's lock either way, unless a copy taken away
   * at an earlier switch is saved: that one is not replaced by a token that cannot be asked about.
   */
  private async keep(
    reading: Reading,
    known: TerminalIdentity[],
    parked: boolean,
  ): Promise<Kept> {
    const { identity, oauth, account } = reading;
    if (
      !identity ||
      !oauth ||
      !account ||
      !known.some((x) => sameIdentity(x, identity))
    )
      return "not-known";
    const saved = await this.vault.load([identity]).catch(() => undefined);
    // Claude Code rewrites the account's details (profileFetchedAt and the like) on its own;
    // only a new credential is worth a new copy, unless a check's copy is now taken away.
    if (
      saved &&
      fingerprint(saved.oauth) === fingerprint(oauth) &&
      (saved.parked || !parked)
    )
      return "same";
    const verified = await this.verify(reading);
    if (verified === "mismatch") return "mismatch";
    if (verified === "unknown" && !parked) return "unverified";
    // A copy taken away at an earlier switch is the only good one. A token nobody can vouch for
    // (a write that stopped between the Keychain and the config can leave another account's) must
    // not replace it.
    if (verified === "unknown" && saved?.parked) return "unverified";
    await this.vault.save(identity, oauth, account, parked);
    return "saved";
  }

  /**
   * Who the terminal is signed in to, saving that sign-in when it is one of Relay's accounts:
   * signing the terminal in once is how an account is linked. Writes nothing to Claude Code.
   */
  async check(
    request: Pick<TerminalRequest, "mode" | "known">,
  ): Promise<TerminalCurrent | undefined> {
    if (request.mode === "off") return undefined;
    const at = () => new Date(this.now()).toISOString();
    try {
      // Under Claude Code's lock, so a swap or a renewal half done is never read as one sign-in.
      return await this.ports.lock(async () => {
        const reading = await readTerminal(this.ports);
        let kept: Kept = "not-known";
        try {
          kept = await this.keep(reading, request.known, false);
        } catch {
          // Not saved this time (the vault is not ready); who it is was still read.
        }
        return describeTerminal(
          reading,
          request.known,
          at(),
          kept === "mismatch",
        );
      });
    } catch (error) {
      // Busy renewing: say who it is, and save it at the next check.
      if (error instanceof TerminalError && error.reason === "busy")
        return peekTerminal(this.ports, request.known, this.now);
      return { state: "unreadable", at: at() };
    }
  }

  async run(request: TerminalRequest): Promise<TerminalOutcome> {
    const at = new Date(this.now()).toISOString();
    if (request.mode === "off")
      return { result: "skipped", reason: "off", saved: false, at };
    try {
      return { ...(await this.ports.lock(() => this.swap(request))), at };
    } catch (error) {
      const reason =
        error instanceof TerminalError ? error.reason : "unreadable";
      return {
        result: reason === "busy" ? "skipped" : "failed",
        reason,
        saved: false,
        at,
      };
    }
  }

  private async swap(request: TerminalRequest): Promise<Core> {
    const reading = await readTerminal(this.ports);
    const at = new Date(this.now()).toISOString();
    const current = describeTerminal(reading, request.known, at);
    // A sign-in Relay cannot name would be lost by the swap: it is saved nowhere.
    if (reading.oauth && !current.known)
      return {
        result: "skipped",
        reason: "unknown-account",
        saved: false,
        current,
      };
    if (
      reading.identity &&
      request.target.some((x) => sameIdentity(x, reading.identity!))
    ) {
      const kept = await this.keep(reading, request.known, false);
      return {
        result: kept === "saved" ? "saved" : "unchanged",
        reason: kept === "mismatch" ? "mismatch" : "already-there",
        saved: kept === "saved",
        current: describeTerminal(
          reading,
          request.known,
          at,
          kept === "mismatch",
        ),
      };
    }
    const kept = await this.keep(reading, request.known, true);
    if (kept === "mismatch")
      return {
        result: "skipped",
        reason: "mismatch",
        saved: false,
        current: describeTerminal(reading, request.known, at, true),
      };
    const saved = kept === "saved";
    const wanted = await this.vault.load(request.target);
    if (!wanted)
      return {
        result: saved ? "saved" : "unchanged",
        reason: "no-saved-login",
        saved,
        current,
      };
    // Only the Claude sign-in changes: MCP servers' sign-ins in the same item stay.
    const text = JSON.stringify({
      ...reading.item,
      claudeAiOauth: wanted.oauth,
    });
    try {
      await this.ports.keychain.write(text);
      const back = await this.ports.keychain.read();
      if (
        fingerprint(back ? JSON.parse(back).claudeAiOauth : undefined) !==
        fingerprint(wanted.oauth)
      )
        throw new TerminalError("write-failed");
      // Last, and replaced whole by a rename: when it fails the config is as it was.
      await this.ports.config.writeAccount(wanted.account);
    } catch {
      try {
        if (reading.raw === undefined) await this.ports.keychain.remove();
        else await this.ports.keychain.write(reading.raw);
        if ((await this.ports.keychain.read()) !== reading.raw)
          throw new TerminalError("restore-failed");
      } catch {
        return { result: "failed", reason: "restore-failed", saved, current };
      }
      return { result: "failed", reason: "write-failed", saved, current };
    }
    // In use again: Claude Code will renew it, so the vault's copy no longer counts as the only one.
    await this.vault
      .save(wanted, wanted.oauth, wanted.account, false)
      .catch(() => undefined);
    return {
      result: "switched",
      saved,
      // Saved by a check and never taken away at a switch: the account left the terminal by a
      // sign-in by hand, after which Claude Code may have renewed this copy's refresh token away.
      ...(wanted.parked ? {} : { unconfirmed: true }),
      current: {
        state: "signed-in",
        accountUuid: wanted.accountUuid,
        orgId: wanted.orgId,
        ...(typeof wanted.account.emailAddress === "string"
          ? { email: wanted.account.emailAddress }
          : {}),
        ...(typeof wanted.account.organizationName === "string"
          ? { orgName: wanted.account.organizationName }
          : {}),
        known: true,
        at: new Date(this.now()).toISOString(),
      },
    };
  }
}
