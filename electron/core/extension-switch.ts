import {
  browserRunning,
  extensionInstances,
  extensionStorageDir,
  quitBrowser,
  type BrowserSystem,
} from "./browser-system";
import {
  StorageError,
  backupFolder,
  clearScratch,
  restoreFolder,
  type ExtensionStorage,
} from "./extension-storage";
import type { ExtensionVault } from "./extension-vault";
import { signInAccount } from "../../shared/extension-auth";
import {
  chooseInstance,
  type ExtensionCurrent,
  type ExtensionInstance,
  type ExtensionOutcome,
  type ExtensionReason,
  type ExtensionSetting,
} from "../../shared/browser-extension";

export interface ExtensionPorts {
  system: BrowserSystem;
  storage: ExtensionStorage;
  vault: ExtensionVault;
  /** Where a step keeps the backup of the extension's folder while it runs. */
  scratch: string;
  /** Where a check keeps its copy of the extension's folder; apart from `scratch`, which a step clears. */
  peekScratch?: string;
  /** Told the key names (never values) a check found when it found no sign-in. */
  onUnknownLayout?: (names: string[]) => void;
  now?: () => number;
}

export interface ExtensionRequest {
  setting: ExtensionSetting;
  /** May quit a running browser; false for a switch that keeps Claude closed. */
  mayQuit: boolean;
  /** The account to put in place: its Desktop uuid and its own, any that exist. */
  target: string[];
  /** Every Relay account's uuids: the only extension sign-ins ever kept or replaced. */
  known: string[];
}

type Core = Pick<ExtensionOutcome, "result" | "reason" | "saved">;

const lower = (list: string[]) => list.map((value) => value.toLowerCase());

/**
 * Keeps the Claude extension's sign-in with the account. At a switch it saves the sign-in the
 * extension holds, into the vault under the account the extension says it is, and puts the
 * target's saved one in place. The extension's LevelDB can only be used while the browser is
 * closed, so a running browser is quit first (in mode "restart", when the caller allows it) and
 * opened again afterwards. Never throws.
 */
export class ExtensionSwitcher {
  constructor(private readonly ports: ExtensionPorts) {}

  /** Browser profiles that have the extension's storage. */
  instances(): ExtensionInstance[] {
    return extensionInstances(this.ports.system);
  }

  async run(request: ExtensionRequest): Promise<ExtensionOutcome> {
    const { system } = this.ports;
    const at = new Date((this.ports.now ?? Date.now)()).toISOString();
    const done = (
      core: Core,
      extra: { restarted?: boolean; reopened?: boolean } = {},
    ): ExtensionOutcome => ({
      ...core,
      at,
      restarted: false,
      ...extra,
    });
    const skipped = (reason: ExtensionReason) =>
      done({ result: "skipped", reason, saved: false });
    try {
      if (request.setting.mode === "off") return skipped("off");
      const instances = this.instances();
      if (!instances.length) return skipped("not-installed");
      const instance = chooseInstance(instances, request.setting.browser);
      if (!instance) return skipped("choose-instance");
      // Before any browser is quit: without the library nothing could be read or written.
      if (!(await this.ports.storage.available())) return skipped("unavailable");
      let restarted = false;
      if (await browserRunning(system, instance.app)) {
        if (request.setting.mode !== "restart" || !request.mayQuit)
          return skipped("browser-running");
        if (!(await quitBrowser(system, instance.app)))
          return skipped("browser-did-not-quit");
        restarted = true;
      }
      let core: Core;
      try {
        // The database is opened only while no browser runs; asked once more right before.
        core = (await browserRunning(system, instance.app))
          ? { result: "skipped", reason: "browser-running", saved: false }
          : await this.swap(instance, request);
      } catch {
        core = { result: "failed", reason: "unreadable", saved: false };
      }
      if (!restarted) return done(core);
      let reopened = true;
      try {
        await system.launch(instance.app);
      } catch {
        reopened = false;
      }
      return done(core, { restarted, reopened });
    } catch {
      return done({ result: "failed", reason: "unreadable", saved: false });
    }
  }

  /**
   * Who the extension is signed in to, read from a copy of its folder so a running browser is
   * neither quit nor disturbed; the copy is removed before this returns. A sign-in of one of
   * Relay's accounts is saved into the vault: signing in to the extension once and checking is
   * how an account is linked, with no switch. Undefined when the step would not run (mode off,
   * no extension, no library). Never throws.
   */
  async check(request: Pick<ExtensionRequest, "setting" | "known">): Promise<
    ExtensionCurrent | undefined
  > {
    const { system, storage, vault, scratch } = this.ports;
    const at = new Date((this.ports.now ?? Date.now)()).toISOString();
    const peekScratch = this.ports.peekScratch ?? `${scratch}-peek`;
    if (request.setting.mode === "off") return undefined;
    const instance = chooseInstance(this.instances(), request.setting.browser);
    if (!instance) return undefined;
    try {
      if (!(await storage.available())) return undefined;
      await clearScratch(peekScratch);
      const copy = await backupFolder(
        extensionStorageDir(system, instance.app, instance.profile),
        peekScratch,
      );
      const current = await storage.read(copy);
      const account = current && signInAccount(current);
      if (!current || !account) {
        if (this.ports.onUnknownLayout && storage.keyNames)
          this.ports.onUnknownLayout(await storage.keyNames(copy).catch(() => []));
        return { state: "signed-out", at };
      }
      const known = lower(request.known).includes(account);
      if (known) await vault.save(current);
      return { state: "signed-in", accountUuid: account, known, at };
    } catch {
      return { state: "unreadable", at };
    } finally {
      await clearScratch(peekScratch);
    }
  }

  /** The browser is closed. Backs up, saves what the extension holds, puts the target's in. */
  private async swap(
    instance: ExtensionInstance,
    request: ExtensionRequest,
  ): Promise<Core> {
    const { system, storage, vault, scratch } = this.ports;
    const dir = extensionStorageDir(system, instance.app, instance.profile);
    await clearScratch(scratch);
    let keepBackup = false;
    try {
      const backup = await backupFolder(dir, scratch);
      let saved = false;
      let current;
      try {
        current = await storage.read(dir);
      } catch (error) {
        return {
          result: "failed",
          reason: error instanceof StorageError && error.reason === "locked" ? "locked" : "unreadable",
          saved,
        };
      }
      const account = current && signInAccount(current);
      if (current && (!account || !lower(request.known).includes(account)))
        return { result: "skipped", reason: "unknown-account", saved };
      if (current) {
        await vault.save(current);
        saved = true;
      }
      const wanted = await vault.load(request.target);
      if (!wanted)
        return {
          result: saved ? "saved" : "unchanged",
          reason: "no-saved-login",
          saved,
        };
      if (account && lower(request.target).includes(account))
        return { result: "unchanged", reason: "already-there", saved };
      try {
        await storage.write(dir, wanted);
      } catch (error) {
        const reason: ExtensionReason =
          error instanceof StorageError && error.reason === "mismatch"
            ? "verify-failed"
            : "write-failed";
        try {
          await restoreFolder(dir, backup);
        } catch {
          // Left for the user; the backup is kept.
          keepBackup = true;
          return { result: "failed", reason: "restore-failed", saved };
        }
        return { result: "failed", reason, saved };
      }
      return { result: "switched", saved };
    } finally {
      if (!keepBackup) await clearScratch(scratch);
    }
  }
}

