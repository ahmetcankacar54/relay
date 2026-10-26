import fs from "node:fs";
import path from "node:path";
import type { ClaudeLaunchChoice } from "../../shared/types";

/**
 * How Relay starts Claude, chosen outside Relay's registry so a change never asks the registry
 * for a new layout: `quicOff`, Claude starts without HTTP/3. On some networks claude.ai's HTTP/3
 * transfers stall after a working handshake, so Chromium never falls back and the page stays
 * grey (measured 2026-10-26: 13 of 73 assets answered in 8 s over HTTP/3, 94 of 98 in 2 s over
 * HTTP/2). Relay turns it on itself once a stuck start loads without HTTP/3.
 *
 * There is no net log any more: Claude 3.6556 and later refuses to start with --log-net-log on
 * its command line. A `netLog` an older Relay saved is ignored.
 */
export class SwitchDiagnostics {
  private choice: ClaudeLaunchChoice;
  constructor(
    /** The folder the choice lives in, created when first saved. */
    readonly folder: string,
  ) {
    this.choice = this.read();
  }
  private get file() {
    return path.join(this.folder, "settings.json");
  }
  private read(): ClaudeLaunchChoice {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return { quicOff: saved?.quicOff === true };
    } catch {
      return { quicOff: false };
    }
  }
  get current(): ClaudeLaunchChoice {
    return { ...this.choice };
  }
  /** Changes what `patch` names, keeps the rest; resolves with the whole choice. */
  set(patch: Partial<ClaudeLaunchChoice>): ClaudeLaunchChoice {
    const next = { ...this.choice };
    if (typeof patch.quicOff === "boolean") next.quicOff = patch.quicOff;
    fs.mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(next), { mode: 0o600 });
    this.choice = next;
    return this.current;
  }
}
