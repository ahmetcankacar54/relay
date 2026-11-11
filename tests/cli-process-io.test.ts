import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { execFileSync } from "node:child_process";
import { processIO } from "../cli/src/process-io";
import { runDetached } from "../electron/core/detached-exec";

test("a terminal that hangs up mid-operation cannot crash the CLI through a failed write", async () => {
  const broken = () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("write EIO"), { code: "EIO" }));
      },
    });
  const io = processIO({ stdout: broken(), stderr: broken(), stdin: Readable.from([]) as any, env: {}, cwd: "/", isTTY: false });
  io.stderr("A Claude Desktop operation is running; wait…");
  io.stdout("done");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(true);
});

test("Desktop commands run in their own process group, out of reach of the terminal's Ctrl+C and hang-up", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async () => {
  const own = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
  const { stdout } = await runDetached("/bin/sh", ["-c", "ps -o pgid= -p $$"], { timeout: 5000 });
  assert.notEqual(stdout.trim(), own);
  await assert.rejects(runDetached("/bin/sh", ["-c", "echo nope >&2; exit 3"], { timeout: 5000 }), (e: any) => e.code === 3 && /Command failed: \/bin\/sh/.test(e.message) && /nope/.test(e.message));
  await assert.rejects(runDetached("/bin/sh", ["-c", "sleep 5"], { timeout: 100 }), (e: any) => e.killed === true);
});

test("a character split across two output chunks comes back whole", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async () => {
  const { stdout } = await runDetached("/bin/sh", ["-c", "printf '\\305'; sleep 0.1; printf '\\237'"], { timeout: 5000 });
  assert.equal(stdout, "ş");
});

test("a command given an environment gets only that one, and Relay's own otherwise", { skip: process.platform === "win32" && "macOS only: the relay CLI refuses other systems" }, async () => {
  process.env.RELAY_LEAK_PROBE = "from-relay";
  try {
    const inherited = await runDetached("/usr/bin/env", [], { timeout: 5000 });
    assert.match(inherited.stdout, /^RELAY_LEAK_PROBE=from-relay$/m);
    const clean = await runDetached("/usr/bin/env", [], { timeout: 5000, env: {} });
    assert.doesNotMatch(clean.stdout, /RELAY_LEAK_PROBE/);
    const given = await runDetached("/usr/bin/env", [], { timeout: 5000, env: { ONLY: "this" } });
    assert.match(given.stdout, /^ONLY=this$/m);
    assert.doesNotMatch(given.stdout, /RELAY_LEAK_PROBE/);
  } finally {
    delete process.env.RELAY_LEAK_PROBE;
  }
});
