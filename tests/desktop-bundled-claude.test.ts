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

test("the Claude app's own Claude Code: newest verified version, on macOS", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bundled-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.equal(desktopBundledClaude(home, "darwin"), undefined);
  await bundle(home, "2.1.9", "aaa");
  const newest = await bundle(home, "2.1.309", "bbb");
  // A newer download that has not checked out yet is not used.
  await bundle(home, "2.1.400", "ccc", false);
  await fs.mkdir(path.join(home, "Library", "Application Support", "Claude", "claude-code", "notes"));
  assert.equal(desktopBundledClaude(home, "darwin"), newest);
  // Linux keeps it elsewhere, Windows nowhere Relay knows.
  assert.equal(desktopBundledClaude(home, "linux", undefined, {}), undefined);
  assert.equal(desktopBundledClaude(home, "win32"), undefined);
  assert.equal(desktopBundledClaude(home, "darwin", () => false), undefined);
});

test("on Linux: <config>/Claude/claude-code/<version>/<hash>/claude, newest verified first", { skip: process.platform === "win32" && "POSIX paths" }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bundled-linux-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const linux = async (root: string, version: string, hash: string, verified = true) => {
    const dir = path.join(root, "Claude", "claude-code", version, hash);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    if (verified) await fs.writeFile(path.join(dir, ".verified"), hash);
    return path.join(dir, "claude");
  };
  const config = path.join(home, ".config");
  await linux(config, "2.1.308", "f8b3641a8d36");
  const newest = await linux(config, "2.1.321", "ded331c1fbf8");
  await linux(config, "2.1.400", "ccc", false);
  assert.equal(desktopBundledClaude(home, "linux", undefined, {}), newest);
  assert.equal(executableSource(newest, undefined), "claude-app");
  // $XDG_CONFIG_HOME moves Claude's data folder with it.
  const xdg = await linux(path.join(home, "xdg"), "2.1.1", "aaa");
  assert.equal(desktopBundledClaude(home, "linux", undefined, { XDG_CONFIG_HOME: path.join(home, "xdg") }), xdg);
});

test("where a CLI came from: the user's choice, the Claude app, or the usual places", { skip: process.platform === "win32" && "needs a POSIX shell: the stand-in is a shell script" }, () => {
  const app = "/Users/me/Library/Application Support/Claude/claude-code/2.1.309/b/claude.app/Contents/MacOS/claude";
  assert.equal(executableSource(app, undefined), "claude-app");
  assert.equal(executableSource(app, app), "chosen");
  // Claude Desktop chosen as the CLI was set aside: the CLI found instead is not the choice.
  assert.equal(executableSource(app, "/bin/claude-desktop"), "claude-app");
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
