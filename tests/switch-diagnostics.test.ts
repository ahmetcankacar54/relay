import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SwitchDiagnostics } from "../electron/core/switch-diagnostics";
import { launchArgs } from "../electron/core/desktop-host-node";

function folder(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-switch-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "switch-diagnostics");
}

test("the launch choice starts off, keeps what a change names, and outlives Relay", (t) => {
  const dir = folder(t);
  const first = new SwitchDiagnostics(dir);
  assert.deepEqual(first.current, { quicOff: false });
  assert.deepEqual(first.set({ quicOff: true }), { quicOff: true });
  // Read again as Relay reads it at its next start; only the owner may read it.
  assert.deepEqual(new SwitchDiagnostics(dir).current, { quicOff: true });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);
  // An unreadable file is the default, never a failure.
  fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
  assert.deepEqual(new SwitchDiagnostics(dir).current, { quicOff: false });
});

test("a net log an older Relay turned on is ignored", (t) => {
  const dir = folder(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ netLog: true, quicOff: true }));
  assert.deepEqual(new SwitchDiagnostics(dir).current, { quicOff: true });
});

test("Claude's switches: no HTTP/3, and never a debugging or network-override switch", () => {
  assert.deepEqual(launchArgs(), []);
  assert.deepEqual(launchArgs({ quicOff: true }), ["--disable-quic"]);
  // Claude refuses to start with --log-net-log and the like on its command line.
  for (const arg of launchArgs({ quicOff: true }))
    assert.doesNotMatch(arg, /log-net-log|net-log-capture-mode|remote-debugging|host-rules/);
});
