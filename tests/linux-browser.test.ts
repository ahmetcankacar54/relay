import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  browserRunning,
  dataDir,
  extensionInstances,
  findCommand,
  linuxBrowserSystem,
  linuxMainPids,
  lockOwner,
  sessionEnvironment,
  type BrowserSystem,
} from "../electron/core/browser-system";
import { extensionGuide, instanceLine } from "../src/lib/extension-ui";
import {
  CLAUDE_EXTENSION_ID,
  DEFAULT_EXTENSION,
  browserApps,
  type ExtensionStatus,
} from "../shared/browser-extension";
import { testT } from "./i18n";

const t = testT("en");

test("Linux looks in the browsers with a Linux build only, under XDG_CONFIG_HOME", { skip: process.platform === "win32" && "Linux and macOS paths: the code joins them with the host's path module" }, () => {
  const apps = browserApps("linux");
  assert.deepEqual([...apps], ["chrome", "brave", "edge", "chromium", "vivaldi", "chrome-beta", "chrome-dev"]);
  assert.equal(browserApps("darwin").length, 11);
  const system = linuxBrowserSystem("/home/u", { XDG_CONFIG_HOME: "/cfg" });
  assert.equal(system.platform, "linux");
  assert.equal(dataDir(system, "chrome"), "/cfg/google-chrome");
  assert.equal(dataDir(system, "chrome-dev"), "/cfg/google-chrome-unstable");
  assert.equal(dataDir(system, "brave"), "/cfg/BraveSoftware/Brave-Browser");
  // A relative XDG_CONFIG_HOME is invalid by the spec: ~/.config.
  assert.equal(dataDir(linuxBrowserSystem("/home/u", { XDG_CONFIG_HOME: "cfg" }), "edge"), "/home/u/.config/microsoft-edge");
  assert.equal(dataDir(linuxBrowserSystem("/home/u", {}), "vivaldi"), "/home/u/.config/vivaldi");
});

test("a Linux profile with the extension is found, through a linked data folder too", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-linux-browser-"));
  try {
    // profile-sync-daemon keeps ~/.config/google-chrome as a link into /run.
    const real = path.join(home, "psd", "google-chrome");
    fs.mkdirSync(path.join(real, "Default", "Local Extension Settings", CLAUDE_EXTENSION_ID), { recursive: true });
    fs.writeFileSync(
      path.join(real, "Local State"),
      JSON.stringify({ profile: { info_cache: { Default: { name: "Person 1" } } } }),
    );
    fs.mkdirSync(path.join(home, ".config"));
    fs.symlinkSync(real, path.join(home, ".config", "google-chrome"));
    // A mac-only browser's folder name is never looked in.
    fs.mkdirSync(path.join(home, ".config", "Arc", "User Data"), { recursive: true });
    const instances = extensionInstances(linuxBrowserSystem(home, {}));
    assert.deepEqual(
      instances.map((i) => [i.app, i.profile, i.name, i.opened]),
      [["chrome", "Default", "Person 1", true]],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a SingletonLock target names its host and pid", () => {
  assert.deepEqual(lockOwner("merthan-12345"), { host: "merthan", pid: 12345 });
  assert.deepEqual(lockOwner("my-host-name-7"), { host: "my-host-name", pid: 7 });
  assert.equal(lockOwner(undefined), undefined);
  assert.equal(lockOwner("merthan"), undefined);
  assert.equal(lockOwner("merthan-0"), undefined);
  assert.equal(lockOwner("merthan-99999999999999999999"), undefined);
});

const fakeSystem = (over: Partial<BrowserSystem>): BrowserSystem =>
  ({
    support: "/cfg",
    platform: "linux",
    hostname: "here",
    readLink: () => undefined,
    alive: () => false,
    processes: async () => "",
    ...over,
  }) as BrowserSystem;

test("on Linux a browser runs by its live lock, another machine's lock, or its executable", { skip: process.platform === "win32" && "Linux and macOS paths: the code joins them with the host's path module" }, async () => {
  const lockAt = (target: string) => (file: string) =>
    file === "/cfg/google-chrome/SingletonLock" ? target : undefined;
  assert.equal(await browserRunning(fakeSystem({ readLink: lockAt("here-42"), alive: (pid) => pid === 42 }), "chrome"), true);
  // A stale lock of this machine is not running.
  assert.equal(await browserRunning(fakeSystem({ readLink: lockAt("here-42") }), "chrome"), false);
  // Another machine's lock (a shared home): that browser holds the profile.
  assert.equal(await browserRunning(fakeSystem({ readLink: lockAt("there-42") }), "chrome"), true);
  // No lock, but the executable runs; another browser's executable does not count.
  assert.equal(await browserRunning(fakeSystem({ processes: async () => "/usr/bin/bash\n/opt/google/chrome/chrome" }), "chrome"), true);
  assert.equal(await browserRunning(fakeSystem({ processes: async () => "/opt/google/chrome-beta/chrome" }), "chrome"), false);
  assert.equal(await browserRunning(fakeSystem({ processes: async () => "/home/u/Applications/chrome.app/Contents/MacOS/Google Chrome" }), "chrome"), false);
});

test("the Linux quit signals the browser's main process, never a helper or a stranger", () => {
  const procs = [
    { pid: 10, exe: "/opt/google/chrome/chrome", args: ["/opt/google/chrome/chrome"] },
    { pid: 11, exe: "/opt/google/chrome/chrome", args: ["/opt/google/chrome/chrome", "--type=zygote"] },
    { pid: 12, exe: "/opt/google/chrome/chrome", args: ["/opt/google/chrome/chrome", "--type=renderer"] },
    { pid: 20, exe: "/usr/bin/bash", args: ["bash"] },
    { pid: 30, exe: "/opt/google/chrome-beta/chrome", args: ["/opt/google/chrome-beta/chrome"] },
  ];
  // The lock's pid, when it is a main browser process of this machine.
  assert.deepEqual(linuxMainPids("chrome", "host-10", "host", procs), [10]);
  // A recycled pid (a shell now) or a helper is never taken from the lock: the scan decides.
  assert.deepEqual(linuxMainPids("chrome", "host-20", "host", procs), [10]);
  assert.deepEqual(linuxMainPids("chrome", "host-12", "host", procs), [10]);
  // Another machine's lock is not this machine's pid.
  assert.deepEqual(linuxMainPids("chrome", "other-20", "host", procs), [10]);
  assert.deepEqual(linuxMainPids("chrome-beta", undefined, "host", procs), [30]);
  assert.deepEqual(linuxMainPids("brave", undefined, "host", procs), []);
});

test("a browser's launcher is the first command found on PATH", { skip: process.platform === "win32" && "Linux and macOS paths: the code joins them with the host's path module" }, () => {
  const present = new Set(["/usr/bin/google-chrome", "/opt/bin/google-chrome-stable"]);
  const has = (file: string) => present.has(file);
  assert.equal(findCommand(["google-chrome-stable", "google-chrome"], ["/usr/bin", "/opt/bin"], has), "/opt/bin/google-chrome-stable");
  assert.equal(findCommand(["google-chrome"], ["relative", "/usr/bin"], has), "/usr/bin/google-chrome");
  assert.equal(findCommand(["chromium"], ["/usr/bin"], has), undefined);
});

test("a browser Relay starts gets the graphical session, not Electron's or an AppImage's variables", () => {
  const env = sessionEnvironment({
    HOME: "/home/u",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/run/user/1000",
    XDG_CURRENT_DESKTOP: "KDE",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    LC_ALL: "en_US.UTF-8",
    ELECTRON_RUN_AS_NODE: "1",
    CHROME_DESKTOP: "relay.desktop",
    LD_LIBRARY_PATH: "/tmp/.mount/usr/lib",
    APPDIR: "/tmp/.mount",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "HOME",
    "LC_ALL",
    "PATH",
    "WAYLAND_DISPLAY",
    "XDG_CURRENT_DESKTOP",
    "XDG_RUNTIME_DIR",
  ]);
});

test("with no extension found on Linux, the card names Linux browsers and no Mac", () => {
  const status: ExtensionStatus = { setting: { ...DEFAULT_EXTENSION, mode: "restart" }, instances: [], saved: [] };
  const line = instanceLine(status, t, "linux");
  assert.match(line, /No Claude extension found on this computer \(Chrome, Brave, Edge, Chromium, Vivaldi, Chrome Beta and Chrome Dev\)\./);
  const guide = extensionGuide({ id: "a" } as any, status, [], t, "en", undefined, "linux");
  assert.equal(guide.label, "No Claude extension found on this computer.");
  assert.doesNotMatch(guide.detail ?? "", /Arc|Comet|Canary|Dia/);
  // macOS keeps its words.
  assert.match(instanceLine(status, t), /on this Mac \(.*Arc.*Comet\)\./);
});
