import fs from "node:fs/promises";
import path from "node:path";

/**
 * The argument a login launch carries on Windows and Linux: Relay then starts in the tray with no
 * window. macOS cannot pass arguments to a login item; there the system says it opened Relay.
 */
export const LOGIN_LAUNCH_FLAG = "--hidden";

/** The parts of Electron's `app` the login item needs, so the rules run without Electron. */
export interface LoginItemHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** The program a login starts: the AppImage on Linux when Relay runs from one. */
  execPath: string;
  getLoginItemSettings(options?: { args?: string[] }): { openAtLogin: boolean };
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    args?: string[];
  }): void;
}

/**
 * `$XDG_CONFIG_HOME/autostart/relay.desktop`, or `~/.config/autostart/relay.desktop` when the
 * variable is unset or not absolute, as the XDG base directory spec says.
 */
export function autostartFile(env: NodeJS.ProcessEnv, home: string) {
  const configured = env.XDG_CONFIG_HOME;
  const config =
    configured && path.isAbsolute(configured)
      ? configured
      : path.join(home, ".config");
  return path.join(config, "autostart", "relay.desktop");
}

/** Characters that make an Exec argument need quotes (Desktop Entry spec, "The Exec key"). */
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/**
 * One Exec argument. A quoted argument escapes `"`, `` ` ``, `$` and `\` with a backslash, and the
 * string escape doubles each backslash again; `%` is doubled so no path reads as a field code.
 */
export function execArgument(arg: string) {
  const literal = arg.replace(/%/g, "%%");
  if (!RESERVED.test(literal)) return literal;
  return `"${literal.replace(/["`$\\]/g, (c) => `\\${c}`).replace(/\\/g, "\\\\")}"`;
}

/** The autostart entry that starts `exec` hidden at login. */
export function autostartEntry(exec: string) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=Relay",
    `Exec=${execArgument(exec)} ${LOGIN_LAUNCH_FLAG}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** The program a Linux login starts: the AppImage itself, never its temporary mount. */
export function linuxExec(host: Pick<LoginItemHost, "env" | "execPath">) {
  return host.env.APPIMAGE || host.execPath;
}

/**
 * Whether this run is a login launch, which stays in the tray. Windows and Linux pass the flag;
 * macOS reports it through `wasOpenedAtLogin`.
 */
export function launchedAtLogin(
  argv: readonly string[],
  platform: NodeJS.Platform,
  wasOpenedAtLogin: boolean,
) {
  return platform === "darwin"
    ? wasOpenedAtLogin
    : argv.includes(LOGIN_LAUNCH_FLAG);
}

/** Whether the system starts Relay at login now. */
export async function launchAtLoginEnabled(host: LoginItemHost) {
  if (host.platform === "linux")
    return fs
      .readFile(autostartFile(host.env, host.home), "utf8")
      .then((text) => text === autostartEntry(linuxExec(host)))
      .catch(() => false);
  if (host.platform === "win32")
    return host.getLoginItemSettings({ args: [LOGIN_LAUNCH_FLAG] }).openAtLogin;
  if (host.platform === "darwin")
    return host.getLoginItemSettings().openAtLogin;
  return false;
}

/**
 * Makes the system start Relay at login, or stop doing so: the login item on macOS and Windows,
 * the XDG autostart entry on Linux. Does nothing when the system already matches, so a start
 * never re-registers a macOS login item or rewrites a file the user left alone.
 */
export async function setLaunchAtLogin(enabled: boolean, host: LoginItemHost) {
  if (enabled === (await launchAtLoginEnabled(host))) return;
  if (host.platform === "linux") {
    const file = autostartFile(host.env, host.home);
    if (!enabled) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, autostartEntry(linuxExec(host)), { mode: 0o644 });
    return;
  }
  if (host.platform === "win32")
    host.setLoginItemSettings({
      openAtLogin: enabled,
      args: [LOGIN_LAUNCH_FLAG],
    });
  else if (host.platform === "darwin")
    host.setLoginItemSettings({ openAtLogin: enabled });
}
