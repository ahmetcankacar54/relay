import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/live-preflight.ts");
const suppliedBusyFixture = path.resolve(
  "tests/fixtures/live-preflight/busy.json",
);
const now = "2026-10-13T12:00:00.000Z";
const epoch = Date.parse(now);
const sessionId = "00000000-0000-0000-0000-000000000001";
type Fixture = ReturnType<typeof fixture>;
function fixture(status: "busy" | "idle" = "busy") {
  return {
    expectedScopeIds: ["desktop-fixture"],
    expectedSessions: [{ scopeId: "desktop-fixture", sessionId }],
    rosters: [
      {
        scopeId: "desktop-fixture",
        collectedAt: epoch,
        includeCompleted: true,
        rows: [
          {
            cwd: "/fixture/project",
            kind: "interactive",
            startedAt: epoch - 10_000,
            pid: 42,
            status,
            sessionId,
          },
        ],
      },
    ],
    children: [
      {
        scopeId: "desktop-fixture",
        sessionId,
        collectedAt: epoch,
        complete: true,
        tasks: [] as { id: string; kind: string; state: string }[],
      },
    ],
  };
}
function temporary(t: any) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relay-live-preflight-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function save(directory: string, input: unknown, name = "snapshot.json") {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
  return file;
}
function execute(args: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", script, ...args],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 128 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function jsonReport(file: string, clock = now) {
  const result = execute([file, "--now", clock, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("the executable consumes the supplied busy fixture and never grants live-switch or continuation capability", () => {
  const report = jsonReport(suppliedBusyFixture);
  assert.equal(report.mode, "offline-diagnostics");
  assert.equal(report.observedAt, now);
  assert.equal(report.rosterActivity, "working");
  assert.equal(report.sessionCounts.working, 1);
  assert.equal(report.taskCounts.working, 1);
  assert.equal(report.coverage.declaredScopes, "complete");
  assert.equal(report.coverage.expectedSessions, "present");
  assert.equal(report.coverage.parentTaskDetails, "complete");
  assert.equal(report.coverage.desktop, "unverified");
  assert.equal(report.canSwitchLive, false);
  assert.equal(report.canContinueAutomatically, false);
  assert.equal(report.actionsExecuted, 0);
  assert.equal(report.capabilities.liveAccountSwitch, "unsupported");
  assert.equal(report.capabilities.crossAccountContinuation, "unsupported");
});

test("a complete quiet snapshot and the readable text report still deny automation", (t) => {
  const file = save(temporary(t), fixture("idle"));
  const report = jsonReport(file);
  assert.equal(report.rosterActivity, "quiet");
  assert.equal(report.sessionCounts.quiet, 1);
  assert.equal(report.coverage.parentTaskDetails, "complete");
  assert.equal(report.canSwitchLive, false);
  assert.equal(report.canContinueAutomatically, false);
  const text = execute([file, "--now", now]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Roster activity: quiet/);
  assert.match(text.stdout, /Sessions: 1 \(quiet=1\)/);
  assert.match(text.stdout, /Desktop coverage: unverified/);
  assert.match(text.stdout, /Live account switch: unsupported/);
  assert.match(
    text.stdout,
    /No Claude command, Desktop change or continuation message was executed/,
  );
});

test("the fixture clock reports stale and missing evidence without turning it into malformed input", (t) => {
  const directory = temporary(t);
  const stale = jsonReport(
    save(directory, fixture("idle")),
    "2026-10-13T12:00:16Z",
  );
  assert.equal(stale.rosterActivity, "unknown");
  assert.ok(stale.issues.some((issue: any) => issue.code === "stale-snapshot"));
  const missing = fixture("idle");
  missing.expectedScopeIds.push("another-config");
  missing.children = [];
  const report = jsonReport(save(directory, missing, "missing.json"));
  assert.equal(report.coverage.declaredScopes, "incomplete");
  assert.equal(report.coverage.parentTaskDetails, "not-provided");
  assert.ok(report.issues.some((issue: any) => issue.code === "scope-missing"));
  assert.equal(report.canSwitchLive, false);
});

test("diagnostic output never echoes supplied private row metadata or identifiers", (t) => {
  const input = fixture("idle");
  Object.assign(input.rosters[0].rows[0], {
    cwd: "/private/corporate-secret-directory",
    name: "private-conversation-title",
    prompt: "PRIVATE_PROMPT_CONTENT",
    instructions: "PRIVATE_INSTRUCTIONS",
    extra: { token: "PRIVATE_TOKEN" },
  });
  input.children[0].tasks.push({
    id: "sensitive-child-id",
    kind: "shell",
    state: "done",
  });
  const file = save(temporary(t), input);
  for (const format of [[], ["--json"]]) {
    const result = execute([file, "--now", now, ...format]);
    assert.equal(result.status, 0, result.stderr);
    for (const privateText of [
      "corporate-secret",
      "private-conversation-title",
      "PRIVATE_PROMPT_CONTENT",
      "PRIVATE_INSTRUCTIONS",
      "PRIVATE_TOKEN",
      "sensitive-child-id",
      sessionId,
      "desktop-fixture",
    ])
      assert.ok(!result.stdout.includes(privateText), privateText);
  }
});

test("malformed JSON, unexpected envelope keys and invalid execution states fail with sanitized errors", (t) => {
  const directory = temporary(t);
  const invalid = save(directory, fixture());
  fs.writeFileSync(invalid, '{"PRIVATE_PARSER_SECRET":');
  let result = execute([invalid, "--now", now, "--json"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /valid UTF-8 JSON/);
  assert.ok(!result.stderr.includes("PRIVATE_PARSER_SECRET"));
  const bytes = path.join(directory, "invalid-utf8.json");
  fs.writeFileSync(bytes, Buffer.from([0xff, 0xfe]));
  assert.equal(execute([bytes]).status, 2);
  const envelope = { ...fixture(), command: "PRIVATE_SHELL_COMMAND" };
  result = execute([save(directory, envelope), "--now", now]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /input schema/);
  assert.ok(!result.stderr.includes("PRIVATE_SHELL_COMMAND"));
  const badRow = fixture();
  (badRow.rosters[0].rows[0] as any).status = "unknown-new-status";
  result = execute([save(directory, badRow), "--now", now]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid or conflicting execution records/);
  const duplicate: Fixture = fixture();
  duplicate.rosters[0].rows.push({ ...duplicate.rosters[0].rows[0] });
  assert.equal(execute([save(directory, duplicate), "--now", now]).status, 2);
});

test("the executable rejects oversized inputs, directories, links and missing files without exposing paths", (t) => {
  const directory = temporary(t);
  const oversized = path.join(directory, "PRIVATE_PATH_OVERSIZED.json");
  fs.writeFileSync(oversized, " ".repeat(1_048_577));
  let result = execute([oversized]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /1 MiB input limit/);
  assert.ok(!result.stderr.includes("PRIVATE_PATH"));
  assert.equal(execute([directory]).status, 2);
  const target = save(directory, fixture());
  const link = path.join(directory, "snapshot-link.json");
  fs.symlinkSync(target, link);
  result = execute([link, "--now", now]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /regular file/);
  result = execute([path.join(directory, "PRIVATE_MISSING.json")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /could not be read/);
  assert.ok(!result.stderr.includes("PRIVATE_MISSING"));
});

test("strict command arguments reject unknown flags and invalid clocks before any snapshot read", () => {
  for (const args of [
    [],
    ["--execute"],
    ["one.json", "two.json"],
    ["one.json", "--json", "--json"],
    ["one.json", "--now"],
    ["one.json", "--now", "2026-02-30T12:00:00Z"],
    ["one.json", "--now", "2026-10-13T12:00:00"],
    ["one.json", "--now", "2026-10-13T12:00:00Z", "--now", now],
  ]) {
    const result = execute(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /could not be read/);
  }
  const help = execute(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /explicitly supplied JSON snapshot only/);
});

test("executable diagnostics leave the snapshot and supplied HOME untouched and never invoke a Claude binary", (t) => {
  const directory = temporary(t);
  const home = path.join(directory, "home");
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  const sentinel = path.join(directory, "CLAUDE_WAS_INVOKED");
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh\nprintf invoked > '${sentinel}'\nexit 99\n`,
    { mode: 0o700 },
  );
  const settings = path.join(home, ".claude", "settings.json");
  const desktopConfig = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "config.json",
  );
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
  fs.writeFileSync(settings, '{"private":"UNREAD_CLAUDE_SETTINGS"}');
  fs.writeFileSync(desktopConfig, '{"private":"UNREAD_DESKTOP_AUTH"}');
  const snapshot = save(directory, fixture("idle"));
  const originals = [snapshot, settings, desktopConfig].map((file) => ({
    file,
    bytes: fs.readFileSync(file),
    mtime: fs.statSync(file).mtimeMs,
  }));
  const result = execute([snapshot, "--now", now, "--json"], {
    HOME: home,
    CLAUDE_CONFIG_DIR: path.dirname(settings),
    PATH: bin,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).actionsExecuted, 0);
  assert.equal(fs.existsSync(sentinel), false);
  assert.deepEqual(fs.readdirSync(path.dirname(settings)), ["settings.json"]);
  for (const original of originals) {
    assert.deepEqual(fs.readFileSync(original.file), original.bytes);
    assert.equal(fs.statSync(original.file).mtimeMs, original.mtime);
  }
  assert.doesNotMatch(
    result.stdout,
    /UNREAD_CLAUDE_SETTINGS|UNREAD_DESKTOP_AUTH/,
  );
});
