import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_EXTENSION_ID,
  localStateProfiles,
  openArgs,
} from "../shared/browser-profiles";
import {
  browserRunning,
  installedBrowsers,
  macBrowserSystem,
  openBrowserProfile,
  type BrowserSystem,
} from "../electron/core/browser-profiles";

const BRAVE = "BraveSoftware/Brave-Browser";
const localState = {
  profile: {
    info_cache: {
      Default: { name: "Work", avatar_icon: "x", gaia_id: "not-read" },
      "Profile 2": { name: "Alto" },
      "Profile 1": { name: "  " },
      "Guest Profile": { name: "Guest" },
      "Profile 9": { name: "Gone", is_omitted_from_profile_list: true },
      "../escape": { name: "Bad" },
    },
    profiles_order: ["Default", "Profile 2", "Profile 1"],
    last_active_profiles: ["Default"],
  },
  os_crypt: { secret: "never-read" },
};

/** A home with Brave's Local State, run through the real file reads; `open` and pids are faked. */
function home(t: any, options: { pid?: number; state?: unknown } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-browser-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const support = path.join(dir, "Library", "Application Support");
  const brave = path.join(support, BRAVE);
  fs.mkdirSync(path.join(brave, "Profile 2", "Extensions", CLAUDE_EXTENSION_ID), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(brave, "Local State"),
    JSON.stringify(options.state ?? localState),
  );
  if (options.pid) fs.symlinkSync(`EE-66-${options.pid}`, path.join(brave, "SingletonLock"));
  const opened: string[][] = [];
  const alive = new Set<number>(options.pid ? [options.pid] : []);
  const system: BrowserSystem = {
    ...macBrowserSystem(dir),
    alive: (pid) => alive.has(pid),
    open: async (args) => {
      opened.push(args);
    },
  };
  return { system, opened, brave, alive };
}

test("profiles come from Local State's info_cache in the browser's order, without guest, hidden or unsafe folders", () => {
  assert.deepEqual(localStateProfiles(localState), [
    { profile: "Default", name: "Work" },
    { profile: "Profile 2", name: "Alto" },
    { profile: "Profile 1", name: "Profile 1" },
  ]);
  assert.deepEqual(localStateProfiles(undefined), []);
  assert.deepEqual(localStateProfiles({ profile: { info_cache: [] } }), []);
});

test("only browsers with a Local State are listed, each profile marked by the extension folder", (t) => {
  const { system } = home(t);
  assert.deepEqual(installedBrowsers(system), [
    {
      app: "brave",
      profiles: [
        { profile: "Default", name: "Work", extension: false },
        { profile: "Profile 2", name: "Alto", extension: true },
        { profile: "Profile 1", name: "Profile 1", extension: false },
      ],
    },
  ]);
});

test("a broken Local State lists no browser", (t) => {
  const { system, brave } = home(t);
  fs.writeFileSync(path.join(brave, "Local State"), "{not json");
  assert.deepEqual(installedBrowsers(system), []);
});

test("the browser runs only while the pid in its SingletonLock link is alive", (t) => {
  const running = home(t, { pid: 4242 });
  assert.equal(browserRunning(running.system, "brave"), true);
  running.alive.clear();
  assert.equal(browserRunning(running.system, "brave"), false);
  assert.equal(browserRunning(home(t).system, "brave"), false);
});

test("a profile with a window in a running browser is left alone", async (t) => {
  const { system, opened } = home(t, { pid: 4242 });
  const result = await openBrowserProfile(system, {
    app: "brave",
    profile: "Default",
    name: "Work",
  });
  assert.equal(result, "open");
  assert.deepEqual(opened, []);
});

test("a profile without a window, or in a browser that is not running, is opened with open -n -b", async (t) => {
  const running = home(t, { pid: 4242 });
  assert.equal(
    await openBrowserProfile(running.system, { app: "brave", profile: "Profile 2", name: "Alto" }),
    "opened",
  );
  assert.deepEqual(running.opened, [
    ["-n", "-b", "com.brave.Browser", "--args", "--profile-directory=Profile 2"],
  ]);
  // After a quit, last_active_profiles still lists what it will restore.
  const closed = home(t);
  assert.equal(
    await openBrowserProfile(closed.system, { app: "brave", profile: "Default", name: "Work" }),
    "opened",
  );
  assert.deepEqual(closed.opened, [
    ["-n", "-b", "com.brave.Browser", "--args", "--profile-directory=Default"],
  ]);
});

test("a removed profile or browser is missing, and a failing open never throws", async (t) => {
  const { system, opened } = home(t);
  assert.equal(
    await openBrowserProfile(system, { app: "brave", profile: "Profile 7", name: "Old" }),
    "missing",
  );
  assert.equal(
    await openBrowserProfile(system, { app: "chrome", profile: "Default", name: "Me" }),
    "missing",
  );
  assert.deepEqual(opened, []);
  const failing: BrowserSystem = {
    ...system,
    open: async () => {
      throw new Error("LSOpenURLsWithRole() failed");
    },
  };
  assert.equal(
    await openBrowserProfile(failing, { app: "brave", profile: "Default", name: "Work" }),
    "failed",
  );
});

test("open's arguments refuse a folder that is not a plain profile folder", () => {
  assert.throws(() => openArgs("chrome", "../x"));
  assert.throws(() => openArgs("chrome", "-flag"));
  assert.deepEqual(openArgs("chrome", "Profile 1"), [
    "-n",
    "-b",
    "com.google.Chrome",
    "--args",
    "--profile-directory=Profile 1",
  ]);
});
