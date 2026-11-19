import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { UsageError } from "./usage-credentials";
import type { SafeStoragePassword } from "./desktop-usage";

/**
 * Claude's cookie key on Linux. Electron gives Chromium's FreedesktopSecretKeyProvider the app's
 * name, so the secret is "Claude Safe Storage" in KWallet's "Claude Keys" folder, or the Secret
 * Service item whose `application` is "Claude". Cookies written with it start with `v11`; with no
 * keyring (`--password-store=basic`) they start with `v10` and use Chromium's fixed "peanuts".
 * Both keys are PBKDF2-SHA1 with one iteration, unlike macOS's 1003.
 */

export const LINUX_APP_NAME = "Claude";
/** Chromium's libsecret schema for the Safe Storage secret. */
const SECRET_SCHEMA = "chrome_libsecret_os_crypt_password_v2";
/** The id Relay gives KWallet; its access dialog names it. */
const KWALLET_APP_ID = "Relay";

/** Chromium's Linux cookie key: PBKDF2-SHA1, one iteration, of the keyring secret. */
export function linuxCookieKey(secret: string): Buffer {
  return crypto.pbkdf2Sync(secret, "saltysalt", 1, 16, "sha1");
}

/** The `v10` key: no keyring, Chromium's fixed password. */
export const LINUX_V10_KEY = linuxCookieKey("peanuts");

export type LinuxKeyring =
  | { kind: "kwallet"; service: string; objectPath: string }
  | { kind: "secret-service" };

/**
 * The keyring Chromium picks without `--password-store`, as `base::nix::GetDesktopEnvironment`
 * decides: KDE's own kwalletd by its session version, the Secret Service everywhere else.
 */
export function linuxKeyring(env: NodeJS.ProcessEnv = process.env): LinuxKeyring {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((d) => d.trim().toUpperCase());
  const kde =
    desktops.includes("KDE") ||
    (!env.XDG_CURRENT_DESKTOP && /^(kde|plasma)/i.test(env.DESKTOP_SESSION ?? ""));
  if (!kde) return { kind: "secret-service" };
  const daemon =
    env.KDE_SESSION_VERSION === "6"
      ? "kwalletd6"
      : env.KDE_SESSION_VERSION === "5"
        ? "kwalletd5"
        : "kwalletd";
  return { kind: "kwallet", service: `org.kde.${daemon}`, objectPath: `/modules/${daemon}` };
}

const BUSCTL = "/usr/bin/busctl";
const SECRET_TOOL = "secret-tool";

/** An executable on PATH (or an absolute path), as `execFile` would find it. */
function onPath(file: string, env: NodeJS.ProcessEnv): boolean {
  const dirs = path.isAbsolute(file) ? [""] : (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, file), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Whether the tool that reads this desktop's keyring is installed. */
export function linuxKeyringReachable(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = (file) => onPath(file, env),
): boolean {
  return exists(linuxKeyring(env).kind === "kwallet" ? BUSCTL : SECRET_TOOL);
}

export interface RunResult {
  /** Exit status or spawn error code; undefined on success. */
  code?: number | string;
  stdout: string;
  stderr: string;
}
export type Run = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const run: Run = (file, args, timeoutMs) =>
  new Promise((resolve) =>
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16_384, windowsHide: true },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as NodeJS.ErrnoException).code ?? "failed") : undefined,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    ),
  );

/**
 * Reads Claude's Safe Storage secret from the desktop's keyring. Like the macOS reader, a
 * background read is only tried once the user has allowed it (`allowed`); a closed KWallet is
 * never opened in the background either, since that would show its unlock dialog. Every call is
 * bounded, so a dialog nobody answers ends as `keychain-locked`.
 */
export function linuxSafeStoragePassword(options: {
  allowed: () => Promise<boolean>;
  remember: (allowed: boolean) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  run?: Run;
}): SafeStoragePassword {
  const exec = options.run ?? run;
  let cached: string | undefined;
  return async (allowPrompt) => {
    if (cached) return cached;
    if (!allowPrompt && !(await options.allowed().catch(() => false)))
      throw new UsageError("keychain-locked", undefined, "desktop: keyring not allowed yet");
    const keyring = linuxKeyring(options.env ?? process.env);
    const timeout = allowPrompt ? 120_000 : 15_000;
    let secret: string;
    try {
      secret =
        keyring.kind === "kwallet"
          ? await kwalletSecret(exec, keyring, allowPrompt, timeout)
          : await secretServiceSecret(exec, timeout);
    } catch (error) {
      // A wallet still closed after login says nothing about the user's consent: keep it.
      if (error instanceof UsageError && error.issue === "keychain-locked" && error.detail !== WALLET_CLOSED)
        await options.remember(false).catch(() => {});
      throw error;
    }
    cached = secret;
    await options.remember(true).catch(() => {});
    return secret;
  };
}

const locked = (detail: string) => new UsageError("keychain-locked", undefined, `desktop: ${detail}`);
const WALLET_CLOSED = "desktop: kwallet closed";
const missing = () =>
  new UsageError("credentials-missing", undefined, "desktop: no Claude Safe Storage secret");

/** One KWallet D-Bus call through `busctl`, answered as JSON; its single value. */
async function kwalletCall(
  exec: Run,
  keyring: Extract<LinuxKeyring, { kind: "kwallet" }>,
  timeoutMs: number,
  method: string,
  signature: string,
  ...args: string[]
): Promise<unknown> {
  const seconds = Math.ceil(timeoutMs / 1000);
  const result = await exec(
    BUSCTL,
    [
      "--user",
      "--json=short",
      `--timeout=${seconds}`,
      "call",
      keyring.service,
      keyring.objectPath,
      "org.kde.KWallet",
      method,
      ...(signature ? [signature, ...args] : []),
    ],
    timeoutMs + 2_000,
  );
  if (result.code !== undefined) throw locked(`kwallet ${method} exit ${result.code}`);
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw locked(`kwallet ${method} unreadable answer`);
  }
  // busctl's JSON: {"type":"s","data":["kdewallet"]}.
  return answer && typeof answer === "object" && "data" in answer && Array.isArray(answer.data)
    ? answer.data[0]
    : undefined;
}

async function kwalletSecret(
  exec: Run,
  keyring: Extract<LinuxKeyring, { kind: "kwallet" }>,
  allowPrompt: boolean,
  timeout: number,
): Promise<string> {
  const quick = 5_000;
  const wallet = await kwalletCall(exec, keyring, quick, "networkWallet", "");
  if (typeof wallet !== "string" || !wallet) throw locked("kwallet has no wallet");
  if (!allowPrompt && (await kwalletCall(exec, keyring, quick, "isOpen", "s", wallet)) !== true)
    throw new UsageError("keychain-locked", undefined, WALLET_CLOSED);
  const handle = await kwalletCall(exec, keyring, timeout, "open", "sxs", wallet, "0", KWALLET_APP_ID);
  if (typeof handle !== "number" || handle < 0) throw locked("kwallet open refused");
  const folder = `${LINUX_APP_NAME} Keys`;
  const key = `${LINUX_APP_NAME} Safe Storage`;
  try {
    const has = await kwalletCall(exec, keyring, quick, "hasEntry", "isss", String(handle), folder, key, KWALLET_APP_ID);
    if (has !== true) throw missing();
    const secret = await kwalletCall(exec, keyring, quick, "readPassword", "isss", String(handle), folder, key, KWALLET_APP_ID);
    if (typeof secret !== "string" || !secret) throw locked("kwallet empty secret");
    return secret;
  } finally {
    // Only Relay's own handle; the wallet stays open for everyone else.
    await kwalletCall(exec, keyring, quick, "close", "ibs", String(handle), "false", KWALLET_APP_ID).catch(() => {});
  }
}

async function secretServiceSecret(exec: Run, timeout: number): Promise<string> {
  const result = await exec(
    SECRET_TOOL,
    ["lookup", "xdg:schema", SECRET_SCHEMA, "application", LINUX_APP_NAME],
    timeout,
  );
  // No match: exit 1 and nothing said. Anything else is a locked or unreachable keyring.
  if (result.code === 1 && !result.stdout && !result.stderr.trim()) throw missing();
  // secret-tool ends the secret with a newline only on a terminal; Chromium's never holds one.
  const secret = result.stdout.replace(/\n$/, "");
  if (result.code !== undefined || !secret) throw locked(`secret-tool exit ${result.code}`);
  return secret;
}
