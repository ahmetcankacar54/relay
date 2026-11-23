import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readBytes, writeBytes } from "./desktop-files";
import { signedOut } from "./profile-auth";
import {
  accountSchema,
  privateDir,
  proxyConfigSchema,
  settingsSchema,
  type Store,
} from "./store";
import { securityKeychain } from "./terminal-identity";
import { credentialService } from "./usage-credentials";
import type { Sealer } from "./vault-crypto";
import {
  BACKUP_EXTENSION,
  MIN_BACKUP_PASSPHRASE,
  type BackupImportMode,
  type BackupImportResult,
  type BackupSummary,
} from "../../shared/backup";
import { needsRiskAck } from "../../shared/feature-risk";
import type { ProxyConfig } from "../../shared/proxy-types";
import type { Account, RelaySettings } from "../../shared/types";

/**
 * An account backup (`.relaybackup`): a 36-byte header, then the AES-256-GCM ciphertext of one
 * JSON payload and its 16-byte tag. The header is `RLYB`, the format, scrypt's log2(N), r and p,
 * a 16-byte salt and a 12-byte nonce; it is authenticated with the payload, so a changed
 * parameter fails like a changed byte of the payload. The key is scrypt(passphrase, salt): the
 * file opens on any computer that has the passphrase, and on none without it.
 */
export const BACKUP_MAGIC = Buffer.from("RLYB");
/** Raised when the payload or the header changes meaning; an older Relay refuses a newer file. */
export const BACKUP_FORMAT = 1;
const HEADER = 36;
const SALT = 16;
const NONCE = 12;
const TAG = 16;
/** Larger than any real backup (50 accounts' sign-ins and Claude Code configs). */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
/** One profile file larger than this stays out; a config grown that large is not a sign-in. */
const MAX_PROFILE_FILE = 8 * 1024 * 1024;

export interface ScryptParams {
  logN: number;
  r: number;
  p: number;
}
/** 128 MiB and about half a second on a current Mac: slow to guess, quick to open once. */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 17, r: 8, p: 1 };
/** The most memory a file may make scrypt use: a crafted header cannot exhaust the computer. */
const MAX_SCRYPT_MEMORY = 256 * 1024 * 1024;

export type BackupErrorReason =
  | "not-a-backup"
  | "newer-format"
  | "wrong-passphrase"
  | "damaged"
  | "too-large"
  | "short-passphrase";

/** Why a backup could not be written or opened; main words each reason in the app's language. */
export class BackupError extends Error {
  constructor(readonly reason: BackupErrorReason) {
    super(
      {
        "not-a-backup": "This file is not a Relay backup.",
        "newer-format":
          "This backup was made by a newer Relay. Update Relay, then import it.",
        "wrong-passphrase":
          "The passphrase is wrong, or the file was changed after it was saved.",
        damaged: "This backup is damaged.",
        "too-large": "This file is too large to be a Relay backup.",
        "short-passphrase": `The passphrase must be at least ${MIN_BACKUP_PASSPHRASE} characters.`,
      }[reason],
    );
  }
}

/**
 * The profile files that carry a sign-in or the account it names, relative to the profile, with
 * `/` between folders: Claude Code's account config, the Codex sign-in, and CLIProxyAPI's
 * Antigravity OAuth files. Claude Code's own credential travels as `claudeCode`, since macOS keeps
 * it in the Keychain under a name made from the profile's path.
 */
const PROFILE_FILE =
  /^(?:\.claude\.json|\.config\.json|provider-credential\.json|antigravity-oauth\/[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}\.json)$/;
const PROFILE_FILES = [
  ".claude.json",
  ".config.json",
  "provider-credential.json",
];
const OAUTH_DIR = "antigravity-oauth";
const text = z.string().max(MAX_PROFILE_FILE);

/** The gateway's portable settings: never its address (this computer's network) or bound clients. */
const gatewaySchema = z.object({
  port: proxyConfigSchema.shape.port,
  routingStrategy: z.enum(["soonest-reset", "balanced", "strict-priority"]),
  affinityTtlSeconds: z.number().int().min(10).max(3_600),
  accountOrder: z.array(z.string().min(1).max(128)).max(200).optional(),
  excludedAccountIds: z.array(z.string().min(1).max(128)).max(200).optional(),
  subagentOverflow: z.boolean().optional(),
  /** The clients' key: a secret, so only in a backup that holds sign-ins. */
  apiKey: proxyConfigSchema.shape.apiKey,
});
export type BackupGateway = z.infer<typeof gatewaySchema>;

const sessionsSchema = z.object({
  /** Claude app sign-ins, by Claude account uuid, as the vault held them before sealing. */
  desktop: z.record(z.uuid(), text),
  /** Antigravity app sign-ins, by Relay account id. */
  antigravityApp: z.record(z.uuid(), text),
  /** Claude Code's credential JSON, by Relay account id: Keychain item or `.credentials.json`. */
  claudeCode: z.record(z.uuid(), text),
  /** Profile files (`PROFILE_FILE`), base64, by Relay account id. */
  files: z.record(
    z.uuid(),
    z.record(
      z.string().regex(PROFILE_FILE),
      z.string().max(MAX_PROFILE_FILE * 2),
    ),
  ),
});
type Sessions = z.infer<typeof sessionsSchema>;

const payloadSchema = z.object({
  kind: z.literal("relay-backup"),
  createdAt: z.iso.datetime(),
  relayVersion: z.string().max(40),
  platform: z.string().max(20),
  /** Settings without the gateway, the accepted risk notes and the login item: see `portableSettings`. */
  settings: z.record(z.string(), z.unknown()),
  accounts: z.array(accountSchema).max(50),
  gateway: gatewaySchema.optional(),
  sessions: sessionsSchema.optional(),
});
export type BackupPayload = z.infer<typeof payloadSchema>;

/** An opened backup: its payload, and the key it was opened with, to seal the pre-import copy. */
export interface OpenedBackup {
  payload: BackupPayload;
  key: Buffer;
  params: ScryptParams;
  salt: Buffer;
}

/** Claude Code's credential for one isolated profile, wherever this computer keeps it. */
export interface ClaudeCodeSignIns {
  read(profile: string): Promise<string | undefined>;
  write(profile: string, text: string): Promise<void>;
}

/** Where secrets are read from and put back on this computer. */
export interface BackupHost {
  /** Relay's data folder: `desktop-vault/` and `profiles/` are inside it. */
  data: string;
  /** This computer's vault key: unseals on export, seals again on import. */
  sealer: Sealer;
  claudeCode: ClaudeCodeSignIns;
}

/** What is backed up from this computer now. */
export interface BackupSource {
  settings: RelaySettings;
  accounts: readonly Account[];
  /** The gateway as main reads it: the registry's settings with proxy-pool.json's. */
  gateway: ProxyConfig;
}

export interface BackupContext {
  host: BackupHost;
  relayVersion: string;
  platform: string;
  now: () => number;
}

const profileOf = (host: BackupHost, accountId: string) =>
  path.join(host.data, "profiles", accountId);
const vaultOf = (host: BackupHost) => path.join(host.data, "desktop-vault");

function checkParams({ logN, r, p }: ScryptParams) {
  const ok =
    Number.isInteger(logN) &&
    logN >= 10 &&
    logN <= 20 &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= 32 &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= 16 &&
    128 * 2 ** logN * r <= MAX_SCRYPT_MEMORY;
  if (!ok) throw new BackupError("damaged");
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  checkParams(params);
  const N = 2 ** params.logN;
  return new Promise((resolve, reject) =>
    crypto.scrypt(
      passphrase.normalize("NFC"),
      salt,
      32,
      { N, r: params.r, p: params.p, maxmem: 2 * 128 * N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

/** Seals the payload under `key`; the salt and parameters go in the header for opening. */
export function sealWithKey(
  payload: BackupPayload,
  key: Buffer,
  params: ScryptParams,
  salt: Buffer,
): Buffer {
  const nonce = crypto.randomBytes(NONCE);
  const header = Buffer.concat([
    BACKUP_MAGIC,
    Buffer.from([BACKUP_FORMAT, params.logN, params.r, params.p]),
    salt,
    nonce,
  ]);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** A new backup file: a fresh salt, the key from the passphrase, the payload sealed under it. */
export async function sealBackup(
  payload: BackupPayload,
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<Buffer> {
  if ([...passphrase].length < MIN_BACKUP_PASSPHRASE)
    throw new BackupError("short-passphrase");
  const salt = crypto.randomBytes(SALT);
  return sealWithKey(
    payload,
    await deriveKey(passphrase, salt, params),
    params,
    salt,
  );
}

/**
 * Checks what can be checked without the passphrase: the size, the magic and the format. A file
 * picked for import is refused here, before the user types anything.
 */
export function readBackupHeader(file: Buffer): {
  params: ScryptParams;
  salt: Buffer;
  nonce: Buffer;
} {
  if (file.length > MAX_BACKUP_BYTES) throw new BackupError("too-large");
  if (file.length < 4 || !file.subarray(0, 4).equals(BACKUP_MAGIC))
    throw new BackupError("not-a-backup");
  if (file.length < HEADER + TAG) throw new BackupError("damaged");
  if (file[4] > BACKUP_FORMAT) throw new BackupError("newer-format");
  if (file[4] !== BACKUP_FORMAT) throw new BackupError("damaged");
  const params = { logN: file[5], r: file[6], p: file[7] };
  checkParams(params);
  return {
    params,
    salt: file.subarray(8, 8 + SALT),
    nonce: file.subarray(8 + SALT, HEADER),
  };
}

/**
 * Opens a backup. A wrong passphrase and a changed file fail the same way (the GCM tag), and
 * nothing of the payload is used before the tag checked.
 */
export async function openBackup(
  file: Buffer,
  passphrase: string,
): Promise<OpenedBackup> {
  const { params, salt, nonce } = readBackupHeader(file);
  const key = await deriveKey(passphrase, salt, params);
  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(file.subarray(0, HEADER));
    decipher.setAuthTag(file.subarray(file.length - TAG));
    plain = Buffer.concat([
      decipher.update(file.subarray(HEADER, file.length - TAG)),
      decipher.final(),
    ]);
  } catch {
    throw new BackupError("wrong-passphrase");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new BackupError("damaged");
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw new BackupError("damaged");
  return { payload: parsed.data, key, params, salt: Buffer.from(salt) };
}

/**
 * The settings a backup carries: every one but the gateway (it travels apart, without this
 * computer's address), the accepted risk notes (each computer asks once) and the login item
 * (the system's, set on each computer).
 */
function portableSettings(settings: RelaySettings): Record<string, unknown> {
  const {
    proxy: _proxy,
    riskAcknowledged: _risks,
    launchAtLogin: _login,
    ...rest
  } = settings;
  return rest;
}

function portableGateway(config: ProxyConfig, withKey: boolean): BackupGateway {
  return gatewaySchema.parse({
    port: config.port,
    routingStrategy: config.routingStrategy,
    affinityTtlSeconds: config.affinityTtlSeconds,
    ...(config.accountOrder ? { accountOrder: config.accountOrder } : {}),
    ...(config.excludedAccountIds
      ? { excludedAccountIds: config.excludedAccountIds }
      : {}),
    ...(config.subagentOverflow ? { subagentOverflow: true } : {}),
    ...(withKey && config.apiKey ? { apiKey: config.apiKey } : {}),
  });
}

/** A sealed vault file's text; undefined when there is none or this key cannot open it. */
async function unsealed(
  host: BackupHost,
  relative: string,
): Promise<string | undefined> {
  try {
    const data = await readBytes(vaultOf(host), relative);
    return data ? host.sealer.unseal(data) : undefined;
  } catch {
    return undefined;
  }
}

/** The profile's portable files, base64 by relative path; a missing, linked or oversized one is left out. */
async function profileFiles(profile: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let oauth: string[] = [];
  try {
    oauth = (await fsp.readdir(path.join(profile, OAUTH_DIR))).map(
      (name) => `${OAUTH_DIR}/${name}`,
    );
  } catch {
    // No Antigravity sign-in in this profile.
  }
  for (const relative of [...PROFILE_FILES, ...oauth]) {
    if (!PROFILE_FILE.test(relative)) continue;
    try {
      const data = await readBytes(profile, relative);
      if (data && data.length <= MAX_PROFILE_FILE)
        out[relative] = data.toString("base64");
    } catch {
      // A linked or unreadable file stays out.
    }
  }
  return out;
}

const hasSignIn = (sessions: Sessions | undefined, account: Account) =>
  !!sessions &&
  (!!(account.desktop && sessions.desktop[account.desktop.accountUuid]) ||
    !!sessions.antigravityApp[account.id] ||
    !!sessions.claudeCode[account.id] ||
    Object.keys(sessions.files[account.id] ?? {}).some(
      (name) =>
        name === "provider-credential.json" || name.startsWith(`${OAUTH_DIR}/`),
    ));

/**
 * What a backup of this computer holds. With `includeSignIns`, every saved sign-in Relay can read
 * is unsealed into it (a damaged or locked one is left out, never failing the backup).
 */
export async function collectBackup(
  source: BackupSource,
  includeSignIns: boolean,
  context: BackupContext,
): Promise<BackupPayload> {
  const accounts = source.accounts.map((account) =>
    accountSchema.parse(account),
  ) as Account[];
  let sessions: Sessions | undefined;
  if (includeSignIns) {
    const { host } = context;
    sessions = { desktop: {}, antigravityApp: {}, claudeCode: {}, files: {} };
    for (const account of accounts) {
      const uuid = account.desktop?.accountUuid;
      if (uuid) {
        const login = await unsealed(host, `accounts/${uuid}.bin`);
        if (login) sessions.desktop[uuid] = login;
      }
      const antigravity = await unsealed(
        host,
        `antigravity-app/${account.id.toLowerCase()}.bin`,
      );
      if (antigravity) sessions.antigravityApp[account.id] = antigravity;
      const profile = profileOf(host, account.id);
      const credential = await host.claudeCode
        .read(profile)
        .catch(() => undefined);
      if (credential) sessions.claudeCode[account.id] = credential;
      const files = await profileFiles(profile);
      if (Object.keys(files).length) sessions.files[account.id] = files;
    }
  }
  return payloadSchema.parse({
    kind: "relay-backup",
    createdAt: new Date(context.now()).toISOString(),
    relayVersion: context.relayVersion,
    platform: context.platform,
    settings: portableSettings(source.settings),
    accounts,
    gateway: portableGateway(source.gateway, includeSignIns),
    ...(sessions ? { sessions } : {}),
  });
}

/** The account here that `account` is: the same Relay id, or the same Claude app account. */
function presentAs(account: Account, current: readonly Account[]) {
  return current.find(
    (here) =>
      here.id === account.id ||
      (!!account.desktop &&
        here.desktop?.accountUuid.toLowerCase() ===
          account.desktop.accountUuid.toLowerCase()),
  );
}

/** What the opened backup holds, against the accounts here now. */
export function summarizeBackup(
  payload: BackupPayload,
  current: readonly Account[],
): BackupSummary {
  return {
    createdAt: payload.createdAt,
    relayVersion: payload.relayVersion,
    platform: payload.platform,
    signIns: !!payload.sessions,
    currentAccounts: current.length,
    accounts: payload.accounts.map((account) => ({
      name: account.name,
      provider: account.provider ?? "claude",
      signIn: hasSignIn(payload.sessions, account as Account),
      present: !!presentAs(account as Account, current),
    })),
  };
}

/**
 * Puts the accounts' sign-ins from `sessions` back, sealed with this computer's key. A merge
 * (`overwrite` false) never replaces a Claude app sign-in kept here: it may be newer. Each failure
 * is counted and the rest go on.
 */
async function restoreSignIns(
  sessions: Sessions,
  accounts: readonly Account[],
  host: BackupHost,
  overwrite: boolean,
): Promise<{ restored: number; failed: number }> {
  let restored = 0;
  let failed = 0;
  const vault = vaultOf(host);
  for (const account of accounts) {
    const steps: (() => Promise<void>)[] = [];
    const uuid = account.desktop?.accountUuid;
    const login = uuid ? sessions.desktop[uuid] : undefined;
    if (uuid && login)
      steps.push(async () => {
        const relative = `accounts/${uuid}.bin`;
        if (!overwrite && (await readBytes(vault, relative))) return;
        await writeBytes(vault, relative, host.sealer.seal(login));
      });
    const antigravity = sessions.antigravityApp[account.id];
    if (antigravity)
      steps.push(() =>
        writeBytes(
          vault,
          `antigravity-app/${account.id.toLowerCase()}.bin`,
          host.sealer.seal(antigravity),
        ),
      );
    const profile = profileOf(host, account.id);
    const credential = sessions.claudeCode[account.id];
    if (credential)
      steps.push(() => host.claudeCode.write(profile, credential));
    for (const [relative, data] of Object.entries(
      sessions.files[account.id] ?? {},
    ))
      steps.push(() =>
        writeBytes(
          profile,
          path.join(...relative.split("/")),
          Buffer.from(data, "base64"),
        ),
      );
    if (!steps.length) continue;
    let ok = true;
    for (const step of steps)
      await step().catch(() => {
        ok = false;
      });
    if (ok) restored++;
    else failed++;
  }
  return { restored, failed };
}

/**
 * Parses settings a backup carries over this computer's, so a field an older Relay never wrote
 * keeps its value here; a field a newer Relay wrote and this one does not know is dropped. The
 * gateway, the accepted risk notes and the login item stay this computer's, and early start comes
 * over off until its risk was accepted here: a backup never turns a risky feature on by itself.
 */
function importedSettings(
  saved: Record<string, unknown>,
  current: RelaySettings,
): RelaySettings {
  const value: Record<string, unknown> = {
    ...current,
    ...saved,
    proxy: current.proxy,
    riskAcknowledged: current.riskAcknowledged,
    launchAtLogin: current.launchAtLogin,
  };
  for (const key of Object.keys(value))
    if (value[key] === undefined) delete value[key];
  for (let round = 0; round < 20; round++) {
    const result = settingsSchema.safeParse(value);
    if (result.success) {
      const settings = result.data as RelaySettings;
      return settings.planning.autoStart && needsRiskAck(current, "early-start")
        ? { ...settings, planning: { ...settings.planning, autoStart: false } }
        : settings;
    }
    let dropped = false;
    for (const issue of result.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      let at: unknown = value;
      for (const key of issue.path)
        at =
          at && typeof at === "object"
            ? (at as Record<PropertyKey, unknown>)[key]
            : undefined;
      if (!at || typeof at !== "object") continue;
      const object = at as Record<string, unknown>;
      for (const key of issue.keys) delete object[key];
      dropped = true;
    }
    if (!dropped) break;
  }
  throw new BackupError("damaged");
}

const stamp = (at: number) => new Date(at).toISOString().replace(/[:.]/g, "-");

/**
 * Brings an opened backup in. A merge adds the accounts not here yet (by id or Claude app account,
 * up to 50) with their sign-ins and keeps everything else. A replace first saves what is here as a
 * backup sealed with the same passphrase (`relay-backups/` in Relay's folder, sign-ins included),
 * then takes the file's accounts and settings; the files of accounts it drops stay on disk, so
 * importing that copy brings them back whole. Answers what was done and, for a replace, the
 * gateway settings main applies through its own calls.
 */
export async function importBackup(
  opened: OpenedBackup,
  mode: BackupImportMode,
  store: Pick<Store, "state" | "update">,
  currentGateway: ProxyConfig,
  context: BackupContext,
): Promise<{ result: BackupImportResult; gateway?: BackupGateway }> {
  const { payload } = opened;
  const { host } = context;
  let before: string | undefined;
  if (mode === "replace") {
    const copy = await collectBackup(
      {
        settings: store.state.settings,
        accounts: store.state.accounts,
        gateway: currentGateway,
      },
      true,
      context,
    );
    const dir = path.join(host.data, "relay-backups");
    privateDir(dir);
    before = `before-import-${stamp(context.now())}.${BACKUP_EXTENSION}`;
    await fsp.writeFile(
      path.join(dir, before),
      sealWithKey(copy, opened.key, opened.params, opened.salt),
      {
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  const current = store.state.accounts;
  let incoming = payload.accounts as Account[];
  let skipped = 0;
  if (mode === "merge") {
    const room = Math.max(0, 50 - current.length);
    const fresh = incoming.filter((account) => !presentAs(account, current));
    skipped = incoming.length - Math.min(fresh.length, room);
    incoming = fresh.slice(0, room);
  }
  const restored = payload.sessions
    ? await restoreSignIns(payload.sessions, incoming, host, mode === "replace")
    : { restored: 0, failed: 0 };
  const checkedAt = new Date(context.now()).toISOString();
  const accounts: Account[] = [];
  for (const account of incoming) {
    const profile = profileOf(host, account.id);
    const hadProfile = await fsp.stat(profile).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    privateDir(profile);
    // An account that came without a sign-in, and has none here, is signed out until it signs in.
    accounts.push(
      account.auth?.loggedIn &&
        !hadProfile &&
        !hasSignIn(payload.sessions, account)
        ? { ...account, auth: signedOut(account.auth, checkedAt) }
        : account,
    );
  }
  store.update((state) => {
    if (mode === "replace") {
      state.settings = importedSettings(payload.settings, state.settings);
      state.accounts = accounts;
    } else state.accounts.push(...accounts);
  });
  return {
    result: {
      mode,
      added: accounts.length,
      skipped,
      signIns: restored.restored,
      signInsFailed: restored.failed,
      ...(before ? { before } : {}),
    },
    ...(mode === "replace" && payload.gateway
      ? { gateway: payload.gateway }
      : {}),
  };
}

/**
 * Claude Code's credential for a Relay profile on this computer: on macOS the Keychain item named
 * after the profile's path (through `/usr/bin/security`, Claude Code's trusted tool, so no dialog),
 * else, and when macOS has none, the profile's `.credentials.json`. Written back the same way, so a
 * credential from a Mac lands in a Linux profile's file and the other way round.
 */
export function claudeCodeSignIns(
  platform: NodeJS.Platform = process.platform,
): ClaudeCodeSignIns {
  const file = ".credentials.json";
  const readFile = async (profile: string) =>
    (await readBytes(profile, file))?.toString("utf8") || undefined;
  return {
    async read(profile) {
      if (platform === "darwin") {
        const item = await securityKeychain(
          undefined,
          undefined,
          credentialService(profile),
        ).read();
        if (item) return item;
      }
      return readFile(profile);
    },
    async write(profile, value) {
      if (platform === "darwin") {
        const keychain = securityKeychain(
          undefined,
          undefined,
          credentialService(profile),
        );
        await keychain.write(value);
        if ((await keychain.read()) !== value)
          throw new Error("The Keychain did not keep the Claude Code sign-in.");
        return;
      }
      await writeBytes(profile, file, Buffer.from(value, "utf8"));
    },
  };
}
