import os from "node:os";
import path from "node:path";

/** Where Relay and Claude Desktop keep their data, for code that runs outside Electron. */
export interface RelayPaths {
  /** Relay's data folder: the menu-bar app's userData. */
  data: string;
  /** Claude Desktop's data folder. */
  claude: string;
  /** Claude.app bundles to look for, first found wins; none by default off macOS. */
  claudeApps: string[];
  vault: string;
  profiles: string;
  /** Per-account profile locks. */
  locks: string;
  /** The CLI's detached-worker records. */
  cliOperations: string;
}

/** An absolute override from the environment, or undefined. */
function override(value: string | undefined) {
  return value && path.isAbsolute(value) ? path.resolve(value) : undefined;
}

/**
 * The folder apps keep their data in, as Electron's `app.getPath("appData")`: Application Support
 * on macOS, %APPDATA% on Windows, and on Linux $XDG_CONFIG_HOME when absolute, else ~/.config.
 */
export function appDataRoot(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support");
  if (platform === "win32")
    return env.APPDATA && path.win32.isAbsolute(env.APPDATA)
      ? env.APPDATA
      : path.win32.join(home, "AppData", "Roaming");
  const xdg = env.XDG_CONFIG_HOME;
  return xdg && path.posix.isAbsolute(xdg) ? path.posix.resolve(xdg) : path.posix.join(home, ".config");
}

/**
 * The folders Relay uses. RELAY_HOME, RELAY_CLAUDE_DIR and RELAY_CLAUDE_APP override them,
 * for tests and power users; a relative override is ignored.
 */
export function relayPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): RelayPaths {
  const support = appDataRoot(platform, home, env);
  const data = override(env.RELAY_HOME) ?? path.join(support, "Relay");
  const app = override(env.RELAY_CLAUDE_APP);
  return {
    data,
    claude: override(env.RELAY_CLAUDE_DIR) ?? path.join(support, "Claude"),
    claudeApps: app
      ? [app]
      : platform === "darwin"
        ? ["/Applications/Claude.app", path.join(home, "Applications", "Claude.app")]
        : [],
    vault: path.join(data, "desktop-vault"),
    profiles: path.join(data, "profiles"),
    locks: path.join(data, "profiles", ".locks"),
    cliOperations: path.join(data, "cli-operations"),
  };
}
