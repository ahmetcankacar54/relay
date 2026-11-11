import test from "node:test";
import assert from "node:assert/strict";
import { relayPaths } from "../electron/core/relay-paths";

test("paths default under Application Support and honour overrides", { skip: process.platform === "win32" && "macOS only: the folders the relay CLI uses" }, () => {
  const p = relayPaths({}, "/Users/x");
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
  );
  assert.deepEqual(
    [o.data, o.claude, o.claudeApps, o.locks],
    ["/t/r", "/t/c", ["/t/Claude.app"], "/t/r/profiles/.locks"],
  );
});

test("relative overrides are ignored", { skip: process.platform === "win32" && "macOS only: the folders the relay CLI uses" }, () => {
  const p = relayPaths({ RELAY_HOME: "relative/dir" }, "/Users/x");
  assert.equal(p.data, "/Users/x/Library/Application Support/Relay");
});
