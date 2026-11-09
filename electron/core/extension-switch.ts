import path from "node:path";
import {
  browserRunning,
  dataDir,
  extensionInstances,
  extensionStorageDir,
  quitBrowser,
  type BrowserSystem,
} from "./browser-system";
import {
  StorageError,
  backupFolder,
  clearScratch,
  keepScratch,
  removeBackup,
  restoreFolder,
  type ExtensionStorage,
} from "./extension-storage";
import type { ExtensionVault } from "./extension-vault";
import {
  CookieStoreError,
  backupCookieFiles,
  hasWebLogin,
  restoreCookieFiles,
  sameLogin,
  sameOrganization,
  sessionCreatedMs,
  type CookieSnapshot,
  type CookieStorage,
} from "./cookie-store";
import type { CookieVault } from "./cookie-vault";
import { FAILURE_KEYS, pickSignIn, sessionExpired } from "../../shared/extension-auth";
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
  /**
   * The browser's cookie database and the sealed claude.ai logins. The extension signs in through
   * the profile's claude.ai login, so the modes that change the extension's account swap that
   * login with the extension's hints; without these a step reports itself unavailable.
   */
  cookies?: CookieStorage;
  cookieVault?: CookieVault;
  /** Where a step keeps the backup of the cookie files while it runs; `<scratch>-cookies` when unset. */
  cookieScratch?: string;
  /** Where a step keeps the backup of the extension's folder while it runs. */
  scratch: string;
  /** Where a check keeps its copy of the extension's folder; apart from `scratch`, which a step clears. */
  peekScratch?: string;
  /** Told the key names (never values) a check saw when it found no account of Relay's. */
  onUnknownLayout?: (names: string[]) => void;
  /**
   * Told why a saved claude.ai login could not be used: the browser holds login-like cookies this
   * build does not know (their names), or its cookie database differs from the saved one.
   */
  onCookieLayout?: (detail: Record<string, string>) => void;
  /** Told when the profile's claude.ai login was not kept for `account` (see `foreignLogin`). */
  onForeignLogin?: (account: string, other: string, why: ForeignWhy) => void;
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
  /** Each account uuid's organization, as Relay knows it (lower case), where it knows one. */
  orgs?: Record<string, string>;
  /** Each Relay account's uuids (lower case): two uuids of one account are never "another". */
  groups?: string[][];
}

/**
 * Why a claude.ai login is not kept as an account's: it is another account's login, it is on
 * another account's organization, or the extension already failed to sign in with it there.
 */
export type ForeignWhy = "same-login" | "other-org" | "rejected";

type Core = Pick<ExtensionOutcome, "result" | "reason" | "saved" | "cleared" | "current">;

const lower = (list: string[]) => list.map((value) => value.toLowerCase());

/**
 * The web login may be created this long after the extension's hints were last written and still
 * count as the same sign-in (the hints are written right after the web login, at the extension's
 * OAuth step, and the folder's newest file time is only roughly that).
 */
const OWNER_SLACK_MS = 5 * 60_000;

/** Why a cookie-database failure ended a step. */
function cookieReason(error: unknown): ExtensionReason {
  if (error instanceof CookieStoreError) {
    switch (error.reason) {
      case "locked":
        return "locked";
      case "schema-changed":
        return "schema-changed";
      case "journal-pending":
        return "journal-pending";
      case "mismatch":
        return "verify-failed";
      case "missing":
        return "unreadable";
    }
  }
  return "write-failed";
}

/**
 * Keeps the Claude extension's sign-in with the account. At a switch it saves the sign-in the
 * extension holds, into the vault under the account the extension says it is, and puts the
 * target's saved one in place. The extension's LevelDB can only be used while the browser is
 * closed, so a running browser is quit first (in mode "restart", when the caller allows it) and
 * opened again afterwards. Never throws.
 */
export class ExtensionSwitcher {
  constructor(private readonly ports: ExtensionPorts) {}

  /** Browser profiles that have the extension, opened or not. */
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
      if (request.setting.mode === "guide") return done(await this.guide(request));
      // Never opened: no storage to save or write; it gets one once the user opens it.
      if (!instance.opened) return skipped("not-opened");
      if (!(await this.pairReady())) return skipped("unavailable");
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

  /** Whether the cookie database can be used here: SQLite loads and the vault is wired. */
  private async pairReady(): Promise<boolean> {
    const { cookies, cookieVault } = this.ports;
    return !!cookies && !!cookieVault && (await cookies.available());
  }

  /**
   * Mode "guide": nothing is written and no browser is quit. Looks at who the extension is signed
   * in to (a check, which also keeps what it sees) and says when it is not on the target.
   */
  private async guide(request: ExtensionRequest): Promise<Core> {
    const current = await this.check({ setting: request.setting, known: request.known });
    if (!current) return { result: "failed", reason: "unreadable", saved: false };
    if (current.state === "unreadable")
      return { result: "failed", reason: "unreadable", saved: false, current };
    if (current.state === "signed-out" && current.unopened)
      return { result: "skipped", reason: "not-opened", saved: false, current };
    const saved = current.state === "signed-in" && current.known;
    if (
      current.state === "signed-in" &&
      current.accountUuid &&
      lower(request.target).includes(current.accountUuid)
    )
      return { result: "unchanged", reason: "already-there", saved, current };
    return { result: "skipped", reason: "guide-mismatch", saved, current };
  }

  /**
   * Who the extension is signed in to, read from a copy of its folder so a running browser is
   * neither quit nor disturbed; the copy is removed before this returns. A sign-in of one of
   * Relay's accounts is saved into the vault: signing in to the extension once and checking is
   * how an account is linked, with no switch. Undefined when the step would not run (mode off,
   * no extension, no library). Never throws.
   */
  async check(
    request: Pick<ExtensionRequest, "setting" | "known" | "orgs" | "groups"> & {
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
      // Installed, never opened: nobody has signed in to it in this profile.
      if (!instance.opened) return { state: "signed-out", unopened: true, at };
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
      const expired = sessionExpired(entries) ? { expired: true as const } : {};
      const claim = request.claim?.toLowerCase();
      const account =
        reading.account ??
        (reading.other
          ? undefined
          : claim && lower(request.known).includes(claim)
            ? claim
            : await this.owner(request.known));
      if (!account)
        return {
          state: "signed-in",
          known: false,
          ...(reading.other ? { other: true } : {}),
          ...expired,
          at,
        };
      await vault.save(account, reading.signIn);
      await vault.setOwner(account);
      await this.keepWebLogin(account, instance, peekScratch, request);
      return { state: "signed-in", accountUuid: account, known: true, ...expired, at };
    } catch {
      return { state: "unreadable", at };
    } finally {
      await clearScratch(peekScratch);
    }
  }

  /**
   * Keeps the profile's claude.ai login for `account` from a copy of the cookie files, only when
   * none is saved yet: a copy of a running browser's database can lag its memory, so a login
   * already saved is replaced only by the swap's read of a closed browser. Never throws.
   */
  private async keepWebLogin(
    account: string,
    instance: ExtensionInstance,
    peekScratch: string,
    request: Pick<ExtensionRequest, "orgs" | "groups">,
  ): Promise<void> {
    const { cookies, cookieVault, system } = this.ports;
    try {
      if (!cookies || !cookieVault || !(await cookies.available())) return;
      if ((await cookieVault.list()).some((x) => x.accountUuid === account)) return;
      const profile = path.join(dataDir(system, instance.app), instance.profile);
      const web = await cookies.read(await backupCookieFiles(profile, peekScratch));
      if (!hasWebLogin(web) || web.unlisted.length) return;
      const hintsAt = system.modifiedAt(
        extensionStorageDir(system, instance.app, instance.profile),
      );
      const created = sessionCreatedMs(web);
      if (created !== undefined && hintsAt !== undefined && created > hintsAt + OWNER_SLACK_MS)
        return;
      if (await this.foreignLogin(account, web, request)) return;
      await cookieVault.save(account, web);
    } catch {
      // The hints are saved; the login is kept at the next check or switch.
    }
  }

  /**
   * Whether the profile's claude.ai login is another account's, so it must not be kept as
   * `account`'s: it is the login saved for another account, or it is on the organization of
   * another account's saved login while the two accounts' organizations differ. The extension's
   * hints say nothing about who is signed in to claude.ai: the user may sign in there with another
   * account while the extension keeps its tokens, and a login kept under the wrong account signs
   * the extension out at every switch to it (seen 2026-11-04). A login the extension already
   * failed to sign in to `account` with is never kept again either. Told to `onForeignLogin`.
   */
  private async foreignLogin(
    account: string,
    web: CookieSnapshot,
    { orgs, groups }: Pick<ExtensionRequest, "orgs" | "groups">,
  ): Promise<boolean> {
    const cookieVault = this.ports.cookieVault;
    if (!cookieVault) return false;
    if (await cookieVault.isRejected(account, web)) {
      this.ports.onForeignLogin?.(account, account, "rejected");
      return true;
    }
    const mine = orgs?.[account];
    const self = groups?.find((uuids) => uuids.includes(account)) ?? [account];
    for (const { accountUuid: other } of await cookieVault.list()) {
      if (self.includes(other)) continue;
      const theirs = await cookieVault.load([other]).catch(() => undefined);
      if (!theirs) continue;
      const theirOrg = orgs?.[other];
      const why: ForeignWhy | undefined = sameLogin(web, theirs)
        ? "same-login"
        : mine && theirOrg && mine !== theirOrg && sameOrganization(web, theirs)
          ? "other-org"
          : undefined;
      if (why) {
        this.ports.onForeignLogin?.(account, other, why);
        return true;
      }
    }
    return false;
  }

  /** The owner Relay remembers, when it is still one of its accounts. */
  private async owner(known: string[]): Promise<string | undefined> {
    const owner = await this.ports.vault.owner().catch(() => undefined);
    return owner && lower(known).includes(owner) ? owner : undefined;
  }

  /**
   * The browser is closed. Backs up the extension's folder and the cookie files, saves the pair
   * the profile holds (the extension's hints and its claude.ai login) for the account the hints
   * name, and puts the target's pair in place. Both or neither: the extension refuses a web login
   * that disagrees with its hints, so a half swap would leave it signed out.
   */
  private async swap(
    instance: ExtensionInstance,
    request: ExtensionRequest,
  ): Promise<Core> {
    const { system, storage, vault, scratch } = this.ports;
    const cookies = this.ports.cookies!;
    const cookieVault = this.ports.cookieVault!;
    const dir = extensionStorageDir(system, instance.app, instance.profile);
    const profile = path.join(dataDir(system, instance.app), instance.profile);
    const cookieScratch = this.ports.cookieScratch ?? `${scratch}-cookies`;
    await clearScratch(scratch);
    await clearScratch(cookieScratch);
    let keepBackup = false;
    const own: string[] = [];
    try {
      const backup = await backupFolder(dir, scratch);
      own.push(backup);
      const cookieBackup = await backupCookieFiles(profile, cookieScratch);
      own.push(cookieBackup);
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
      let web: CookieSnapshot;
      try {
        web = await cookies.read(profile);
      } catch (error) {
        const reason = cookieReason(error);
        return {
          result: "failed",
          reason: reason === "write-failed" ? "unreadable" : reason,
          saved,
        };
      }
      // A login cookie this build does not know: the layout changed, nothing is guessed.
      if (web.unlisted.length) {
        this.ports.onCookieLayout?.({ why: "unlisted", names: web.unlisted.join(" ") });
        return { result: "skipped", reason: "schema-changed", saved };
      }
      const current = pickSignIn(entries, request.known);
      // Data that names no account is the one Relay last knew the extension to be on.
      const account =
        current &&
        (current.account ?? (current.other ? undefined : await this.owner(request.known)));
      if (current && !account)
        return { result: "skipped", reason: "unknown-account", saved };
      // An earlier swap stopped between its two writes: the hints and the login may be two
      // accounts', so nothing is saved from the profile; putting the target's pair in place mends it.
      const interrupted = await vault.swapInterrupted();
      // A web login nobody can name would be lost by the swap: its cookies are not saved anywhere.
      const webLogin = hasWebLogin(web);
      if (webLogin && !account)
        return { result: "skipped", reason: "unknown-account", saved };
      if (current && account && !interrupted) {
        // The web login belongs to the hints' account unless it is newer than the hints: the user
        // signed in to claude.ai again without the extension following.
        const hintsAt = system.modifiedAt(dir);
        const created = sessionCreatedMs(web);
        if (
          webLogin &&
          created !== undefined &&
          hintsAt !== undefined &&
          created > hintsAt + OWNER_SLACK_MS
        )
          return { result: "skipped", reason: "ambiguous-owner", saved };
        await vault.save(account, current.signIn);
        await vault.setOwner(account);
        // The hints are the account's; the login is kept only when it is not another account's.
        if (webLogin && !(await this.foreignLogin(account, web, request)))
          await cookieVault.save(account, web);
        saved = true;
      }
      /** Why a write failed. */
      const writeReason = (error: unknown): ExtensionReason => {
        if (error instanceof CookieStoreError && error.detail)
          this.ports.onCookieLayout?.(error.detail);
        return error instanceof CookieStoreError
          ? cookieReason(error)
          : error instanceof StorageError && error.reason === "mismatch"
            ? "verify-failed"
            : "write-failed";
      };
      /**
       * Puts back what a failed write changed: the extension's folder, and the cookie files when
       * they were written too. False when that failed as well; the backups are then kept.
       */
      const putBack = async (withCookies: boolean): Promise<boolean> => {
        try {
          await restoreFolder(dir, backup);
          if (withCookies) {
            await restoreCookieFiles(profile, cookieBackup);
            // Put back as it was, so the mark of an earlier interruption is not lost.
            if (!interrupted) await vault.clearSwap();
          }
          return true;
        } catch {
          // Left for the user.
          keepBackup = true;
          await keepScratch(scratch);
          if (withCookies) await keepScratch(cookieScratch);
          return false;
        }
      };
      const onTarget = !!account && lower(request.target).includes(account) && !interrupted;
      // On the account, but holding a stale record (`FAILURE_KEYS`): the extension would refuse
      // Claude's browser tools without trying again. The record goes and the rest is written back
      // as it is, so it signs in on its own with the profile's claude.ai login. No saved pair is
      // needed for that, so this comes before the pair is asked for.
      if (onTarget && entries.some(([key]) => FAILURE_KEYS.includes(key))) {
        try {
          await storage.write(dir, current!.signIn);
        } catch (error) {
          return (await putBack(false))
            ? { result: "failed", reason: writeReason(error), saved }
            : { result: "failed", reason: "restore-failed", saved };
        }
        return { result: "unchanged", reason: "already-there", saved, cleared: true };
      }
      const wanted = await vault.load(request.target);
      const wantedWeb = await cookieVault.load(request.target);
      const listed = await vault.list();
      // Only a complete pair is put in place.
      if (!wanted || !wantedWeb)
        return {
          result: saved ? "saved" : "unchanged",
          reason: "no-saved-login",
          saved,
        };
      if (onTarget) return { result: "unchanged", reason: "already-there", saved };
      try {
        await vault.markSwap();
        await storage.write(dir, wanted);
        await cookies.write(profile, wantedWeb);
      } catch (error) {
        return (await putBack(true))
          ? { result: "failed", reason: writeReason(error), saved }
          : { result: "failed", reason: "restore-failed", saved };
      }
      const placed = lower(request.target).find((uuid) =>
        listed.some((x) => x.accountUuid === uuid),
      );
      if (placed) await vault.setOwner(placed);
      await vault.clearSwap();
      return { result: "switched", saved };
    } finally {
      if (!keepBackup) {
        // Only this run's backups go; those of an earlier failed restore stay (clearScratch).
        for (const backup of own) await removeBackup(backup);
        await clearScratch(scratch);
        await clearScratch(cookieScratch);
      }
    }
  }
}
