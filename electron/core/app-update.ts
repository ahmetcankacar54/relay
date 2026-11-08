import fs from "node:fs";
import path from "node:path";
import type { UpdateState } from "../../shared/types";
import { privateJournalDirectory, writePrivateJson } from "./continuation-journal";

/** The public repository Relay's releases are published in. */
export const RELEASE_REPO = "ahmetcankacar54/relay";
/** Its newest published release: never a draft or a pre-release. */
export const LATEST_RELEASE_FEED = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
/** A release's own page, for "What's new". */
export const releasePage = (version: string) =>
  `https://github.com/${RELEASE_REPO}/releases/tag/v${version}`;

/** The first check after start, and the time between checks. */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 3_600_000;
/** When a check encounters a transient missing asset or network error, retry much sooner. */
export const RETRY_CHECK_MS = 2 * 60_000;
const MAX_FEED_BYTES = 1024 * 1024;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** `1.2.3` (an optional `v` and pre-release tag allowed) as numbers; undefined when it is not one. */
export function parseVersion(text: string) {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])] as const,
    pre: match[4],
  };
}

/** Below 0 when `a` is older than `b`, 0 when equal, above 0 when newer. A pre-release is older. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error("Invalid version.");
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}
export interface Release {
  version: string;
  notesUrl: string;
  assets: ReleaseAsset[];
}

/** Downloads come over https; plain http only from this computer, for a local test feed. */
const DOWNLOAD_URL = /^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/)/;

/** A GitHub release from its API JSON; undefined for a draft, a pre-release or a bad tag. */
export function releaseFrom(json: unknown): Release | undefined {
  if (!json || typeof json !== "object") return undefined;
  const r = json as Record<string, unknown>;
  if (r.draft === true || r.prerelease === true || typeof r.tag_name !== "string") return undefined;
  const parsed = parseVersion(r.tag_name);
  if (!parsed || parsed.pre !== undefined) return undefined;
  const version = parsed.parts.join(".");
  const assets = (Array.isArray(r.assets) ? r.assets : []).flatMap((asset) => {
    const a = asset as Record<string, unknown>;
    return typeof a?.name === "string" &&
      typeof a.browser_download_url === "string" &&
      DOWNLOAD_URL.test(a.browser_download_url) &&
      Number.isSafeInteger(a.size)
      ? [{ name: a.name, url: a.browser_download_url, size: a.size as number }]
      : [];
  });
  return { version, notesUrl: releasePage(version), assets };
}

/** `SHA256SUMS.txt` (`<hex>  <name>` lines) as name → lower-case hex. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Reads a JSON body of at most `maxBytes`, failing after `timeoutMs`. */
export async function fetchJson(
  url: string,
  request: typeof fetch = fetch,
  { maxBytes = MAX_FEED_BYTES, timeoutMs = 15_000 } = {},
): Promise<unknown> {
  const response = await request(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Relay" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`The update check failed (HTTP ${response.status}).`);
  const text = await readCapped(response, maxBytes);
  return JSON.parse(text);
}

/** A response body as text, refusing one larger than `maxBytes`. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("The update server sent too much data.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * How one platform finds, readies and installs a newer release: macOS by Relay itself, Windows and
 * Linux through electron-updater. `check` reports each step through `report`.
 */
export interface UpdateDriver {
  check(report: (patch: Partial<UpdateState>) => void): Promise<void>;
  /** Starts the install; the caller quits Relay right after. */
  install(): Promise<void>;
}

export const UPDATE_BUSY = "Relay is busy with the Claude app. Update when it is done.";
export const UPDATE_NOT_READY = "No update is ready to install.";

interface Saved {
  autoCheck: boolean;
  /** The last version a notification was shown for. */
  notifiedVersion?: string;
}

export interface AppUpdatesDeps {
  /** `<userData>/updates`: `state.json` and the downloads. */
  folder: string;
  current: string;
  driver: UpdateDriver;
  now(): number;
  /** Told once per version when it is ready to install. */
  notify(version: string): void;
  /** Told whenever the state changes. */
  changed(): void;
  /** Why an install must wait now (a Claude app operation runs); undefined when it may run. */
  busy(): string | undefined;
  /** Quits Relay for the install. */
  quit(): void;
  setTimeout?: (fn: () => void, ms: number) => { unref?(): void };
  clearTimeout?: (timer: unknown) => void;
  log?(event: string, fields: Record<string, unknown>): void;
}

/**
 * Relay's own updates: checks at start and every few hours (unless turned off), lets the
 * platform driver download and verify a newer release, says once per version when it is ready,
 * and installs it only when the user asks. The choice lives outside the registry.
 */
export class AppUpdates {
  private saved: Saved;
  private current: UpdateState;
  private running?: Promise<UpdateState>;
  private timer?: unknown;
  private readonly setTimer: NonNullable<AppUpdatesDeps["setTimeout"]>;
  private readonly clearTimer: NonNullable<AppUpdatesDeps["clearTimeout"]>;
  constructor(private readonly deps: AppUpdatesDeps) {
    this.saved = this.read();
    this.current = { status: "idle", current: deps.current, autoCheck: this.saved.autoCheck };
    this.setTimer = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }
  private get file() {
    return path.join(this.deps.folder, "state.json");
  }
  private read(): Saved {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return {
        autoCheck: saved?.autoCheck !== false,
        ...(typeof saved?.notifiedVersion === "string" ? { notifiedVersion: saved.notifiedVersion } : {}),
      };
    } catch {
      return { autoCheck: true };
    }
  }
  private write() {
    privateJournalDirectory(this.deps.folder);
    writePrivateJson(this.file, this.saved);
  }
  state(): UpdateState {
    return { ...this.current };
  }
  private set(patch: Partial<UpdateState>, replace = false) {
    const base = replace
      ? { current: this.deps.current, autoCheck: this.saved.autoCheck }
      : this.current;
    this.current = { ...base, ...patch } as UpdateState;
    if (this.current.status === "ready" && this.current.version) this.announce(this.current.version);
    this.deps.changed();
  }
  private announce(version: string) {
    if (this.saved.notifiedVersion === version) return;
    this.saved = { ...this.saved, notifiedVersion: version };
    try {
      this.write();
    } catch {
      // Told again next time; never a reason to fail the update.
    }
    try {
      this.deps.notify(version);
    } catch {
      // A notification is an aid.
    }
  }
  /** Checks first after FIRST_CHECK_MS, then every CHECK_EVERY_MS, while automatic checks are on. */
  start() {
    this.schedule(FIRST_CHECK_MS);
  }
  stop() {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }
  private schedule(ms: number) {
    this.stop();
    if (!this.saved.autoCheck) return;
    const timer = this.setTimer(() => {
      void this.check().finally(() => {
        const nextInterval =
          (this.current.status === "manual" && this.current.manualReason === "no-asset") ||
          this.current.status === "error"
            ? RETRY_CHECK_MS
            : CHECK_EVERY_MS;
        this.schedule(nextInterval);
      });
    }, ms);
    timer.unref?.();
    this.timer = timer;
  }
  setAuto(enabled: boolean) {
    this.saved = { ...this.saved, autoCheck: enabled };
    this.write();
    this.set({ autoCheck: enabled });
    if (enabled) this.schedule(FIRST_CHECK_MS);
    else this.stop();
  }
  /** Looks for a newer release now, sharing a check already running. A ready update stays ready. */
  check(): Promise<UpdateState> {
    if (this.running) return this.running;
    if (this.current.status === "ready" || this.current.status === "installing")
      return Promise.resolve(this.state());
    const run = (async () => {
      this.set({ status: "checking" }, true);
      try {
        await this.deps.driver.check((patch) => this.set(patch));
        if (this.current.status === "checking") this.set({ status: "up-to-date" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.log?.("update-error", { status: this.current.status, error: message.slice(0, 200) });
        this.set({ status: "error", error: message, progress: undefined });
      }
      this.set({ checkedAt: new Date(this.deps.now()).toISOString() });
      return this.state();
    })();
    this.running = run;
    void run.finally(() => {
      if (this.running === run) this.running = undefined;
    });
    return run;
  }
  /** Installs the ready update and quits Relay; the new version opens by itself. */
  async install() {
    if (this.current.status !== "ready") throw new Error(UPDATE_NOT_READY);
    const busy = this.deps.busy();
    if (busy) throw new Error(busy);
    this.set({ status: "installing" });
    try {
      await this.deps.driver.install();
    } catch (error) {
      this.set({ status: "ready", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.deps.log?.("update-install", { version: this.current.version });
    this.deps.quit();
  }
  /** Said by the quit when it did not happen (the user cancelled): the update is ready again. */
  quitCancelled() {
    if (this.current.status === "installing") this.set({ status: "ready" });
  }
}
