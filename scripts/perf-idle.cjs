// The idle measurement's Electron side, run through scripts/perf-idle.mjs: starts the built Relay
// with a fresh profile in a temp folder and a temp HOME, so it sees no Claude app, no Claude Code
// sign-in and no saved accounts of the user's, and logs every program it starts. Nothing it
// does reaches the user's Keychain: `/usr/bin/security` and the vault key both go to a fake that
// only logs the call and keeps the vault key in the temp folder.
const { app, BrowserWindow } = require("electron");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = process.env.RELAY_PERF_ROOT;
if (!root) {
  console.error("RELAY_PERF_ROOT is not set: run this through scripts/perf-idle.mjs.");
  process.exit(1);
}
const spawns = path.join(root, "spawns.jsonl");

for (const name of ["userData", "appData", "logs", "crashDumps"]) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  app.setPath(name, dir);
}

// The fake Keychain tool: each call is one line in spawns.jsonl (from the patch below, which
// also sends Relay's direct `/usr/bin/security` calls here); the vault key stays in the folder.
const security = path.join(root, "fake-security");
fs.writeFileSync(
  security,
  `#!/bin/sh
dir="${root}"
if [ "$1" = "-i" ]; then
  value="$(cat | grep add-generic-password | sed -E 's/.* -w ([^ ]+).*/\\1/' | head -1)"
  [ -f "$dir/vault-key" ] || printf '%s' "$value" > "$dir/vault-key"
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  [ -f "$dir/vault-key" ] || exit 44
  cat "$dir/vault-key"; echo
  exit 0
fi
exit 44
`,
  { mode: 0o700 },
);
process.env.RELAY_SECURITY_TOOL = security;

/**
 * One line per program started: when, its name, and for the Keychain tool its subcommand (never
 * the rest of the arguments) and whether Relay called `/usr/bin/security` itself ("system") or
 * the vault key's tool ("vault"). A direct `/usr/bin/security` call is redirected to the fake.
 */
function logged(file, args) {
  const name = path.basename(String(file));
  const keychain = name === "security" || file === security;
  fs.appendFileSync(
    spawns,
    `${JSON.stringify({ at: Date.now(), name: keychain ? "security" : name, ...(keychain ? { command: args?.[0], via: file === security ? "vault" : "system" } : {}) })}\n`,
  );
  return file === "/usr/bin/security" ? security : file;
}
// Every asynchronous start (spawn, execFile, exec, fork) goes through ChildProcess#spawn.
const spawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  const file = logged(options.file, options.args?.slice(1));
  if (file !== options.file) options = { ...options, file, args: [file, ...options.args.slice(1)] };
  return spawn.call(this, options);
};
for (const name of ["spawnSync", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = (file, ...rest) => original(logged(file, Array.isArray(rest[0]) ? rest[0] : []), ...rest);
}
const execSync = childProcess.execSync;
childProcess.execSync = (command, ...rest) => {
  logged(String(command).split(" ")[0], String(command).split(" ").slice(1));
  return execSync(command, ...rest);
};

require(process.env.RELAY_PERF_MAIN || "../dist-electron/main.cjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let win;
  for (let i = 0; i < 1200 && !win; i++) {
    // The macOS menu bar panel and the switch window are extra windows; the main one is the rest.
    win = BrowserWindow.getAllWindows().find(
      (w) => !/(panel|switch)\.html$/.test(w.webContents.getURL()) && w.webContents.getURL() && !w.webContents.isLoading(),
    );
    if (!win) await delay(100);
  }
  // "closed": the window goes to the menu bar as its close button sends it, where Relay idles.
  if (win && process.env.RELAY_PERF_WINDOW === "closed") win.close();
  // "open": in front and focused, as when someone looks at it; a window behind another app holds the panda
  // still (src/lib/motion.ts) and would measure less. Each focus change is logged so the result can say.
  if (win && process.env.RELAY_PERF_WINDOW === "open") {
    const focus = path.join(root, "focus.jsonl");
    const log = (focused) => fs.appendFileSync(focus, `${JSON.stringify({ at: Date.now(), focused })}\n`);
    win.on("focus", () => log(true));
    win.on("blur", () => log(false));
    app.focus({ steal: true });
    win.focus();
    await delay(500);
    log(win.isFocused());
  }
  fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({ at: Date.now(), window: !!win }));
});
