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
import { pickSignIn } from "../../shared/extension-auth";
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
  /** Told the key names (never values) a check saw when it found no account of Relay's. */
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
  async check(
    request: Pick<ExtensionRequest, "setting" | "known"> & {
      /** The account the user says the extension is signed in to, for data that names none. */
      claim?: string;
    },
  ): Promise<
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
      const entries = await storage.read(copy);
      const reading = pickSignIn(entries, request.known);
      if (!reading?.account)
        this.ports.onUnknownLayout?.(entries.map(([key]) => key));
      if (!reading) return { state: "signed-out", at };
      const claim = request.claim?.toLowerCase();
      const account =
        reading.account ??
        (reading.other
          ? undefined
          : claim && lower(request.known).includes(claim)
            ? claim
            : await this.owner(request.known));
      if (!account)
        return { state: "signed-in", known: false, ...(reading.other ? { other: true } : {}), at };
      await vault.save(account, reading.signIn);
      await vault.setOwner(account);
      return { state: "signed-in", accountUuid: account, known: true, at };
    } catch {
      return { state: "unreadable", at };
    } finally {
      await clearScratch(peekScratch);
    }
  }

  /** The owner Relay remembers, when it is still one of its accounts. */
  private async owner(known: string[]): Promise<string | undefined> {
    const owner = await this.ports.vault.owner().catch(() => undefined);
    return owner && lower(known).includes(owner) ? owner : undefined;
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
      let entries;
      try {
        entries = await storage.read(dir);
      } catch (error) {
        return {
          result: "failed",
          reason: error instanceof StorageError && error.reason === "locked" ? "locked" : "unreadable",
          saved,
        };
      }
      const current = pickSignIn(entries, request.known);
      // Data that names no account is the one Relay last knew the extension to be on.
      const account =
        current &&
        (current.account ?? (current.other ? undefined : await this.owner(request.known)));
      if (current && !account)
        return { result: "skipped", reason: "unknown-account", saved };
      if (current && account) {
        await vault.save(account, current.signIn);
        await vault.setOwner(account);
        saved = true;
      }
      const wanted = await vault.load(request.target);
      const listed = await vault.list();
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
      const placed = lower(request.target).find((uuid) =>
        listed.some((x) => x.accountUuid === uuid),
      );
      if (placed) await vault.setOwner(placed);
      return { result: "switched", saved };
    } finally {
      if (!keepBackup) await clearScratch(scratch);
    }
  }
}

