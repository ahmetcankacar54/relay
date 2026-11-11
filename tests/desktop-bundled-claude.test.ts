import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { desktopBundledClaude, executableSource } from "../electron/core/environment";
import { diagnoseCli } from "../electron/core/cli-diagnostics";

async function bundle(home: string, version: string, hash: string, verified = true) {
  const dir = path.join(home, "Library", "Application Support", "Claude", "claude-code", version, hash);
  const macos = path.join(dir, "claude.app", "Contents", "MacOS");
  await fs.mkdir(macos, { recursive: true });
  const executable = path.join(macos, "claude");
  await fs.writeFile(executable, "#!/bin/sh\necho '9.9.9 (Claude Code)'\n", { mode: 0o755 });
  if (verified) await fs.writeFile(path.join(dir, ".verified"), hash);
  return executable;
}

test("the Claude app's own Claude Code: newest verified version, macOS only", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bundled-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.equal(desktopBundledClaude(home, "darwin"), undefined);
  await bundle(home, "2.1.9", "aaa");
  const newest = await bundle(home, "2.1.309", "bbb");
  // A newer download that has not checked out yet is not used.
  await bundle(home, "2.1.400", "ccc", false);
  await fs.mkdir(path.join(home, "Library", "Application Support", "Claude", "claude-code", "notes"));
  assert.equal(desktopBundledClaude(home, "darwin"), newest);
  assert.equal(desktopBundledClaude(home, "linux"), undefined);
  assert.equal(desktopBundledClaude(home, "darwin", () => false), undefined);
});

test("where a CLI came from: the user's choice, the Claude app, or the usual places", { skip: process.platform === "win32" && "needs a POSIX shell: the stand-in is a shell script" }, () => {
  const app = "/Users/me/Library/Application Support/Claude/claude-code/2.1.309/b/claude.app/Contents/MacOS/claude";
  assert.equal(executableSource(app, undefined), "claude-app");
  assert.equal(executableSource(app, app), "chosen");
  assert.equal(executableSource("/Users/me/.local/bin/claude", undefined), "path");
});

test("the diagnosis reports the source and still reads the version", { skip: process.platform === "win32" && "needs a POSIX shell: the stand-in is a shell script" }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bundled-diag-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const executable = await bundle(home, "2.1.309", "bbb");
  const diagnostics = await diagnoseCli(executable, home);
  assert.equal(diagnostics.source, "chosen");
  assert.equal(diagnostics.version, "9.9.9 (Claude Code)");
});
