import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Settings → Advanced → Remove Relay's data, in two steps. The first runs in the running Relay:
 * it stops what lives outside the data folder (the gateway, the clients bound to it, the login
 * item, Relay's own Keychain items), leaves a marker, and relaunches. The second runs at the very
 * start of the next launch, before the crash reporter or Chromium opens the folder, and removes
 * everything in it, so nothing is open while it goes and no timer writes a file back. Claude's own
 * data is never in that folder: the Claude app stays signed in to the account it is on.
 */
export const RESET_MARKER = ".relay-reset-pending";

/** Why the reset was refused; nothing was changed. */
export class ResetRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The running Relay's side of the first step; main implements it, tests fake it. */
export interface ResetPorts {
  /** Relay's data folder (Electron's userData). */
  root: string;
  /** Why the reset must wait (a Desktop operation, a running terminal, a sign-in), or undefined. */
  busy(): string | undefined;
  stopGateway(): Promise<void>;
  /** Gives each client bound to the gateway its own settings back. */
  unbindClients(): Promise<void>;
  removeLoginItem(): Promise<void>;
  /** Relay's secrets outside the folder: the vault key and the profiles' Claude Code Keychain items. */
  removeSecrets(): Promise<void>;
  /** Quits and opens Relay again; the next launch finishes the reset. */
  relaunch(): void;
}

/** The parts of node:fs the second step uses, so a test can watch every removal. */
export interface ResetFs {
  existsSync(file: string): boolean;
  readdirSync(dir: string): string[];
  rmSync(file: string, options: { recursive: true; force: true }): void;
  writeFileSync(file: string, data: string, options: { mode: number }): void;
}

/**
 * A folder the reset may empty: absolute, and neither the filesystem's root, the home folder nor
 * one of its parents. The data folder is always deeper; this keeps a wrong override from wiping
 * more than Relay's own.
 */
export function safeResetRoot(root: string, home = os.homedir()): boolean {
  if (!path.isAbsolute(root)) return false;
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return false;
  const relative = path.relative(resolved, path.resolve(home));
  return relative.startsWith("..") || path.isAbsolute(relative);
}

/**
 * The first step. Refused while `busy` names a reason, and nothing is touched then. Every step
 * that reaches outside the folder runs before the marker is written; a failing one stops the reset
 * with nothing deleted, so it can be tried again.
 */
export async function beginReset(
  ports: ResetPorts,
  fsImpl: ResetFs = fs,
): Promise<void> {
  if (!safeResetRoot(ports.root))
    throw new ResetRefused("This folder cannot be reset.");
  const busy = ports.busy();
  if (busy) throw new ResetRefused(busy);
  await ports.stopGateway();
  await ports.unbindClients();
  await ports.removeLoginItem();
  await ports.removeSecrets();
  fsImpl.writeFileSync(
    path.join(ports.root, RESET_MARKER),
    `${JSON.stringify({ at: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  ports.relaunch();
}

/**
 * The second step: when the marker is there, removes every entry of `root` and each of `extra`
 * (the log folder, which macOS keeps outside the data folder). A link is removed, never followed.
 * The marker goes last, and only when everything else went, so an interrupted or refused removal
 * is tried again at the next launch. Answers the paths it removed, or undefined when no reset was
 * pending. Synchronous and never throws: it runs before anything else at launch.
 */
export function finishPendingReset(
  root: string,
  extra: readonly string[] = [],
  fsImpl: ResetFs = fs,
  home = os.homedir(),
): string[] | undefined {
  const marker = path.join(root, RESET_MARKER);
  try {
    if (!safeResetRoot(root, home) || !fsImpl.existsSync(marker))
      return undefined;
  } catch {
    return undefined;
  }
  const removed: string[] = [];
  let complete = true;
  const remove = (target: string) => {
    try {
      fsImpl.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch {
      complete = false;
    }
  };
  let names: string[] = [];
  try {
    names = fsImpl.readdirSync(root);
  } catch {
    complete = false;
  }
  for (const name of names)
    if (name !== RESET_MARKER) remove(path.join(root, name));
  for (const target of extra)
    if (safeResetRoot(target, home) && fsImpl.existsSync(target))
      remove(target);
  if (complete) remove(marker);
  return removed;
}
