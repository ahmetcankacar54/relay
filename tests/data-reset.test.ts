import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RESET_MARKER,
  ResetRefused,
  beginReset,
  finishPendingReset,
  safeResetRoot,
  type ResetPorts,
} from "../electron/core/data-reset";

/** A temp home with Relay's data folder, its log folder, and things beside them that are not Relay's. */
function layout() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reset-"));
  const root = path.join(home, "Library", "Application Support", "Relay");
  const logs = path.join(home, "Library", "Logs", "Relay");
  const claude = path.join(home, "Library", "Application Support", "Claude");
  const files = {
    "state.json": "{}",
    "language.json": "{}",
    "desktop-vault/accounts/11111111-2222-4333-8444-555555555555.bin": "sealed",
    "profiles/66666666-7777-4888-8999-000000000000/.claude.json": "{}",
    "profiles/66666666-7777-4888-8999-000000000000/antigravity-oauth/example.json": "{}",
    "tools/cli-proxy-api-8.0.61-darwin-arm64/cli-proxy-api": "binary",
    "relay-backups/before-import.relaybackup": "RLYB",
    "Local Storage/leveldb/000003.log": "chromium",
  };
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, "main-errors.log"), "log");
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, "config.json"), "claude's own");
  fs.writeFileSync(path.join(home, "keep.txt"), "outside");
  // A link inside the folder to Claude's data: removed as a link, never followed.
  fs.symlinkSync(claude, path.join(root, "claude-link"));
  return { home, root, logs, claude };
}

function ports(root: string, busy?: string) {
  const calls: string[] = [];
  const value: ResetPorts = {
    root,
    busy: () => busy,
    stopGateway: async () => void calls.push("gateway"),
    unbindClients: async () => void calls.push("unbind"),
    removeLoginItem: async () => void calls.push("login-item"),
    removeSecrets: async () => void calls.push("secrets"),
    relaunch: () => void calls.push("relaunch"),
  };
  return { calls, value };
}

test("a reset stops what lives outside the folder, then the next launch empties exactly Relay's folders", async () => {
  const { home, root, logs, claude } = layout();
  const entries = fs.readdirSync(root).map((name) => path.join(root, name));
  const { calls, value } = ports(root);
  await beginReset(value);
  assert.deepEqual(calls, ["gateway", "unbind", "login-item", "secrets", "relaunch"]);
  assert.ok(fs.existsSync(path.join(root, RESET_MARKER)));
  assert.ok(fs.existsSync(path.join(root, "state.json")), "nothing is deleted while Relay runs");

  const removed = finishPendingReset(root, [logs], undefined, home);
  assert.deepEqual(new Set(removed), new Set([...entries, logs, path.join(root, RESET_MARKER)]));
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(fs.existsSync(logs), false);
  assert.equal(fs.readFileSync(path.join(claude, "config.json"), "utf8"), "claude's own");
  assert.equal(fs.readFileSync(path.join(home, "keep.txt"), "utf8"), "outside");
  assert.equal(finishPendingReset(root, [logs], undefined, home), undefined, "done once");
});

test("without the marker the launch deletes nothing", () => {
  const { home, root, logs } = layout();
  const before = fs.readdirSync(root).sort();
  assert.equal(finishPendingReset(root, [logs], undefined, home), undefined);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.ok(fs.existsSync(logs));
});

test("a reset is refused during a Desktop operation, with nothing touched", async () => {
  const { root } = layout();
  const { calls, value } = ports(root, "Finish the Desktop handoff before starting another Desktop operation.");
  await assert.rejects(beginReset(value), (error: unknown) => error instanceof ResetRefused && /Desktop/.test(error.message));
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(root, RESET_MARKER)), false);
});

test("a step that fails stops the reset before the marker", async () => {
  const { root } = layout();
  const { value } = ports(root);
  value.unbindClients = async () => {
    throw new Error("Codex settings could not be written.");
  };
  await assert.rejects(beginReset(value), /Codex/);
  assert.equal(fs.existsSync(path.join(root, RESET_MARKER)), false);
});

test("a removal that fails leaves the marker for the next launch", () => {
  const { home, root } = layout();
  fs.writeFileSync(path.join(root, RESET_MARKER), "{}");
  const removed = finishPendingReset(
    root,
    [],
    {
      existsSync: fs.existsSync,
      readdirSync: (dir) => fs.readdirSync(dir),
      writeFileSync: fs.writeFileSync,
      rmSync: (target, options) => {
        if (target.endsWith("state.json")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        fs.rmSync(target, options);
      },
    },
    home,
  );
  assert.ok(removed && !removed.some((file) => file.endsWith("state.json")));
  assert.deepEqual(fs.readdirSync(root).sort(), [RESET_MARKER, "state.json"].sort());
});

test("only a folder below the home folder can be reset", () => {
  const home = path.join(path.sep, "Users", "example");
  assert.equal(safeResetRoot(path.join(home, "Library", "Application Support", "Relay"), home), true);
  assert.equal(safeResetRoot(home, home), false);
  assert.equal(safeResetRoot(path.dirname(home), home), false);
  assert.equal(safeResetRoot(path.parse(home).root, home), false);
  assert.equal(safeResetRoot("Relay", home), false);
});
