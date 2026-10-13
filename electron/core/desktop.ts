import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Store } from "./store";
import {
  AUTH_KEYS,
  COOKIE_FILES,
  identity,
  directories,
  readBytes,
  readObject,
  writeBytes,
  jsonBytes,
  planHistory,
  scopePath,
  uuid,
  type JsonObject,
} from "./desktop-files";
import type { Account, DesktopState } from "../../shared/types";
import { historySources } from "../../shared/history-policy";
import { summarizeHistory } from "./desktop-history";

export interface DesktopHost {
  available(): Promise<boolean>;
  running(): Promise<boolean>;
  quit(): Promise<void>;
  launch(): Promise<void>;
  seal(data: string): Buffer;
  unseal(data: Buffer): string;
}
interface SavedLogin {
  accountUuid: string;
  auth: JsonObject;
  cookies: Record<string, string | null>;
}
interface Backup {
  files: Record<string, string | null>;
  createdAt: string;
  historySeen?: string | null;
}
interface ApplyOptions {
  closedOnly?: boolean;
  canProceed?: () => boolean;
}
interface Pending {
  profileId: string;
  previousUuid?: string;
  startedAt: string;
}
export interface DesktopSwitchOptions {
  closedOnly?: boolean;
  expectedActiveProfileId?: string;
  canProceed?: () => boolean;
  beforeQuit?: () => Promise<void>;
}
export class DesktopManager {
  private busy = false;
  get isBusy() {
    return this.busy;
  }
  private pending?: Pending;
  private lastError?: string;
  private errorRevision = 0;
  private dismissedErrorRevision = -1;
  private lastBackup?: string;
  private vault: string;
  private pendingHistorySeen?: Buffer;
  constructor(
    readonly root: string,
    private store: Store,
    private host: DesktopHost,
    private transcriptRoot = path.join(os.homedir(), ".claude"),
  ) {
    this.vault = path.join(store.root, "desktop-vault");
  }
  async initialize() {
    await fs.mkdir(this.vault, { recursive: true, mode: 0o700 });
    const pending = await readObject(this.vault, "pending.json");
    if (pending && uuid.safeParse(pending.profileId).success)
      this.pending = pending as Pending;
    const recovery = await readObject(this.vault, "journal.json");
    if (recovery)
      this.reportError("Desktop recovery is required before switching.");
  }
  private reportError(message: string) {
    if (this.lastError !== message) this.errorRevision++;
    this.lastError = message;
  }
  dismissError(revision: number) {
    // A late dismissal must not hide an error from a newer operation.
    if (revision === this.errorRevision) this.dismissedErrorRevision = revision;
  }
  async snapshot(): Promise<DesktopState> {
    let currentAccountUuid: string | undefined;
    let organizations: string[] = [];
    try {
      currentAccountUuid = identity(await readObject(this.root, "config.json"));
      if (currentAccountUuid)
        organizations = await directories(
          this.root,
          `claude-code-sessions/${currentAccountUuid}`,
        );
      if (
        this.lastError ===
        "Claude Desktop data could not be read. No files were changed."
      )
        this.lastError = undefined;
    } catch {
      this.reportError(
        "Claude Desktop data could not be read. No files were changed.",
      );
    }
    const recovery = !!(await readObject(this.vault, "journal.json"));
    return {
      available: await this.host.available(),
      running: await this.host.running(),
      currentAccountUuid,
      organizations,
      activeProfileId: this.store.state.accounts.find(
        (a) =>
          !!a.desktop &&
          a.desktop.accountUuid === currentAccountUuid &&
          organizations.includes(a.desktop.orgId),
      )?.id,
      pendingProfileId: this.pending?.profileId,
      busy: this.busy,
      error:
        this.dismissedErrorRevision === this.errorRevision
          ? undefined
          : this.lastError,
      errorRevision: this.errorRevision,
      recoveryRequired: recovery,
      lastBackup: this.lastBackup,
    };
  }
  async capture(profileId: string, orgId: string) {
    return this.exclusive(async () => {
      if (this.pending && this.pending.profileId !== profileId)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const account = this.store.account(profileId);
      const state = await this.snapshot();
      if (
        !state.currentAccountUuid ||
        !state.organizations.includes(uuid.parse(orgId))
      )
        throw new Error(
          "Open Claude Desktop, sign in and open the Code tab first.",
        );
      this.assertProfileIdentity(account, state.currentAccountUuid, orgId);
      if (
        this.store.state.accounts.some(
          (a) =>
            a.id !== profileId &&
            a.desktop?.accountUuid === state.currentAccountUuid,
        )
      )
        throw new Error(
          "This Desktop account is already saved in another profile.",
        );
      if (
        account.desktop &&
        account.desktop.accountUuid !== state.currentAccountUuid
      )
        throw new Error(
          "This profile belongs to another Desktop account. Create a new profile.",
        );
      if (
        account.desktop?.accountUuid === state.currentAccountUuid &&
        account.desktop.orgId === orgId &&
        !this.pending
      )
        return;
      await this.host.quit();
      try {
        const saved = await this.saveCurrent();
        if (saved !== state.currentAccountUuid)
          throw new Error("Desktop account changed during setup. Try again.");
        await this.apply(
          await this.historyPlan({
            ...account,
            desktop: {
              accountUuid: saved!,
              orgId,
              savedAt: new Date().toISOString(),
            },
          }),
        );
        this.store.update((s) => {
          s.accounts.find((a) => a.id === profileId)!.desktop = {
            accountUuid: saved!,
            orgId,
            savedAt: new Date().toISOString(),
            email:
              account.auth?.accountUuid === saved &&
              account.auth.orgId === orgId
                ? account.auth.email
                : account.desktop?.email,
          };
        });
        if (this.pending?.profileId === profileId) {
          this.pending = undefined;
          await writeBytes(this.vault, "pending.json", null);
        }
      } finally {
        if (!(await readObject(this.vault, "journal.json")))
          await this.host.launch();
      }
    });
  }
  async beginLogin(profileId: string) {
    return this.exclusive(async () => {
      const account = this.store.account(profileId);
      if (account.desktop)
        this.assertProfileIdentity(
          account,
          account.desktop.accountUuid,
          account.desktop.orgId,
        );
      if (this.pending) {
        if (this.pending.profileId !== profileId)
          throw new Error(
            "Finish or cancel the current Desktop sign-in first.",
          );
        await this.host.launch();
        return;
      }
      await this.assertCurrentSaved();
      await this.restart(async () => {
        const current = await this.saveCurrent();
        // Never replace an unknown current account without a recoverable saved slot.
        if (
          current &&
          !this.store.state.accounts.some(
            (a) => a.desktop?.accountUuid === current,
          )
        )
          throw new Error(
            "Save the current Desktop account into a profile before adding another account.",
          );
        const config = (await readObject(this.root, "config.json")) ?? {};
        for (const key of AUTH_KEYS) delete config[key];
        const changes = new Map<string, Buffer | null>([
          ["config.json", jsonBytes(config)],
          ...COOKIE_FILES.map((f) => [f, null] as [string, null]),
        ]);
        await this.apply(changes);
        this.pending = {
          profileId,
          previousUuid: current,
          startedAt: new Date().toISOString(),
        };
        await writeBytes(this.vault, "pending.json", jsonBytes(this.pending));
      });
    });
  }
  async switchTo(profileId: string, options: DesktopSwitchOptions = {}) {
    return this.exclusive(async () => {
      if (this.pending)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const target = this.store.account(profileId);
      if (!target.desktop)
        throw new Error("Connect this account in Claude Desktop first.");
      this.assertProfileIdentity(
        target,
        target.desktop.accountUuid,
        target.desktop.orgId,
      );
      const assertClosedSwitch = async () => {
        if (!options.closedOnly) return;
        if (
          !options.expectedActiveProfileId ||
          options.expectedActiveProfileId === profileId
        )
          throw new Error(
            "The active Desktop account must be known before automatic preparation.",
          );
        const state = await this.snapshot();
        if (state.running)
          throw new Error("Claude is still running. No files were changed.");
        if (state.activeProfileId !== options.expectedActiveProfileId)
          throw new Error(
            "Desktop account changed before automatic preparation.",
          );
        if (
          this.pending ||
          state.recoveryRequired ||
          options.canProceed?.() === false
        )
          throw new Error("Automatic preparation is no longer authorized.");
        const latest = this.store.account(profileId);
        if (
          latest.desktop?.accountUuid !== target.desktop!.accountUuid ||
          latest.desktop?.orgId !== target.desktop!.orgId
        )
          throw new Error(
            "The selected Desktop account changed before automatic preparation.",
          );
        this.assertProfileIdentity(
          latest,
          target.desktop!.accountUuid,
          target.desktop!.orgId,
        );
      };
      await assertClosedSwitch();
      await this.assertCurrentSaved();
      const saved = await this.readLogin(target.desktop.accountUuid);
      const change = async () => {
        await assertClosedSwitch();
        const current = await this.saveCurrent();
        if (
          current &&
          !this.store.state.accounts.some(
            (a) => a.desktop?.accountUuid === current,
          )
        )
          throw new Error("Save the current Desktop account before switching.");
        const config = (await readObject(this.root, "config.json")) ?? {};
        for (const key of AUTH_KEYS) {
          delete config[key];
          if (key in saved.auth) config[key] = saved.auth[key];
        }
        const changes = await this.historyPlan(target);
        if (current !== saved.accountUuid) {
          changes.set("config.json", jsonBytes(config));
          for (const f of COOKIE_FILES)
            changes.set(
              f,
              saved.cookies[f] === null || saved.cookies[f] === undefined
                ? null
                : Buffer.from(saved.cookies[f]!, "base64"),
            );
        }
        await assertClosedSwitch();
        await this.apply(changes, {
          closedOnly: options.closedOnly,
          canProceed: options.canProceed,
        });
      };
      if (options.closedOnly) await change();
      else await this.restart(change, options.canProceed, options.beforeQuit);
    });
  }
  async cancelLogin() {
    return this.exclusive(async () => {
      if (!this.pending) return;
      const previous = this.pending.previousUuid;
      const saved = previous ? await this.readLogin(previous) : undefined;
      await this.restart(async () => {
        await this.saveCurrent();
        if (saved) {
          const config = (await readObject(this.root, "config.json")) ?? {};
          for (const key of AUTH_KEYS) {
            delete config[key];
            if (key in saved.auth) config[key] = saved.auth[key];
          }
          const changes = new Map<string, Buffer | null>([
            ["config.json", jsonBytes(config)],
          ]);
          for (const f of COOKIE_FILES)
            changes.set(
              f,
              saved.cookies[f] == null
                ? null
                : Buffer.from(saved.cookies[f]!, "base64"),
            );
          await this.apply(changes);
        }
        this.pending = undefined;
        await writeBytes(this.vault, "pending.json", null);
      });
    });
  }
  async open() {
    await this.host.launch();
  }
  /**
   * Decrypt every saved Desktop sign-in once without changing anything. After an
   * app identity change macOS asks before releasing the encryption key; doing it
   * while the user is present keeps an unattended switch from waiting on it.
   */
  async verifySavedLogins() {
    for (const account of this.store.state.accounts)
      if (account.desktop) await this.readLogin(account.desktop.accountUuid);
  }
  async historySummary(profileId: string) {
    const account = this.store.account(profileId);
    if (!account.desktop)
      throw new Error("Connect this account in Claude Desktop first.");
    return summarizeHistory(
      this.root,
      account.desktop,
      profileId,
      historySources(
        account,
        this.store.state.accounts,
        this.store.state.settings,
      ).length,
      this.transcriptRoot,
    );
  }
  async syncHistory(profileId: string) {
    return this.exclusive(async () => {
      if (this.pending)
        throw new Error("Finish or cancel the current Desktop sign-in first.");
      const account = this.store.account(profileId);
      if (!account.desktop)
        throw new Error("Connect this account in Claude Desktop first.");
      const state = await this.snapshot();
      if (state.activeProfileId !== profileId)
        throw new Error(
          "Switch to this Desktop account before syncing its history.",
        );
      this.assertProfileIdentity(
        account,
        account.desktop.accountUuid,
        account.desktop.orgId,
      );
      await this.restart(async () => {
        if (
          identity(await readObject(this.root, "config.json")) !==
          account.desktop!.accountUuid
        )
          throw new Error("Desktop account changed during setup. Try again.");
        await this.apply(await this.historyPlan(account));
      });
    });
  }
  private async historyPlan(
    target: Account,
  ): Promise<Map<string, Buffer | null>> {
    this.pendingHistorySeen = undefined;
    if (
      !target.desktop ||
      this.store.state.settings.desktopHistoryTransfer === "off"
    )
      return new Map();
    const previous = (await readObject(this.vault, "history-seen.json")) ?? {};
    for (const [key, values] of Object.entries(previous)) {
      const parts = key.split("/");
      if (
        parts.length !== 2 ||
        !parts.every((part) => uuid.safeParse(part).success) ||
        !Array.isArray(values) ||
        values.length > 10_000 ||
        values.some(
          (value) => typeof value !== "string" || !value || value.length > 2048,
        )
      )
        throw new Error("Invalid Desktop history tracking data.");
    }
    const key = `${target.desktop.accountUuid}/${target.desktop.orgId}`;
    const sources = historySources(
      target,
      this.store.state.accounts,
      this.store.state.settings,
    );
    const plan = await planHistory(
      this.root,
      target.desktop,
      sources.map((a) => a.desktop!),
      { seenSpaceIds: previous[key] },
    );
    const spacesPath = `${scopePath("local-agent-mode-sessions", target.desktop)}/spaces.json`;
    const planned = plan.get(spacesPath);
    const spaces = planned
      ? JSON.parse(planned.toString("utf8"))
      : await readObject(this.root, spacesPath);
    const seen = [
      ...new Set<string>([
        ...(previous[key] ?? []),
        ...(spaces?.spaces ?? []).map((space: JsonObject) => space.id),
      ]),
    ].sort();
    const next = { ...previous, [key]: seen };
    if (JSON.stringify(next) !== JSON.stringify(previous))
      this.pendingHistorySeen = jsonBytes(next);
    return new Map(plan);
  }
  async recover() {
    return this.exclusive(async () => {
      const journal = await readObject(this.vault, "journal.json");
      if (!journal) return;
      await this.host.quit();
      await this.restore(uuid.parse(journal.backup));
      await writeBytes(this.vault, "journal.json", null);
      this.lastError = undefined;
      await this.host.launch();
    }, true);
  }
  private async exclusive<T>(fn: () => Promise<T>, recovery = false) {
    if (this.busy)
      throw new Error("A Desktop operation is already in progress.");
    // Acquire before any await; separate IPC calls must not both pass the guard.
    this.busy = true;
    this.lastError = undefined;
    try {
      if (!(await this.host.available()))
        throw new Error("Claude Desktop was not found on this platform.");
      if (!recovery && (await readObject(this.vault, "journal.json")))
        throw new Error("Restore the interrupted Desktop switch first.");
      return await fn();
    } catch (e: any) {
      this.reportError(e.message);
      throw e;
    } finally {
      this.busy = false;
      this.pendingHistorySeen = undefined;
    }
  }
  private assertProfileIdentity(
    account: Account,
    accountUuid: string,
    orgId: string,
  ) {
    if (
      account.auth?.accountUuid &&
      account.auth.accountUuid.toLowerCase() !== accountUuid.toLowerCase()
    )
      throw new Error(
        "This profile is connected to a different Claude account. Choose the matching Desktop account.",
      );
    if (
      account.auth?.orgId &&
      account.auth.orgId.toLowerCase() !== orgId.toLowerCase()
    )
      throw new Error(
        "This profile is connected to a different Claude organization. Choose its matching Code workspace.",
      );
  }
  private async assertCurrentSaved() {
    const current = identity(await readObject(this.root, "config.json"));
    if (
      current &&
      !this.store.state.accounts.some((a) => a.desktop?.accountUuid === current)
    )
      throw new Error("Save the current Desktop account before switching.");
  }
  private async restart(
    fn: () => Promise<void>,
    canProceed?: () => boolean,
    beforeQuit?: () => Promise<void>,
  ) {
    // Check the live handoff guard immediately before asking Claude to quit.
    // File-write guards alone are too late to protect a newly started task.
    if (canProceed && !canProceed())
      throw new Error("Automatic Desktop switch was cancelled before restart.");
    await beforeQuit?.();
    if (canProceed && !canProceed())
      throw new Error("Automatic Desktop switch was cancelled before restart.");
    await this.host.quit();
    try {
      await fn();
    } finally {
      if (!(await readObject(this.vault, "journal.json")))
        await this.host.launch();
    }
  }
  private async saveCurrent() {
    const config = await readObject(this.root, "config.json");
    const accountUuid = identity(config);
    if (!accountUuid) return;
    const auth: JsonObject = {};
    for (const key of AUTH_KEYS) if (key in config!) auth[key] = config![key];
    const cookies: SavedLogin["cookies"] = {};
    for (const name of COOKIE_FILES)
      cookies[name] =
        (await readBytes(this.root, name))?.toString("base64") ?? null;
    await writeBytes(
      this.vault,
      `accounts/${accountUuid}.bin`,
      this.host.seal(JSON.stringify({ accountUuid, auth, cookies })),
    );
    return accountUuid;
  }
  private async readLogin(accountUuid: string): Promise<SavedLogin> {
    const data = await readBytes(
      this.vault,
      `accounts/${uuid.parse(accountUuid)}.bin`,
    );
    if (!data)
      throw new Error(
        "Saved Desktop sign-in is missing. Connect this account again.",
      );
    const saved = JSON.parse(this.host.unseal(data)) as SavedLogin;
    if (
      identity(saved.auth) !== accountUuid ||
      saved.accountUuid !== accountUuid ||
      !saved.cookies ||
      typeof saved.cookies !== "object"
    )
      throw new Error("Invalid saved Desktop sign-in.");
    return saved;
  }
  private async apply(
    changes: Map<string, Buffer | null>,
    options: ApplyOptions = {},
  ) {
    const historySeen = this.pendingHistorySeen;
    this.pendingHistorySeen = undefined;
    if (!changes.size && !historySeen) return;
    const guard = async () => {
      if (options.canProceed && !options.canProceed())
        throw new Error(
          "Automatic Desktop switch was cancelled because its conditions changed.",
        );
      if (await this.host.running())
        throw new Error("Claude is still running. No files were changed.");
    };
    await guard();
    const id = randomUUID();
    const backup: Backup = { files: {}, createdAt: new Date().toISOString() };
    if (historySeen)
      backup.historySeen =
        (await readBytes(this.vault, "history-seen.json"))?.toString(
          "base64",
        ) ?? null;
    for (const relative of changes.keys())
      backup.files[relative] =
        (await readBytes(this.root, relative))?.toString("base64") ?? null;
    await writeBytes(
      this.vault,
      `backups/${id}.bin`,
      this.host.seal(JSON.stringify(backup)),
    );
    await writeBytes(this.vault, "journal.json", jsonBytes({ backup: id }));
    this.lastBackup = id;
    try {
      for (const [relative, data] of changes) {
        await guard();
        await writeBytes(this.root, relative, data);
      }
      if (historySeen) {
        await guard();
        await writeBytes(this.vault, "history-seen.json", historySeen);
      }
      await guard();
      await writeBytes(this.vault, "journal.json", null);
    } catch (error) {
      // Claude may have been opened by the user during a closed-app transaction.
      // Keep the recoverable journal; neither continue writing nor roll back live data.
      if (await this.host.running())
        throw new Error(
          "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
        );
      await this.restore(id); // If restore fails, journal blocks subsequent writes and launches.
      await writeBytes(this.vault, "journal.json", null);
      throw error;
    }
  }
  private async restore(id: string) {
    const data = await readBytes(this.vault, `backups/${uuid.parse(id)}.bin`);
    if (!data) throw new Error("Desktop recovery backup is missing.");
    const backup: Backup = JSON.parse(this.host.unseal(data));
    if (!backup.files || typeof backup.files !== "object")
      throw new Error("Invalid Desktop backup.");
    if (
      backup.historySeen !== undefined &&
      backup.historySeen !== null &&
      typeof backup.historySeen !== "string"
    )
      throw new Error("Invalid recovery data.");
    for (const [relative, value] of Object.entries(backup.files)) {
      if (!(
        relative === "config.json" ||
        COOKIE_FILES.includes(relative) ||
        /^claude-code-sessions\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/local_[a-f0-9-]{36}\.json$/i.test(
          relative,
        ) ||
        /^local-agent-mode-sessions\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/spaces\.json$/i.test(
          relative,
        )
      ))
        throw new Error("Invalid recovery path.");
      if (value !== null && typeof value !== "string")
        throw new Error("Invalid recovery data.");
    }
    for (const [relative, value] of Object.entries(backup.files)) {
      if (await this.host.running())
        throw new Error(
          "Claude opened during the Desktop switch. Restore its backup after closing Claude.",
        );
      await writeBytes(
        this.root,
        relative,
        value === null ? null : Buffer.from(value, "base64"),
      );
    }
    if (backup.historySeen !== undefined)
      await writeBytes(
        this.vault,
        "history-seen.json",
        backup.historySeen === null
          ? null
          : Buffer.from(backup.historySeen, "base64"),
      );
  }
}
