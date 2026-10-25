import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEEP_LOGS, SwitchDiagnostics, logStamp } from "../electron/core/switch-diagnostics";
import { launchArgs } from "../electron/core/desktop-host-node";

function folder(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-switch-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "switch-diagnostics");
}

test("the launch choice starts off, keeps what a change names, and outlives Relay", (t) => {
  const dir = folder(t);
  const first = new SwitchDiagnostics(dir);
  assert.deepEqual(first.current, { netLog: false, quicOff: false });
  assert.deepEqual(first.set({ quicOff: true }), { netLog: false, quicOff: true });
  assert.deepEqual(first.set({ netLog: true }), { netLog: true, quicOff: true });
  // Read again as Relay reads it at its next start; only the owner may read it.
  assert.deepEqual(new SwitchDiagnostics(dir).current, { netLog: true, quicOff: true });
  assert.equal(fs.statSync(path.join(dir, "settings.json")).mode & 0o777, 0o600);
  // An unreadable file is the default, never a failure.
  fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
  assert.deepEqual(new SwitchDiagnostics(dir).current, { netLog: false, quicOff: false });
});

test("a net log is named per launch only while the diagnosis is on, and old ones go", (t) => {
  const dir = folder(t);
  let clock = new Date(2026, 9, 25, 23, 48, 22, 16);
  const diagnostics = new SwitchDiagnostics(dir, () => clock);
  assert.equal(diagnostics.nextNetLog(), undefined);
  diagnostics.set({ netLog: true });
  const names: string[] = [];
  for (let i = 0; i < 5; i++) {
    const file = diagnostics.nextNetLog()!;
    names.push(path.basename(file));
    // Claude writes it; the next launch comes a second later.
    fs.writeFileSync(file, "{}");
    clock = new Date(clock.getTime() + 1000);
  }
  assert.equal(names[0], "claude-net-20261025-234822-016.json");
  assert.deepEqual(
    diagnostics.logs().map((f) => path.basename(f)),
    names.slice(-KEEP_LOGS),
  );
  // Two launches in the same millisecond never share a file.
  clock = new Date(clock.getTime() - 1000);
  assert.notEqual(path.basename(diagnostics.nextNetLog()!), names.at(-1));
  // Files that are not net logs are left alone.
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
  diagnostics.nextNetLog();
  assert.equal(fs.existsSync(path.join(dir, "notes.txt")), true);
});

test("a log stamp sorts as the time does", () => {
  const early = logStamp(new Date(2026, 0, 2, 3, 4, 5, 6));
  const late = logStamp(new Date(2026, 9, 25, 23, 48, 22, 16));
  assert.equal(early, "20260102-030405-006");
  assert.ok(early < late);
});

test("Claude's switches: the net log in Chromium's default mode, and no HTTP/3", () => {
  assert.deepEqual(launchArgs(), []);
  assert.deepEqual(launchArgs({ quicOff: true }), ["--disable-quic"]);
  assert.deepEqual(launchArgs({ netLog: "/logs/claude-net.json", quicOff: true }), [
    "--log-net-log=/logs/claude-net.json",
    "--net-log-capture-mode=Default",
    "--disable-quic",
  ]);
  // A relative path never reaches Claude, whose working folder is not Relay's.
  assert.deepEqual(launchArgs({ netLog: "claude-net.json" }), []);
});
