import test from "node:test";
import assert from "node:assert/strict";
import {
  linuxClaudeCommand,
  linuxInstances,
  linuxProcessRows,
} from "../electron/core/desktop-instances";
import { linuxElectronVersion, linuxLaunchEnv } from "../electron/core/desktop-host-node";
import { claudeLog } from "../electron/core/desktop-launch";
import { isClaudeDesktopExecutable } from "../electron/core/environment";

const EXE = "/usr/bin/claude-desktop";
const LIB = "/usr/lib/claude-desktop/claude-desktop";
const WINDOW_DIR = "/home/me/.config/Relay/claude-windows/3c9e1f20-4b7a-4d1e-9f2a-6d5b8c0e7a14/data";

/** A `ps -eo pid=,ppid=,args=` listing as Linux prints it. */
const listing = (rows: [pid: number, ppid: number, args: string][]) =>
  ["      1       0 /sbin/init", ...rows.map(([pid, ppid, args]) => `${String(pid).padStart(7)} ${String(ppid).padStart(7)} ${args}`)].join("\n");

test("Linux ps rows: pid, parent, the command as executable, kernel threads kept as they are", () => {
  const rows = linuxProcessRows(
    `${listing([[4100, 1, `${EXE} --enable-features=x`]])}\n      2       0 [kthreadd]\n\n  garbage`,
  );
  assert.deepEqual(rows[1], { pid: 4100, ppid: 1, executable: EXE, args: `${EXE} --enable-features=x` });
  assert.deepEqual(rows[2], { pid: 2, ppid: 0, executable: "[kthreadd]", args: "[kthreadd]" });
  assert.equal(rows.length, 3);
});

test("the official package: the main Claude, its helpers and a window are told apart by app and parent", { skip: process.platform === "win32" && "Linux and macOS paths: the code joins them with the host's path module" }, () => {
  const rows = linuxProcessRows(
    listing([
      [4100, 1, EXE],
      [4105, 4100, `${LIB} --type=zygote --no-zygote-sandbox`],
      [4106, 4100, `/usr/lib/claude-desktop/chrome-sandbox ${LIB} --type=zygote`],
      [4107, 4106, `${LIB} --type=zygote`],
      [4110, 4107, `${LIB} --type=renderer --user-data-dir=/home/me/.config/Claude --app-path=/usr/lib/claude-desktop/resources/app.asar`],
      [4108, 1, "/usr/lib/claude-desktop/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/home/me/.config/Claude/Crashpad"],
      [4120, 4100, `${LIB} --type=gpu-process --ozone-platform=wayland --user-data-dir=/home/me/.config/Claude`],
      [4121, 4100, `${LIB} --type=utility --utility-sub-type=network.mojom.NetworkService`],
      // Claude's executable run as Node for an extension's server.
      [4130, 4100, `${LIB} /home/me/.config/Claude/Claude Extensions/x/server/index.js`],
      [4140, 4100, "/home/me/.config/Claude/claude-code/2.1.321/ded331c1fbf8/claude --output-format stream-json"],
      [4150, 4100, "/usr/lib/claude-desktop/resources/virtiofsd --socket-path=/run/user/1000/x.sock"],
      [4160, 1, "/usr/lib/claude-desktop/resources/chrome-native-host chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/"],
      [5200, 600, `${EXE} --user-data-dir=${WINDOW_DIR} --disable-quic`],
      [5205, 5200, `${LIB} --type=zygote --no-zygote-sandbox`],
      [5210, 5205, `${LIB} --type=renderer --user-data-dir=${WINDOW_DIR}`],
      [5220, 1, `${LIB} --type=utility --user-data-dir=${WINDOW_DIR}`],
      [600, 1, "/opt/Relay/relay"],
      [700, 650, "/home/me/.local/bin/claude --resume"],
      [710, 650, "grep claude-desktop"],
      [720, 650, "/usr/bin/vim /usr/lib/claude-desktop/resources/notes.txt"],
    ]),
  );
  const claude = linuxInstances(rows, EXE, 600);
  assert.deepEqual(claude.main.sort((a, b) => a - b), [4100, 4105, 4106, 4107, 4110, 4120, 4121, 4130, 4150]);
  assert.deepEqual(claude.mainApps, [4100]);
  assert.equal(claude.mainPid, 4100);
  assert.equal(claude.windows.length, 1);
  assert.equal(claude.windows[0].dir, WINDOW_DIR);
  assert.equal(claude.windows[0].pid, 5200);
  // The orphaned helper goes to the window its own switch names.
  assert.deepEqual(claude.windows[0].pids.sort((a, b) => a - b), [5200, 5205, 5210, 5220]);
});

test("a Claude started from the desktop entry by bare name, or through the library path, is the main one", () => {
  for (const command of ["claude-desktop", LIB]) {
    const claude = linuxInstances(
      linuxProcessRows(listing([[300, 1, `${command} claude://code/new`], [301, 300, `${LIB} --type=zygote`]])),
      EXE,
      1,
    );
    assert.deepEqual([claude.mainPid, claude.main], [300, [300, 301]], command);
  }
  // A chosen library path still finds a Claude started through the launcher's link.
  assert.equal(linuxInstances(linuxProcessRows(listing([[300, 1, EXE]])), LIB, 1).mainPid, 300);
  // Nothing running, or only Chrome's host left: closed.
  const leftover = linuxInstances(
    linuxProcessRows(listing([[4160, 1, "/usr/lib/claude-desktop/resources/chrome-native-host x"]])),
    EXE,
    1,
  );
  assert.deepEqual(leftover, { main: [], mainApps: [], mainPid: undefined, windows: [] });
});

test("Linux finds Claude's processes through its launcher, install folder or AppImage, never the Code CLI", () => {
  assert.ok(linuxClaudeCommand("/bin/bash /usr/bin/claude-desktop", EXE));
  assert.ok(linuxClaudeCommand("/usr/lib/claude-desktop/node_modules/electron/dist/electron /usr/lib/claude-desktop/app.asar", EXE));
  assert.ok(linuxClaudeCommand("/tmp/.mount_ClaudeAbc/claude --type=renderer", EXE));
  assert.ok(!linuxClaudeCommand("/home/me/.local/bin/claude --resume", EXE));
  assert.ok(!linuxClaudeCommand("node /home/me/.local/bin/claude", EXE));
  // A chosen binary is matched by its own name too, unless that name is the CLI's.
  assert.ok(linuxClaudeCommand("/usr/bin/Claude-Desktop --x", "/opt/x/Claude-Desktop"));
  assert.ok(!linuxClaudeCommand("/usr/local/bin/claude", "/opt/odd/claude"));
  // A process that only names a file in the install folder or the launcher is not Claude.
  assert.ok(!linuxClaudeCommand("/usr/bin/vim /usr/lib/claude-desktop/resources/notes.txt", EXE));
  assert.ok(!linuxClaudeCommand("grep -r token /opt/claude-desktop/", EXE));
  assert.ok(!linuxClaudeCommand("tail -f /usr/lib/claude-desktop/app.log", EXE));
});

test("a launcher script started Claude: the script is the app, Electron under it is its helper", () => {
  const claude = linuxInstances(
    linuxProcessRows(
      listing([
        [800, 1, `/bin/bash ${EXE}`],
        [801, 800, "/usr/lib/claude-desktop/node_modules/electron/dist/electron /usr/lib/claude-desktop/app.asar"],
      ]),
    ),
    EXE,
    1,
  );
  assert.deepEqual([claude.mainApps, claude.main], [[800], [800, 801]]);
});

test("Claude starts with the session's environment, without Relay's or a Claude Code session's", () => {
  const env = linuxLaunchEnv({
    HOME: "/home/me",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_CURRENT_DESKTOP: "Unity",
    ORIGINAL_XDG_CURRENT_DESKTOP: "KDE",
    LANG: "tr_TR.UTF-8",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CONFIG_DIR: "/x",
    ANTHROPIC_API_KEY: "k",
    ELECTRON_RUN_AS_NODE: "1",
    RELAY_HOME: "/r",
    NODE_OPTIONS: "--inspect",
    CHROME_DESKTOP: "relay.desktop",
    APPIMAGE: "/a/Relay.AppImage",
  });
  assert.deepEqual(env, {
    HOME: "/home/me",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_CURRENT_DESKTOP: "KDE",
    LANG: "tr_TR.UTF-8",
  });
});

test("the Electron version of a Linux Claude comes from the version file beside the real executable", () => {
  const files = (links: Record<string, string>, versions: Record<string, string>) => ({
    realpath: (p: string) => {
      if (p === "/gone") throw new Error("ENOENT");
      return links[p] ?? p;
    },
    read: (p: string) => {
      if (!(p in versions)) throw new Error("ENOENT");
      return versions[p];
    },
  });
  assert.equal(
    linuxElectronVersion(EXE, files({ [EXE]: LIB }, { "/usr/lib/claude-desktop/version": "45.2.1\n" })),
    "45.2.1",
  );
  assert.equal(
    linuxElectronVersion("/opt/Claude/claude", files({}, { "/opt/Claude/version": "44.0.0-beta.3" })),
    "44.0.0-beta.3",
  );
  // A launcher that is not a link still finds the package's folder; a junk file is no version.
  assert.equal(linuxElectronVersion("/gone", files({}, { "/usr/lib/claude-desktop/version": "45.2.1" })), "45.2.1");
  assert.equal(linuxElectronVersion(EXE, files({}, { "/usr/bin/version": "hello" })), undefined);
});

test("Claude's log: Library/Logs on macOS, the data folder's logs on Linux, unknown on Windows", { skip: process.platform === "win32" && "Linux and macOS paths: the code joins them with the host's path module" }, () => {
  assert.deepEqual(claudeLog("/Users/me", "darwin", {}), {
    current: "/Users/me/Library/Logs/Claude/main.log",
    rotated: "/Users/me/Library/Logs/Claude/main1.log",
  });
  assert.deepEqual(claudeLog("/home/me", "linux", {}), {
    current: "/home/me/.config/Claude/logs/main.log",
    rotated: "/home/me/.config/Claude/logs/main1.log",
  });
  assert.equal(claudeLog("/home/me", "linux", { XDG_CONFIG_HOME: "/xdg" })?.current, "/xdg/Claude/logs/main.log");
  // A relative XDG_CONFIG_HOME is invalid by the spec and ignored.
  assert.equal(claudeLog("/home/me", "linux", { XDG_CONFIG_HOME: "rel" })?.current, "/home/me/.config/Claude/logs/main.log");
  assert.equal(claudeLog("C:\\Users\\me", "win32", {}), undefined);
});

test("Claude Desktop is never taken for the Claude Code CLI", () => {
  const links: Record<string, string> = { "/bin/claude-desktop": LIB, [EXE]: LIB, "/home/me/bin/cd": LIB };
  const options = (platform: NodeJS.Platform, desktop: string[]) => ({
    platform,
    desktop,
    realpath: (p: string) => links[p] ?? p,
  });
  const linux = options("linux", [EXE, LIB]);
  // The user's state: /bin is a link to /usr/bin on Arch.
  assert.ok(isClaudeDesktopExecutable("/bin/claude-desktop", linux));
  assert.ok(isClaudeDesktopExecutable(LIB, linux));
  // Renamed, but the same file as Desktop's.
  assert.ok(isClaudeDesktopExecutable("/home/me/bin/cd", linux));
  assert.ok(isClaudeDesktopExecutable("/opt/x/claude-desktop", options("linux", [])));
  assert.ok(!isClaudeDesktopExecutable("/home/me/.local/bin/claude", linux));
  assert.ok(
    !isClaudeDesktopExecutable("/home/me/.config/Claude/claude-code/2.1.321/ded331c1fbf8/claude", linux),
  );
  const mac = options("darwin", ["/Applications/Claude.app/Contents/MacOS/Claude"]);
  assert.ok(isClaudeDesktopExecutable("/Applications/Claude.app/Contents/MacOS/Claude", mac));
  assert.ok(isClaudeDesktopExecutable("/Users/me/Applications/Claude.app/Contents/MacOS/Claude", options("darwin", [])));
  // Desktop's own downloaded CLI lives in a claude.app too, named claude: it is the CLI.
  assert.ok(
    !isClaudeDesktopExecutable(
      "/Users/me/Library/Application Support/Claude/claude-code/2.1.309/b/claude.app/Contents/MacOS/claude",
      mac,
    ),
  );
  assert.ok(!isClaudeDesktopExecutable("/opt/homebrew/bin/claude", mac));
  assert.ok(isClaudeDesktopExecutable("C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe", options("win32", [])));
  assert.ok(!isClaudeDesktopExecutable("C:\\Users\\me\\.local\\bin\\claude.exe", options("win32", [])));
});
