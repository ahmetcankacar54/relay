import fs from "node:fs";
import path from "node:path";
import type { ClaudeLaunchChoice } from "../../shared/types";

/**
 * How Relay starts Claude, chosen outside Relay's registry so a change never asks the registry
 * for a new layout:
 * - `netLog`, the switch diagnosis: every Claude Relay starts writes Chromium's net log, so a
 *   page that hangs can be read request by request instead of guessed at;
 * - `quicOff`: Claude starts without HTTP/3. On some networks claude.ai's HTTP/3 transfers
 *   stall after a working handshake, so Chromium never falls back and the page stays grey
 *   (measured 2026-10-26: 13 of 73 assets answered in 8 s over HTTP/3, 94 of 98 in 2 s over
 *   HTTP/2). Relay turns it on itself once a stuck start loads without HTTP/3.
 *
 * A net log has no size limit in Claude's Electron and grows while that Claude runs; only the
 * newest KEEP_LOGS are kept, and each launch starts a new one, so the one before stops growing
 * once Relay has quit its Claude.
 */

/** How many net logs are kept: the one being written and the ones of the launches before it. */
export const KEEP_LOGS = 3;
const LOG = /^claude-net-\d{8}-\d{6}-\d{3}\.json$/;

/** `at` as the sortable local stamp in a log's name: 20261025-234822-016. */
export function logStamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-` +
    `${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}-` +
    String(at.getMilliseconds()).padStart(3, "0")
  );
}

export class SwitchDiagnostics {
  private choice: ClaudeLaunchChoice;
  constructor(
    /** The folder the choice and the logs live in, created when first needed. */
    readonly folder: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.choice = this.read();
  }
  private get file() {
    return path.join(this.folder, "settings.json");
  }
  private read(): ClaudeLaunchChoice {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { netLog: saved?.netLog === true, quicOff: saved?.quicOff === true };
    } catch {
      return { netLog: false, quicOff: false };
    }
  }
  get current(): ClaudeLaunchChoice {
    return { ...this.choice };
  }
  /** Changes what `patch` names, keeps the rest; resolves with the whole choice. */
  set(patch: Partial<ClaudeLaunchChoice>): ClaudeLaunchChoice {
    const next = { ...this.choice };
    if (typeof patch.netLog === "boolean") next.netLog = patch.netLog;
    if (typeof patch.quicOff === "boolean") next.quicOff = patch.quicOff;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    this.choice = next;
    return this.current;
  }
  /** The net logs in the folder, oldest first. */
  logs(): string[] {
    try {
      return fs
        .readdirSync(this.folder)
        .filter((name) => LOG.test(name))
        .sort()
        .map((name) => path.join(this.folder, name));
    } catch {
      return [];
    }
  }
  /**
   * Where the Claude about to be started writes its net log, or undefined while the diagnosis is
   * off. Called right before a launch, while Claude is closed: the older logs are complete, and
   * all but the newest KEEP_LOGS - 1 go, so with the new one KEEP_LOGS remain.
   */
  nextNetLog(): string | undefined {
    if (!this.choice.netLog) return undefined;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    const older = this.logs();
    for (const file of older.slice(0, Math.max(0, older.length - (KEEP_LOGS - 1))))
      fs.rmSync(file, { force: true });
    let file = path.join(this.folder, `claude-net-${logStamp(this.now())}.json`);
    // Two launches within a millisecond would share a name: never reuse one.
    for (let n = 1; fs.existsSync(file); n++)
      file = path.join(this.folder, `claude-net-${logStamp(new Date(this.now().getTime() + n))}.json`);
    return file;
  }
}
