import { app } from "electron";
import path from "node:path";
import { DEFAULT_TERMINAL_MODE } from "../../shared/terminal-identity";
import { buildStatuslineSnapshot, writeStatuslineFile } from "../core/statusline-file";
import { getAppLocale } from "../i18n";
import { observedDesktop, proxyServer, service, usage } from "./state";
/** A burst of changes (gateway answers, limit reads) writes the status line snapshot once. */
const STATUSLINE_WRITE_DELAY_MS = 1_000;
let statuslineTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Writes `<userData>/statusline.json` soon, for `relay statusline` in Claude Code: every limit read,
 * gateway answer, switch and token tick asks for it, so the file is never older than a token tick
 * while Relay runs. Never throws; an unwritten file only shows its age in the status line.
 */
export function scheduleStatusline() {
  if (statuslineTimer) return;
  statuslineTimer = setTimeout(() => {
    statuslineTimer = undefined;
    try {
      const { accounts, settings } = service.store.state;
      writeStatuslineFile(
        app.getPath("userData"),
        buildStatuslineSnapshot({
          accounts,
          usage: usage?.snapshot() ?? {},
          desktopAccountId: observedDesktop?.activeProfileId,
          terminalMode: settings.terminalCli ?? DEFAULT_TERMINAL_MODE,
          gatewaySessions: proxyServer?.sessionCache.list(),
          profiles: path.join(service.store.root, "profiles"),
          language: getAppLocale(),
          zone: settings.planning.timeZone,
          now: Date.now(),
        }),
      );
    } catch {
      // The status line says how old the last snapshot is.
    }
  }, STATUSLINE_WRITE_DELAY_MS);
  statuslineTimer.unref();
}
