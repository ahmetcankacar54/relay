import os from "node:os";
import path from "node:path";

/** Where Relay and Claude Desktop keep their data, for code that runs outside Electron. */
export interface RelayPaths {
  /** Relay's data folder: the menu-bar app's userData. */
  data: string;
  /** Claude Desktop's data folder. */
  claude: string;
  /** Claude.app bundles to look for, first found wins. */
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
 * The folders Relay uses. RELAY_HOME, RELAY_CLAUDE_DIR and RELAY_CLAUDE_APP override them,
 * for tests and power users; a relative override is ignored.
 */
export function relayPaths(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): RelayPaths {
  const support = path.join(home, "Library", "Application Support");
  const data = override(env.RELAY_HOME) ?? path.join(support, "Relay");
  const app = override(env.RELAY_CLAUDE_APP);
  return {
    data,
    claude: override(env.RELAY_CLAUDE_DIR) ?? path.join(support, "Claude"),
    claudeApps: app
      ? [app]
      : ["/Applications/Claude.app", path.join(home, "Applications", "Claude.app")],
    vault: path.join(data, "desktop-vault"),
    profiles: path.join(data, "profiles"),
    locks: path.join(data, "profiles", ".locks"),
    cliOperations: path.join(data, "cli-operations"),
  };
}
