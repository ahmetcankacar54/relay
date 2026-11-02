import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const laboratory = fileURLToPath(
  new URL("../scripts/continuation-lab.ts", import.meta.url),
);
const receiver = fileURLToPath(
  new URL("../scripts/fixtures/continuation-host.mjs", import.meta.url),
);
const repository = fileURLToPath(new URL("..", import.meta.url));

async function command(
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; tsx?: boolean } = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [...(options.tsx === false ? [] : ["--import", "tsx"]), file, ...args],
        {
          cwd: repository,
          env: options.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Isolated lab command timed out."));
      }, 30_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 128 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > 8 * 1024) child.kill();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.stdin.end(options.input ?? "");
    },
  );
}

test(
  "executable isolated lab switches real Relay adapters A→B→A and verifies persistent exact-conversation new turns",
  { timeout: 35_000 },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "relay-lab-sentinel-test-"),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const sentinelFile = path.join(root, "unexpected-claude-call");
    const bin = path.join(root, "bin");
    await fs.mkdir(bin);
    await fs.writeFile(
      path.join(bin, "claude"),
      '#!/bin/sh\nprintf "unexpected" >> "$RELAY_SENTINEL_FILE"\nexit 88\n',
      { mode: 0o700 },
    );
    await fs.writeFile(
      path.join(bin, "claude.cmd"),
      '@echo unexpected>> "%RELAY_SENTINEL_FILE%"\r\n@exit /b 88\r\n',
    );
    const result = await command(laboratory, ["--json"], {
      env: {
        ...process.env,
        PATH: bin,
        HOME: root,
        RELAY_SENTINEL_FILE: sentinelFile,
        ANTHROPIC_API_KEY: "DO_NOT_USE_LAB_SENTINEL_SECRET",
        CLAUDE_CODE_OAUTH_TOKEN: "DO_NOT_USE_OAUTH_SENTINEL_SECRET",
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "simulated-isolated-executable-lab");
    assert.equal(report.operation, "checkpointed-handoff-and-new-turn");
    assert.equal(report.actualAccountsUsed, false);
    assert.equal(report.actualClaudeControlled, false);
    assert.equal(report.actualClaudeInvocations, 0);
    assert.equal(report.anthropicRequests, 0);
    assert.equal(report.routinesEnabled, false);
    assert.equal(report.uninterruptedWorkerTransferProven, false);
    assert(report.realProductionComponents.includes("DesktopManager"));
    assert(report.realProductionComponents.includes("ContinuationEngine"));
    assert.deepEqual(report.roundTrip.accounts, ["A", "B", "A"]);
    assert.deepEqual(report.roundTrip.continuationSteps, [1, 2]);
    assert.equal(report.roundTrip.messagesBefore, 2);
    assert.equal(report.roundTrip.messagesAfter, 6);
    assert.equal(report.roundTrip.sends, 2);
    assert.equal(report.roundTrip.switches, 2);
    assert.equal(report.roundTrip.opens, 2);
    assert.equal(report.roundTrip.checkpointBytesVerified, true);
    assert.equal(report.roundTrip.receiverLoadedExactConversation, true);
    assert.equal(report.roundTrip.preservedPrefix, true);
    assert.equal(report.roundTrip.permissionMode, "default");
    assert.equal(report.roundTrip.serverBindingsTransferred, false);
    assert.equal(report.roundTrip.replayCreatedNewTurn, false);
    const [first, second] = report.roundTrip.receipts;
    assert.equal(first.sessionId, report.roundTrip.exactSessionId);
    assert.equal(second.sessionId, first.sessionId);
    assert.notEqual(first.identity.profileId, second.identity.profileId);
    assert.notEqual(first.identity.accountUuid, second.identity.accountUuid);
    assert.equal(first.afterRevision, second.beforeRevision);
    assert.equal(first.beforeRevision, report.roundTrip.beforeRevision);
    assert.equal(second.afterRevision, report.roundTrip.afterRevision);
    assert.equal(first.permissionMode, second.permissionMode);
    assert.equal(report.blocked.length, 5);
    assert(
      report.blocked.every(
        (item: any) =>
          item.stage === "blocked" &&
          !item.accountChanged &&
          !item.transcriptChanged &&
          item.sends === 0,
      ),
    );
    assert.equal(report.crashRecovery.afterRecovery, "continued");
    assert.equal(report.crashRecovery.sendCount, 1);
    assert.equal(report.crashRecovery.duplicateTurns, 0);
    assert.equal(report.preSendRecovery.afterRecovery, "continued");
    assert.equal(report.preSendRecovery.accountSwitches, 1);
    assert.equal(report.preSendRecovery.sendCount, 1);
    assert(
      report.uncertain.every(
        (item: any) =>
          item.afterRecovery === "reconciliation-required" &&
          !item.automaticResend &&
          !item.transcriptChanged &&
          item.replacementRequestBlocked &&
          item.retries === 3,
      ),
    );
    assert(
      report.uncertain.some((item: any) => item.scenario === "context-race"),
    );
    assert.equal(report.partialCommit.receiverExitCode, 86);
    assert.equal(report.partialCommit.transcriptAdvanced, true);
    assert.equal(report.partialCommit.receiptAvailable, false);
    assert.equal(report.partialCommit.afterRecovery, "reconciliation-required");
    assert.equal(report.partialCommit.automaticResend, false);
    assert.equal(report.partialCommit.replacementRequestBlocked, true);
    assert.equal(report.partialCommit.sendCount, 1);
    assert.equal(report.partialCommit.duplicateTurns, 0);
    assert.equal(report.assertionsPassed, true);
    assert(!result.stdout.includes(root));
    assert(
      !/DO_NOT_USE|oauth:tokenCache|fixture-cookie|LAB_CHECKPOINT|\/Users\/|\/private\//.test(
        result.stdout,
      ),
    );
    await assert.rejects(fs.stat(sentinelFile), { code: "ENOENT" });
  },
);

test("lab help and invalid arguments never execute the receiver or echo supplied paths", async () => {
  const help = await command(laboratory, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /synthetic accounts/);
  assert.equal(help.stderr, "");
  const bad = await command(laboratory, [
    "/private/SHOULD_NOT_BE_READ",
    "--json",
  ]);
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr, "Invalid lab arguments. Use --help.\n");
});

test("executable receiver fails closed outside its explicitly marked isolated environment", async () => {
  const result = await command(receiver, [], {
    tsx: false,
    env: { PATH: "", RELAY_CONTINUATION_LAB: "0" },
    input: '{"op":"send","text":"SECRET_MUST_NOT_BE_ECHOED"}',
  });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Isolated receiver rejected the operation.\n");
});
