import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  autostartEntry,
  autostartFile,
  execArgument,
  launchAtLoginEnabled,
  launchedAtLogin,
  LOGIN_LAUNCH_FLAG,
  setLaunchAtLogin,
  type LoginItemHost,
} from "../electron/core/login-item";

test("the Linux autostart entry lives under XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(autostartFile({}, "/home/alto"), path.join("/home/alto", ".config", "autostart", "relay.desktop"));
  assert.equal(
    autostartFile({ XDG_CONFIG_HOME: "/data/config" }, "/home/alto"),
    path.join("/data/config", "autostart", "relay.desktop"),
  );
  // A relative value is invalid by the spec and ignored.
  assert.equal(
    autostartFile({ XDG_CONFIG_HOME: "config" }, "/home/alto"),
    path.join("/home/alto", ".config", "autostart", "relay.desktop"),
  );
});

test("the autostart entry starts Relay hidden, with its path quoted as the Desktop Entry spec says", () => {
  assert.equal(
    autostartEntry("/opt/Relay/relay"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.0",
      "Name=Relay",
      "Exec=/opt/Relay/relay --hidden",
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
  );
  assert.equal(execArgument("/home/alto/Apps/Relay 1.0.AppImage"), '"/home/alto/Apps/Relay 1.0.AppImage"');
  // `$` and `"` are escaped inside quotes, and every backslash is doubled again by the string escape.
  assert.equal(execArgument('/tmp/a$b"c'), '"/tmp/a\\\\$b\\\\"c"');
  // A percent sign would read as a field code.
  assert.equal(execArgument("/tmp/100%/relay"), "/tmp/100%%/relay");
});

test("a login launch is the flag on Windows and Linux and the system's word on macOS", () => {
  assert.equal(launchedAtLogin(["relay", LOGIN_LAUNCH_FLAG], "linux", false), true);
  assert.equal(launchedAtLogin(["relay.exe", LOGIN_LAUNCH_FLAG], "win32", false), true);
  assert.equal(launchedAtLogin(["relay"], "linux", true), false);
  assert.equal(launchedAtLogin(["Relay"], "darwin", true), true);
  assert.equal(launchedAtLogin(["Relay", LOGIN_LAUNCH_FLAG], "darwin", false), false);
});

test("on Linux, turning it on writes the AppImage's entry once and turning it off removes it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-login-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const host: LoginItemHost = {
    platform: "linux",
    env: { APPIMAGE: "/home/alto/Relay.AppImage" },
    home,
    execPath: "/tmp/.mount_Relay/relay",
    getLoginItemSettings: () => assert.fail("not on Linux"),
    setLoginItemSettings: () => assert.fail("not on Linux"),
  };
  const file = autostartFile(host.env, home);
  assert.equal(await launchAtLoginEnabled(host), false);
  await setLaunchAtLogin(true, host);
  assert.equal(await fs.readFile(file, "utf8"), autostartEntry("/home/alto/Relay.AppImage"));
  assert.equal(await launchAtLoginEnabled(host), true);
  // An entry for another path (Relay moved) is rewritten.
  await fs.writeFile(file, autostartEntry("/old/Relay.AppImage"));
  assert.equal(await launchAtLoginEnabled(host), false);
  await setLaunchAtLogin(true, host);
  assert.match(await fs.readFile(file, "utf8"), /^Exec=\/home\/alto\/Relay\.AppImage --hidden$/m);
  await setLaunchAtLogin(false, host);
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
  // Off when already off does nothing.
  await setLaunchAtLogin(false, host);
});

test("on macOS and Windows the login item is set only when it differs, with the flag on Windows", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const calls: unknown[] = [];
    let open = false;
    const host: LoginItemHost = {
      platform,
      env: {},
      home: "/home/alto",
      execPath: "/Applications/Relay.app/Contents/MacOS/Relay",
      getLoginItemSettings: (options) => {
        calls.push(["get", options]);
        return { openAtLogin: open };
      },
      setLoginItemSettings: (settings) => {
        calls.push(["set", settings]);
        open = settings.openAtLogin;
      },
    };
    await setLaunchAtLogin(true, host);
    await setLaunchAtLogin(true, host);
    await setLaunchAtLogin(false, host);
    const args = platform === "win32" ? { args: [LOGIN_LAUNCH_FLAG] } : undefined;
    assert.deepEqual(
      calls,
      [
        ["get", args],
        ["set", { openAtLogin: true, ...args }],
        ["get", args],
        ["get", args],
        ["set", { openAtLogin: false, ...args }],
      ],
      platform,
    );
  }
});
