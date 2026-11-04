import fs from "node:fs";
import path from "node:path";
import type { DesktopHost } from "./desktop";
import type { ClaudeWindowProcess } from "./desktop-instances";
import { privateJournalDirectory, writePrivateJson } from "./continuation-journal";

/** An account's separate Claude window that runs now. */
export interface OpenWindow {
  accountUuid: string;
  /** The window's main process. */
  pid: number;
  /** When Relay opened it; undefined when Relay does not remember. */
  openedAt?: number;
}

interface Saved {
  /** The feature is on: off until the user turns it on in Settings. */
  enabled: boolean;
  /** The windows Relay opened and has not yet seen closed, by account. */
  open: Record<string, { openedAt: number }>;
}

export const WINDOWS_OFF = "Separate Claude windows are turned off in Settings.";
export const WINDOWS_UNSUPPORTED = "Separate Claude windows need macOS.";
export const WINDOW_IS_MAIN =
  "This account is already open in the Claude app. Switch the Claude app to another account first.";
export const WINDOW_DID_NOT_OPEN = "Claude did not open the separate window. Try again.";
export const WINDOW_DID_NOT_CLOSE =
  "The separate window is still open. Claude may be asking about work left running there.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_WAIT_MS = 15_000;
const CLOSE_WAIT_MS = 20_000;
const POLL_MS = 250;
/** How long after a closed window's last activity its rows are still its own (the ledger lags). */
const OWNER_SLACK_MS = 10 * 60_000;

/** Who a window's Claude Code session belongs to, and until when (no end while the window runs). */
export interface SessionOwner {
  accountUuid: string;
  until: number;
}

export interface DesktopWindowsDeps {
  /** Where windows live: `<id>/data` is an account's Claude data folder, `windows.json` the state. */
  folder: string;
  host: Pick<DesktopHost, "windows" | "launchWindow" | "quitWindow" | "activateWindow">;
  /** The account the main Claude is signed in to, as its data folder says. */
  current(): Promise<string | undefined>;
  /** Puts the account's saved sign-in into a window's data folder. */
  seed(accountUuid: string, dir: string): Promise<void>;
  /** Saves the sign-in a closed window left back to the vault; whether it did. */
  seal(accountUuid: string, dir: string): Promise<boolean>;
  quicOff?(): boolean;
  now(): number;
  sleep?(ms: number): Promise<void>;
  /** For a diagnosis log: events with ids, counts and times only. May throw. */
  log?(event: string, fields: Record<string, unknown>): void;
}

/**
 * Separate Claude windows: an account opened in its own Claude, next to the main one, on a data
 * folder of its own (`--user-data-dir`). The window opens signed in with the sign-in the vault
 * holds, and gives it back once it closes, so an account's live sign-in has one holder at a time:
 * the main Claude cannot switch to an account while its window runs (see DesktopManager.switchTo).
 * The state lives outside the registry, so a change never needs a new registry layout.
 */
export class DesktopWindows {
  private saved: Saved;
  /** Accounts whose window `open` is starting: not yet in the listing, never closed. */
  private readonly opening = new Set<string>();
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly deps: DesktopWindowsDeps) {
    this.saved = this.read();
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  private get file() {
    return path.join(this.deps.folder, "windows.json");
  }
  private read(): Saved {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const open: Saved["open"] = {};
      for (const [id, entry] of Object.entries(saved?.open ?? {}))
        if (UUID.test(id) && Number.isFinite((entry as { openedAt?: unknown })?.openedAt))
          open[id.toLowerCase()] = { openedAt: (entry as { openedAt: number }).openedAt };
      return { enabled: saved?.enabled === true, open };
    } catch {
      return { enabled: false, open: {} };
    }
  }
  private write() {
    privateJournalDirectory(this.deps.folder);
    writePrivateJson(this.file, this.saved);
  }
  private remember(id: string) {
    this.saved = { ...this.saved, open: { ...this.saved.open, [id]: { openedAt: this.deps.now() } } };
    this.write();
  }
  get enabled() {
    return this.saved.enabled;
  }
  setEnabled(enabled: boolean) {
    this.saved = { ...this.saved, enabled };
    this.write();
  }
  /** The account's Claude data folder. */
  dataDir(accountUuid: string): string {
    if (!UUID.test(accountUuid)) throw new Error("Invalid account id.");
    return path.resolve(this.deps.folder, accountUuid.toLowerCase(), "data");
  }
  /** The account's data folder when a window ever used it, for the main Claude's history. */
  folderOf(accountUuid: string): string | undefined {
    try {
      const dir = this.dataDir(accountUuid);
      return fs.existsSync(path.join(dir, "config.json")) ? dir : undefined;
    } catch {
      return undefined;
    }
  }
  private listed?: { at: number; processes: Promise<ClaudeWindowProcess[]> };
  /**
   * The accounts' windows that run, and how many other Claudes run on a folder of their own: from
   * a listing at most `maxAgeMs` old, a fresh one by default.
   */
  async running(maxAgeMs = 0): Promise<{ windows: OpenWindow[]; others: number }> {
    const now = this.deps.now();
    const listed = this.listed;
    const reuse = !!listed && now - listed.at >= 0 && now - listed.at < maxAgeMs;
    const entry = reuse
      ? listed!
      : { at: now, processes: Promise.resolve(this.deps.host.windows?.() ?? []) };
    if (!reuse) {
      this.listed = entry;
      entry.processes.catch(() => {
        if (this.listed === entry) this.listed = undefined;
      });
    }
    const processes = await entry.processes;
    const windows: OpenWindow[] = [];
    let others = 0;
    for (const process of processes) {
      const id = path.basename(path.dirname(process.dir)).toLowerCase();
      if (UUID.test(id) && this.dataDir(id) === path.resolve(process.dir))
        windows.push({ accountUuid: id, pid: process.pid, openedAt: this.saved.open[id]?.openedAt });
      else others += 1;
    }
    return { windows, others };
  }
  async openAccounts(): Promise<string[]> {
    return (await this.running()).windows.map((window) => window.accountUuid);
  }
  /** Whether any Claude runs next to the main one: automatic switching waits while one does. */
  async anyOpen(): Promise<boolean> {
    const { windows, others } = await this.running();
    return windows.length + others > 0;
  }
  /** Opens the account's window, or brings it forward when it runs. */
  async open(accountUuid: string): Promise<"opened" | "shown"> {
    if (!this.saved.enabled) throw new Error(WINDOWS_OFF);
    const { launchWindow, activateWindow } = this.deps.host;
    if (!launchWindow || !activateWindow) throw new Error(WINDOWS_UNSUPPORTED);
    const id = accountUuid.toLowerCase();
    const dir = this.dataDir(id);
    const running = (await this.running()).windows.find((w) => w.accountUuid === id);
    if (running) {
      await activateWindow(running.pid);
      return "shown";
    }
    if ((await this.deps.current())?.toLowerCase() === id) throw new Error(WINDOW_IS_MAIN);
    // A window that closed before gives its sign-in back first: it may be newer than the vault's.
    await this.reconcile();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Until the listing shows it, a reconcile in between must not take it for closed.
    this.opening.add(id);
    try {
      await this.deps.seed(id, dir);
      this.remember(id);
      const begun = this.deps.now();
      await launchWindow(dir, this.deps.quicOff?.() ? { quicOff: true } : undefined);
      for (let waited = 0; waited < OPEN_WAIT_MS; waited += POLL_MS) {
        const pid = (await this.running()).windows.find((w) => w.accountUuid === id)?.pid;
        if (pid !== undefined) {
          this.deps.log?.("window-opened", { account: id.slice(0, 8), waitedMs: this.deps.now() - begun });
          return "opened";
        }
        await this.sleep(POLL_MS);
      }
    } finally {
      this.opening.delete(id);
    }
    this.deps.log?.("window-open-failed", { account: id.slice(0, 8) });
    throw new Error(WINDOW_DID_NOT_OPEN);
  }
  /** Asks the account's window to quit, waits for it, and gives its sign-in back. */
  async close(accountUuid: string): Promise<void> {
    const id = accountUuid.toLowerCase();
    const running = (await this.running()).windows.find((w) => w.accountUuid === id);
    if (running) {
      if (!this.deps.host.quitWindow) throw new Error(WINDOWS_UNSUPPORTED);
      // Its sign-in goes back once it closes, even when Relay lost track of opening it.
      if (!this.saved.open[id]) this.remember(id);
      await this.deps.host.quitWindow(running.pid);
      let closed = false;
      for (let waited = 0; waited < CLOSE_WAIT_MS && !closed; waited += POLL_MS) {
        closed = !(await this.running()).windows.some((w) => w.accountUuid === id);
        if (!closed) await this.sleep(POLL_MS);
      }
      if (!closed) throw new Error(WINDOW_DID_NOT_CLOSE);
    }
    await this.reconcile();
  }
  /**
   * The Claude Code sessions the accounts' windows hold, by session id (lower case): the account
   * each window's own session index names, while its window runs and up to a while after the
   * session's last activity there. A conversation the main Claude carried on later is its own.
   * Unreadable files are skipped.
   */
  async sessionOwners(): Promise<Map<string, SessionOwner>> {
    const owners = new Map<string, SessionOwner>();
    const open = new Set(await this.openAccounts().catch(() => []));
    const list = async (dir: string) => {
      try {
        return await fs.promises.readdir(dir);
      } catch {
        return [];
      }
    };
    for (const id of await list(this.deps.folder)) {
      if (!UUID.test(id)) continue;
      const scope = path.join(this.dataDir(id), "claude-code-sessions", id.toLowerCase());
      for (const org of await list(scope)) {
        if (!UUID.test(org)) continue;
        for (const name of await list(path.join(scope, org))) {
          if (!/^local_[0-9a-f-]{36}\.json$/i.test(name)) continue;
          try {
            const record = JSON.parse(
              await fs.promises.readFile(path.join(scope, org, name), "utf8"),
            );
            if (typeof record?.cliSessionId !== "string" || !UUID.test(record.cliSessionId)) continue;
            const account = id.toLowerCase();
            const until = open.has(account)
              ? Number.POSITIVE_INFINITY
              : Number.isFinite(record.lastActivityAt)
                ? record.lastActivityAt + OWNER_SLACK_MS
                : undefined;
            if (until !== undefined)
              owners.set(record.cliSessionId.toLowerCase(), { accountUuid: account, until });
          } catch {
            // Being rewritten, or not a session record.
          }
        }
      }
    }
    return owners;
  }
  /**
   * Gives back the sign-in of every window Relay opened that no longer runs, however it closed.
   * One that cannot be saved now (another Desktop operation runs) is tried again next time.
   * The accounts whose sign-in went back to the vault.
   */
  async reconcile(): Promise<string[]> {
    const ids = Object.keys(this.saved.open);
    if (!ids.length) return [];
    const open = new Set(await this.openAccounts());
    const sealed: string[] = [];
    for (const id of ids) {
      if (open.has(id) || this.opening.has(id)) continue;
      let saved: boolean;
      try {
        saved = await this.deps.seal(id, this.dataDir(id));
      } catch {
        continue;
      }
      const { [id]: _closed, ...rest } = this.saved.open;
      this.saved = { ...this.saved, open: rest };
      this.write();
      this.deps.log?.("window-closed", { account: id.slice(0, 8), sealed: saved });
      if (saved) sealed.push(id);
    }
    return sealed;
  }
}
