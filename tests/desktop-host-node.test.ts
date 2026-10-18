import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeExecutable } from "../electron/core/desktop-host-node";

test("claudeExecutable finds the first Claude.app whose executable exists", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = (name: string) => {
    const bundle = path.join(dir, name, "Claude.app");
    fs.mkdirSync(path.join(bundle, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(bundle, "Contents", "MacOS", "Claude"), "");
    return bundle;
  };
  const first = app("one"),
    second = app("two");
  const missing = path.join(dir, "none", "Claude.app");
  assert.equal(
    claudeExecutable([missing, first, second]),
    path.join(first, "Contents", "MacOS", "Claude"),
  );
  assert.equal(claudeExecutable([missing]), undefined);
  assert.equal(claudeExecutable(["relative/Claude.app"]), undefined);
});
