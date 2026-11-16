import test from "node:test";
import assert from "node:assert/strict";
import { appDataRoot, relayPaths } from "../electron/core/relay-paths";

test("paths default under Application Support and honour overrides", { skip: process.platform === "win32" && "macOS only: the folders the relay CLI uses" }, () => {
  const p = relayPaths({}, "/Users/x", "darwin");
  assert.equal(p.data, "/Users/x/Library/Application Support/Relay");
  assert.equal(p.claude, "/Users/x/Library/Application Support/Claude");
  assert.deepEqual(p.claudeApps, [
    "/Applications/Claude.app",
    "/Users/x/Applications/Claude.app",
  ]);
  assert.equal(p.vault, "/Users/x/Library/Application Support/Relay/desktop-vault");
  assert.equal(p.profiles, "/Users/x/Library/Application Support/Relay/profiles");
  assert.equal(
    p.cliOperations,
    "/Users/x/Library/Application Support/Relay/cli-operations",
  );
  const o = relayPaths(
    {
      RELAY_HOME: "/t/r",
      RELAY_CLAUDE_DIR: "/t/c",
      RELAY_CLAUDE_APP: "/t/Claude.app",
    },
    "/Users/x",
    "darwin",
  );
  assert.deepEqual(
    [o.data, o.claude, o.claudeApps, o.locks],
    ["/t/r", "/t/c", ["/t/Claude.app"], "/t/r/profiles/.locks"],
  );
});

test("relative overrides are ignored", { skip: process.platform === "win32" && "macOS only: the folders the relay CLI uses" }, () => {
  const p = relayPaths({ RELAY_HOME: "relative/dir" }, "/Users/x", "darwin");
  assert.equal(p.data, "/Users/x/Library/Application Support/Relay");
});

test("Linux keeps Relay and Claude in the XDG config folder, as Electron does", { skip: process.platform === "win32" && "POSIX paths" }, () => {
  const p = relayPaths({}, "/home/x", "linux");
  assert.deepEqual(
    [p.data, p.claude, p.claudeApps, p.vault],
    ["/home/x/.config/Relay", "/home/x/.config/Claude", [], "/home/x/.config/Relay/desktop-vault"],
  );
  const xdg = relayPaths({ XDG_CONFIG_HOME: "/cfg/" }, "/home/x", "linux");
  assert.deepEqual([xdg.data, xdg.claude], ["/cfg/Relay", "/cfg/Claude"]);
  // A relative XDG_CONFIG_HOME is invalid by the spec and ignored; overrides still win.
  assert.equal(relayPaths({ XDG_CONFIG_HOME: "cfg" }, "/home/x", "linux").data, "/home/x/.config/Relay");
  assert.equal(relayPaths({ XDG_CONFIG_HOME: "/cfg", RELAY_HOME: "/t/r" }, "/home/x", "linux").data, "/t/r");
});

test("Windows keeps them in %APPDATA%", () => {
  assert.equal(appDataRoot("win32", "C:\\Users\\x", { APPDATA: "D:\\Roaming" }), "D:\\Roaming");
  assert.equal(appDataRoot("win32", "C:\\Users\\x", {}), "C:\\Users\\x\\AppData\\Roaming");
});
