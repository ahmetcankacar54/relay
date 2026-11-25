import os from "node:os";
import path from "node:path";
import {
  ClaudeSettingsUnreadable,
  STATUSLINE_PREVIOUS_FILE,
  installStatusline,
  statuslineCommand as shellCommand,
  uninstallStatusline,
} from "../../../electron/core/claude-statusline";
import { relayPaths } from "../../../electron/core/relay-paths";
import type { Command } from "../command";
import { CliError, EXIT } from "../io";
import { readStatuslineSnapshot, statuslineColor, statuslineText } from "../statusline";

/**
 * `relay statusline`: the line Claude Code shows under its prompt. The launcher runs the plain
 * form from a bundle of its own (statusline-bin.ts); it comes here for `install`, `uninstall`, and
 * when Relay.app has written no snapshot yet, to say so in the user's language.
 */
export const statuslineCommand: Command = async ({ io, deps, parsed, t }) => {
  const [sub, ...extra] = parsed.positionals;
  if (extra.length || (sub !== undefined && sub !== "install" && sub !== "uninstall"))
    throw new CliError(t("statusline.usage"), EXIT.usage);
  const claudeDir = deps.transcriptRoot ?? path.join(os.homedir(), ".claude");
  const previous = path.join(relayPaths(io.env).data, STATUSLINE_PREVIOUS_FILE);
  const file = path.join(claudeDir, "settings.json");
  try {
    if (sub === "install") {
      // This very CLI, by absolute paths (node, then the launcher): Claude Code's non-login shell
      // may not have npm's or nvm's folder on its PATH.
      const self = deps.selfPath ?? process.argv[1] ?? "";
      const outcome = installStatusline(claudeDir, previous, shellCommand([process.execPath, path.resolve(self)]));
      io.stdout(
        outcome === "already"
          ? t("statusline.alreadyInstalled")
          : outcome === "replaced"
            ? t("statusline.installedReplaced", { file })
            : t("statusline.installed", { file }),
      );
      return EXIT.ok;
    }
    if (sub === "uninstall") {
      const outcome = uninstallStatusline(claudeDir, previous);
      io.stdout(
        outcome === "restored"
          ? t("statusline.restored")
          : outcome === "removed"
            ? t("statusline.removed")
            : t("statusline.notInstalled"),
      );
      return EXIT.ok;
    }
  } catch (error) {
    if (error instanceof ClaudeSettingsUnreadable)
      throw new CliError(t("statusline.settingsUnreadable", { file: error.file }), EXIT.failed);
    throw error;
  }
  // `.claude.json` sits beside the `.claude` folder, in the home folder.
  const home = path.dirname(claudeDir);
  const snapshot = readStatuslineSnapshot(io.env, home);
  if (!snapshot) {
    io.stdout(t("statusline.noData"));
    return EXIT.ok;
  }
  const line = statuslineText(snapshot, {
    stdin: (await io.readInput?.()) ?? "",
    env: io.env,
    home,
    now: io.now(),
    color: statuslineColor({ color: !!parsed.flags.color, noColor: !!parsed.flags["no-color"] }, io.isTTY, io.env),
  });
  if (line) io.stdout(line);
  return EXIT.ok;
};
