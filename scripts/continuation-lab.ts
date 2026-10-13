import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "../electron/core/store";
import { DesktopManager, type DesktopHost } from "../electron/core/desktop";
import {
  jsonBytes,
  readObject,
  writeBytes,
} from "../electron/core/desktop-files";
import {
  ContinuationEngine,
  isTerminalContinuationRecord,
  type ContinuationHost,
  type ContinuationJournal,
  type ContinuationJournalRecord,
  type ContinuationRequest,
  type ContinuationState,
  type ContinuationDelivery,
} from "../electron/core/continuation";
import type { Account, AccountUsage } from "../shared/types";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const receiverFile = fileURLToPath(
  new URL("./fixtures/continuation-host.mjs", import.meta.url),
);
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

interface ReceiverInspection {
  identity: ContinuationState["identity"];
  sessionId: string;
  projectKey: string;
  cwdVerified: boolean;
  loaded: boolean;
  transcriptRevision: string;
  messages: number;
  lastRequestId?: string;
  lastTurnId?: string;
}
type LabFault =
  | "none"
  | "after-switch"
  | "after-commit"
  | "before-send"
  | "unknown-ack"
  | "context-race"
  | "receiver-crash-before-receipt";

async function atomic(file: string, bytes: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  if (process.platform !== "win32") {
    const directory = await fs.open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function withReceiverLock<T>(root: string, action: () => Promise<T>) {
  const lockFile = path.join(root, "receiver-transaction.lock");
  const handle = await fs.open(lockFile, "wx", 0o600);
  try {
    return await action();
  } finally {
    await handle.close();
    await fs.rm(lockFile, { force: true });
  }
}

class LabJournal implements ContinuationJournal {
  private lock = Promise.resolve();
  constructor(private root: string) {}
  async withLock<T>(_id: string, action: () => Promise<T>): Promise<T> {
    // Serialize the entire host, including different request IDs. The executable
    // lab has one owner; receiver receipts and journal files survive engine loss.
    let unlock!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      unlock();
    }
  }
  async read(id: string): Promise<ContinuationJournalRecord | undefined> {
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.root, `${id}.json`), "utf8"),
      );
    } catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async write(record: ContinuationJournalRecord) {
    await atomic(
      path.join(this.root, `${record.id}.json`),
      JSON.stringify(record),
    );
  }
  async listPending(): Promise<ContinuationJournalRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error: any) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(
          async (name) =>
            JSON.parse(
              await fs.readFile(path.join(this.root, name), "utf8"),
            ) as ContinuationJournalRecord,
        ),
    );
    return records.filter(
      (record) => !isTerminalContinuationRecord(record, NOW),
    );
  }
}

async function fixture() {
  const temporary = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "relay-continuation-lab-")),
  );
  const desktopRoot = path.join(temporary, "Claude-fixture");
  const project = path.join(temporary, "project-fixture");
  const transcriptRoot = path.join(temporary, "transcripts-fixture");
  const sessionId = randomUUID();
  const transcript = path.join(
    transcriptRoot,
    "projects",
    project.replace(/[/_.]/g, "-"),
    `${sessionId}.jsonl`,
  );
  const journal = new LabJournal(path.join(temporary, "continuation-journal"));
  const store = new Store(path.join(temporary, "Relay-fixture"));
  let applicationRunning = false;
  const operations = {
    quits: 0,
    launches: 0,
    switches: 0,
    opens: 0,
    sends: 0,
    receiverProcesses: 0,
  };
  const desktopHost: DesktopHost = {
    available: async () => true,
    running: async () => applicationRunning,
    quit: async () => {
      operations.quits++;
      applicationRunning = false;
    },
    launch: async () => {
      operations.launches++;
      applicationRunning = true;
    },
    seal: (value) =>
      Buffer.from(
        `LAB-NOT-REAL-ENCRYPTION:${Buffer.from(value).toString("base64")}`,
      ),
    unseal: (bytes) =>
      Buffer.from(bytes.toString().slice(24), "base64").toString(),
  };
  const manager = new DesktopManager(
    desktopRoot,
    store,
    desktopHost,
    transcriptRoot,
  );
  const syntheticAccounts: {
    label: string;
    profileId: string;
    accountUuid: string;
    orgId: string;
  }[] = [];
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  await manager.initialize();
  async function createAccount(label: string) {
    const account = store.create({
      name: `Isolated ${label}`,
      kind: "personal",
    });
    const accountUuid = randomUUID(),
      orgId = randomUUID();
    syntheticAccounts.push({
      label,
      profileId: account.id,
      accountUuid,
      orgId,
    });
    await writeBytes(
      desktopRoot,
      "config.json",
      jsonBytes({
        lastKnownAccountUuid: accountUuid,
        "oauth:tokenCacheV2": `fixture:${label}`,
        preference: "kept",
      }),
    );
    await writeBytes(
      desktopRoot,
      "Cookies",
      Buffer.from(`fixture-cookie:${label}`),
    );
    await fs.mkdir(
      path.join(desktopRoot, "claude-code-sessions", accountUuid, orgId),
      { recursive: true, mode: 0o700 },
    );
    await manager.capture(account.id, orgId);
    store.update((state) => {
      state.accounts.find((value) => value.id === account.id)!.auth = {
        loggedIn: true,
        accountUuid,
        orgId,
        checkedAt: new Date(NOW).toISOString(),
      };
    });
    return store.account(account.id);
  }
  const a = await createAccount("A");
  const localRecord = (account: Account) =>
    `claude-code-sessions/${account.desktop!.accountUuid}/${account.desktop!.orgId}/local_${sessionId}.json`;
  await writeBytes(
    desktopRoot,
    localRecord(a),
    jsonBytes({
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      cwd: project,
      title: "Isolated checkpoint continuation",
      lastActivityAt: NOW,
      permissionMode: "default",
      remoteMcpServersConfig: [],
      enabledMcpTools: {},
    }),
  );
  await writeBytes(
    desktopRoot,
    `local-agent-mode-sessions/${a.desktop!.accountUuid}/${a.desktop!.orgId}/spaces.json`,
    jsonBytes({
      spaces: [
        {
          id: project,
          name: "Isolated project",
          updatedAt: NOW,
          projects: { fixtureSourceBinding: true },
        },
      ],
    }),
  );
  const firstId = randomUUID(),
    secondId = randomUUID();
  const seed = [
    {
      type: "user",
      uuid: firstId,
      parentUuid: null,
      sessionId,
      cwd: project,
      message: {
        role: "user",
        content:
          "Complete the next deterministic lab checkpoint step, then stop.",
      },
    },
    {
      type: "assistant",
      uuid: secondId,
      parentUuid: firstId,
      sessionId,
      cwd: project,
      message: { role: "assistant", content: "LAB_CHECKPOINT_0" },
      labStep: 0,
    },
  ];
  await atomic(
    transcript,
    seed.map((message) => JSON.stringify(message)).join("\n") + "\n",
  );
  const b = await createAccount("B");
  await manager.switchTo(a.id);
  store.update((state) => {
    state.settings.desktopHistoryTransfer = "selected";
    state.settings.desktopHistoryAccounts = [a.id, b.id];
    state.settings.autoSwitchMode = "off";
    state.settings.workday.routineEnabled = false;
  });
  await atomic(
    path.join(temporary, "lab.json"),
    JSON.stringify({
      mode: "simulated",
      actualClaudeControlled: false,
      accounts: syntheticAccounts,
      sessionId,
      transcript: path.relative(temporary, transcript),
      clock: NOW,
    }),
  );
  await atomic(
    path.join(temporary, "loaded-conversation.json"),
    JSON.stringify({
      accountUuid: a.desktop!.accountUuid,
      orgId: a.desktop!.orgId,
      sessionId,
    }),
  );
  const sentinel = path.join(temporary, "sentinel-bin");
  await fs.mkdir(sentinel, { mode: 0o700 });
  // A real CLI lookup would trip this local sentinel instead of reaching the
  // user's installed binary. The receiver itself uses the exact Node path.
  await fs.writeFile(
    path.join(sentinel, "claude"),
    '#!/bin/sh\nprintf "unexpected" >> "$RELAY_LAB_SENTINEL"\nexit 88\n',
    { mode: 0o700 },
  );
  const sentinelFile = path.join(temporary, "unexpected-claude-call");
  async function receiver(command: Record<string, unknown>): Promise<unknown> {
    operations.receiverProcesses++;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [receiverFile], {
        cwd: temporary,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: sentinel,
          HOME: temporary,
          TMPDIR: temporary,
          RELAY_CONTINUATION_LAB: "1",
          RELAY_LAB_ROOT: temporary,
          RELAY_LAB_SENTINEL: sentinelFile,
        },
        windowsHide: true,
      });
      let stdout = "",
        stderrBytes = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Isolated receiver timed out."));
      }, 5_000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 64 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
      });
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Isolated receiver could not start."));
      });
      child.on("close", async (code) => {
        clearTimeout(timer);
        // Only release a crashed receiver's lease after this exact subprocess
        // has exited. A live receiver's files are never force-unlocked.
        if (code !== 0)
          await fs.rm(path.join(temporary, "receiver-transaction.lock"), {
            force: true,
          });
        if (
          code !== 0 ||
          stderrBytes ||
          Buffer.byteLength(stdout) > 64 * 1024
        ) {
          reject(new Error("Isolated receiver rejected the operation."));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid isolated receiver receipt."));
        }
      });
      child.stdin.end(JSON.stringify(command));
    });
  }
  const control = {
    contextRevision: 1,
    status: "stopped" as "stopped" | "running" | "waiting" | "unknown",
    busyWorkers: 0,
    subagents: 0,
    pendingTasks: 0,
    waiting: 0,
    queuedPrompts: 0,
    scheduledWakeups: 0,
    unknownWork: 0,
    coverage: "isolated-all" as "isolated-all" | "unknown",
    fault: "none" as LabFault,
  };
  const advance = () => {
    control.contextRevision++;
  };
  const persistControl = async () =>
    withReceiverLock(temporary, () =>
      atomic(
        path.join(temporary, "receiver-state.json"),
        JSON.stringify(control),
      ),
    );
  const inspection = async () =>
    receiver({ op: "inspect" }) as Promise<ReceiverInspection>;
  const state = async (): Promise<ContinuationState> => {
    await persistControl();
    const observed = await inspection();
    return {
      contextRevision: control.contextRevision,
      observedAt: NOW,
      identity: observed.identity,
      session: {
        id: observed.sessionId,
        projectKey: observed.projectKey,
        transcriptRevision: observed.transcriptRevision,
        permissionMode: "default",
        status: control.status,
        lastRequestId: observed.lastRequestId,
        lastTurnId: observed.lastTurnId,
      },
      quiescence: {
        coverage: control.coverage,
        busyWorkers: control.busyWorkers,
        subagents: control.subagents,
        pendingTasks: control.pendingTasks,
        waiting: control.waiting,
        queuedPrompts: control.queuedPrompts,
        scheduledWakeups: control.scheduledWakeups,
        unknownWork: control.unknownWork,
      },
    };
  };
  function conditional(expected: number) {
    assert.equal(
      control.contextRevision,
      expected,
      "conditional context changed",
    );
    assert.equal(control.status, "stopped");
    assert.equal(control.coverage, "isolated-all");
    for (const key of [
      "busyWorkers",
      "subagents",
      "pendingTasks",
      "waiting",
      "queuedPrompts",
      "scheduledWakeups",
      "unknownWork",
    ] as const)
      assert.equal(control[key], 0, "conditional task context changed");
  }
  const host: ContinuationHost = {
    capabilities: {
      kind: "simulated",
      contractId: "relay-isolated-executable-receiver-v1",
      exactSession: true,
      conditionalActions: true,
      idempotentDelivery: true,
      deliveryLookup: true,
      checkpoint: true,
      accountSwitch: true,
      sessionReopen: true,
      targetedSend: true,
      deliveryReceipt: true,
      atomicContextGuard: true,
    },
    readState: state,
    checkpoint: async (input) => {
      conditional(input.expectedContextRevision);
      const id = randomUUID();
      const bytes = await fs.readFile(transcript);
      assert.equal(digest(bytes), input.session.transcriptRevision);
      await atomic(
        path.join(temporary, "checkpoints", `${id}.json`),
        JSON.stringify({
          session: input.session,
          transcript: bytes.toString("base64"),
        }),
      );
      return { id, session: input.session };
    },
    switchAccount: async (input) => {
      conditional(input.expectedContextRevision);
      await manager.switchTo(input.target.profileId, {
        canProceed: () =>
          control.contextRevision === input.expectedContextRevision,
      });
      const active = await manager.snapshot();
      assert.equal(active.activeProfileId, input.target.profileId);
      assert.equal(active.currentAccountUuid, input.target.accountUuid);
      operations.switches++;
      advance();
      if (control.fault === "after-switch") {
        control.fault = "none";
        throw new Error("simulated-engine-loss-after-switch");
      }
    },
    reopenSession: async (input) => {
      conditional(input.expectedContextRevision);
      const saved = JSON.parse(
        await fs.readFile(
          path.join(temporary, "checkpoints", `${input.checkpoint.id}.json`),
          "utf8",
        ),
      );
      assert.deepEqual(saved.session, input.checkpoint.session);
      assert.equal(
        digest(Buffer.from(saved.transcript, "base64")),
        input.checkpoint.session.transcriptRevision,
      );
      const observed = await inspection();
      assert.deepEqual(observed.identity, input.target);
      assert.equal(observed.sessionId, input.checkpoint.session.id);
      assert.equal(
        observed.transcriptRevision,
        input.checkpoint.session.transcriptRevision,
      );
      assert.equal(observed.cwdVerified, true);
      const opened = (await receiver({
        op: "open",
        requestId: input.requestId,
        sessionId: input.checkpoint.session.id,
        transcriptRevision: input.checkpoint.session.transcriptRevision,
        expectedContextRevision: input.expectedContextRevision,
      })) as { loaded: boolean };
      assert.equal(opened.loaded, true);
      assert.equal((await inspection()).loaded, true);
      operations.opens++;
      advance();
    },
    sendContinuation: async (input) => {
      conditional(input.expectedContextRevision);
      if (control.fault === "before-send") {
        control.fault = "none";
        throw new Error("simulated-engine-loss-before-send");
      }
      if (control.fault === "unknown-ack") return { status: "unknown" };
      if (control.fault === "context-race") {
        advance();
        control.queuedPrompts = 1;
      }
      await persistControl();
      operations.sends++;
      const receipt = (await receiver({
        op: "send",
        requestId: input.requestId,
        identity: input.target,
        session: input.session,
        text: input.text,
        expectedContextRevision: input.expectedContextRevision,
        fault:
          control.fault === "receiver-crash-before-receipt"
            ? "crash-before-receipt"
            : undefined,
      })) as ContinuationDelivery;
      advance();
      control.status = "running";
      if (control.fault === "after-commit") {
        control.fault = "none";
        throw new Error("simulated-acknowledgement-loss-after-receiver-commit");
      }
      return receipt;
    },
    lookupDelivery: async (requestId) =>
      control.fault === "unknown-ack"
        ? { status: "unknown" }
        : (receiver({
            op: "lookup",
            requestId,
          }) as Promise<ContinuationDelivery>),
  };
  const quota = (account: Account, used: number): AccountUsage => ({
    accountId: account.id,
    status: "ready",
    stale: false,
    checkedAt: new Date(NOW).toISOString(),
    fiveHour: {
      usedPercent: used,
      resetsAt: new Date(NOW + 3_600_000).toISOString(),
    },
    sevenDay: {
      usedPercent: 10,
      resetsAt: new Date(NOW + 86_400_000).toISOString(),
    },
  });
  const request = async (
    source: Account,
    target: Account,
  ): Promise<ContinuationRequest> => {
    const observed = await state();
    return {
      id: randomUUID(),
      source,
      target,
      settings: structuredClone(store.state.settings),
      usage: {
        [source.id]: quota(source, 100),
        [target.id]: quota(target, 10),
      },
      sessionId,
      projectKey: "isolated-project",
      transcriptRevision: observed.session.transcriptRevision,
      permissionMode: "default",
      expectedContextRevision: observed.contextRevision,
      authorized: true,
    };
  };
  Object.assign(operations, {
    quits: 0,
    launches: 0,
    switches: 0,
    opens: 0,
    sends: 0,
    receiverProcesses: 0,
  });
  return {
    temporary,
    desktopRoot,
    transcript,
    project,
    sessionId,
    store,
    manager,
    host,
    journal,
    control,
    a,
    b,
    operations,
    state,
    request,
    localRecord,
    engine: () => new ContinuationEngine(host, journal, () => NOW),
    cleanup: () => fs.rm(temporary, { recursive: true, force: true }),
    sentinelFile,
  };
}

async function scenario<T>(
  action: (lab: Awaited<ReturnType<typeof fixture>>) => Promise<T>,
) {
  const lab = await fixture();
  try {
    const result = await action(lab);
    await assert.rejects(fs.stat(lab.sentinelFile), { code: "ENOENT" });
    return result;
  } finally {
    await lab.cleanup();
  }
}

export async function runContinuationLab() {
  const roundTrip = await scenario(async (lab) => {
    const before = await fs.readFile(lab.transcript);
    const first = await lab.request(lab.a, lab.b);
    const forward = await lab.engine().execute(first);
    assert.equal(forward.status, "continued");
    const firstRecord = await lab.journal.read(first.id);
    assert(firstRecord?.receipt);
    assert.equal(firstRecord.receipt.identity.profileId, lab.b.id);
    const middle = await fs.readFile(lab.transcript);
    assert.deepEqual(middle.subarray(0, before.length), before);
    const bHistory = await lab.manager.historySummary(lab.b.id);
    assert.equal(bHistory.indexed, 1);
    assert.equal(bHistory.transcriptsFound, 1);
    assert.equal(bHistory.projects, 1);
    const project = await readObject(
      lab.desktopRoot,
      `local-agent-mode-sessions/${lab.b.desktop!.accountUuid}/${lab.b.desktop!.orgId}/spaces.json`,
    );
    assert.equal(
      project!.spaces[0].projects,
      undefined,
      "source server binding must not transfer",
    );
    const bRecord = await readObject(lab.desktopRoot, lab.localRecord(lab.b));
    assert.equal(bRecord!.cliSessionId, lab.sessionId);
    assert.equal(bRecord!.cwd, lab.project);
    lab.control.status = "stopped";
    const second = await lab.request(lab.b, lab.a);
    const backward = await lab.engine().execute(second);
    assert.equal(backward.status, "continued");
    const secondRecord = await lab.journal.read(second.id);
    assert(secondRecord?.receipt);
    const after = await fs.readFile(lab.transcript);
    assert.deepEqual(after.subarray(0, middle.length), middle);
    const messages = after
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages.length, 6);
    assert.equal(messages[3].message.content, "LAB_STEP_1_OK");
    assert.equal(messages[3].accountLabel, "B");
    assert.equal(messages[5].message.content, "LAB_STEP_2_OK");
    assert.equal(messages[5].accountLabel, "A");
    assert(
      messages.every(
        (message) =>
          message.sessionId === lab.sessionId && message.cwd === lab.project,
      ),
    );
    const progress = JSON.parse(
      await fs.readFile(path.join(lab.project, "progress.json"), "utf8"),
    );
    assert.equal(progress.completedStep, 2);
    const aRecord = await readObject(lab.desktopRoot, lab.localRecord(lab.a));
    assert.equal(aRecord!.cliSessionId, lab.sessionId);
    assert.equal(aRecord!.cwd, lab.project);
    assert.equal(aRecord!.permissionMode, "default");
    const replay = await lab.engine().execute(second);
    assert.equal(replay.status, "continued");
    assert.deepEqual(await fs.readFile(lab.transcript), after);
    assert.equal(lab.operations.sends, 2);
    assert.equal((await lab.manager.snapshot()).activeProfileId, lab.a.id);
    await assert.rejects(fs.stat(lab.sentinelFile), { code: "ENOENT" });
    return {
      scenario: "A-B-A",
      stage: "delivery-confirmed",
      exactSessionId: lab.sessionId,
      accounts: ["A", "B", "A"],
      continuationSteps: [1, 2],
      messagesBefore: 2,
      messagesAfter: 6,
      preservedPrefix: true,
      projectAndTranscriptRetained: true,
      serverBindingsTransferred: false,
      permissionMode: "default",
      beforeRevision: digest(before),
      middleRevision: digest(middle),
      afterRevision: digest(after),
      receipts: [firstRecord.receipt, secondRecord.receipt],
      replayCreatedNewTurn: false,
      checkpointBytesVerified: true,
      receiverLoadedExactConversation: true,
      ...lab.operations,
    };
  });
  const blocked: Record<string, unknown>[] = [];
  for (const condition of [
    "busy-subagent",
    "waiting-permission",
    "unknown-coverage",
    "changed-revision",
    "target-exhausted",
  ] as const) {
    blocked.push(
      await scenario(async (lab) => {
        const request = await lab.request(lab.a, lab.b);
        if (condition === "busy-subagent") lab.control.subagents = 1;
        if (condition === "waiting-permission") {
          lab.control.status = "waiting";
          lab.control.waiting = 1;
        }
        if (condition === "unknown-coverage") lab.control.coverage = "unknown";
        if (condition === "changed-revision")
          request.transcriptRevision = "0".repeat(64);
        if (condition === "target-exhausted")
          request.usage[lab.b.id].fiveHour!.usedPercent = 100;
        const beforeConfig = await fs.readFile(
          path.join(lab.desktopRoot, "config.json"),
        );
        const beforeTranscript = await fs.readFile(lab.transcript);
        const result = await lab.engine().execute(request);
        assert.equal(result.status, "blocked");
        assert.deepEqual(
          await fs.readFile(path.join(lab.desktopRoot, "config.json")),
          beforeConfig,
        );
        assert.deepEqual(await fs.readFile(lab.transcript), beforeTranscript);
        assert.equal(lab.operations.switches, 0);
        assert.equal(lab.operations.sends, 0);
        return {
          scenario: condition,
          stage: result.status,
          reason: result.reason,
          accountChanged: false,
          transcriptChanged: false,
          sends: 0,
        };
      }),
    );
  }
  const crashRecovery = await scenario(async (lab) => {
    const request = await lab.request(lab.a, lab.b);
    lab.control.fault = "after-commit";
    const interrupted = await lab.engine().execute(request);
    assert.equal(interrupted.status, "reconciliation-required");
    const committed = await fs.readFile(lab.transcript);
    const recovered = await lab.engine().execute(request);
    assert.equal(recovered.status, "continued");
    assert.deepEqual(await fs.readFile(lab.transcript), committed);
    assert.equal(lab.operations.sends, 1);
    const record = await lab.journal.read(request.id);
    assert(record?.receipt);
    return {
      scenario: "receiver-committed-acknowledgement-lost",
      beforeRecovery: interrupted.status,
      afterRecovery: recovered.status,
      receiptReconciled: true,
      crashMode:
        "fault-injected acknowledgement loss and fresh engine instance",
      sendCount: 1,
      duplicateTurns: 0,
      afterRevision: digest(committed),
    };
  });
  const preSendRecovery = await scenario(async (lab) => {
    const request = await lab.request(lab.a, lab.b);
    const before = await fs.readFile(lab.transcript);
    lab.control.fault = "after-switch";
    const interrupted = await lab.engine().execute(request);
    assert.equal(interrupted.status, "reconciliation-required");
    assert.equal(lab.operations.switches, 1);
    assert.equal(lab.operations.sends, 0);
    assert.deepEqual(await fs.readFile(lab.transcript), before);
    const recovered = await lab.engine().execute(request);
    assert.equal(recovered.status, "continued");
    assert.equal(lab.operations.switches, 1);
    assert.equal(lab.operations.sends, 1);
    const after = await fs.readFile(lab.transcript);
    assert.deepEqual(after.subarray(0, before.length), before);
    return {
      scenario: "engine-interrupted-after-account-switch-before-send",
      beforeRecovery: interrupted.status,
      afterRecovery: recovered.status,
      durableCheckpointReopened: true,
      accountSwitches: 1,
      sendCount: 1,
      duplicateTurns: 0,
      exactSessionId: lab.sessionId,
      beforeRevision: digest(before),
      afterRevision: digest(after),
    };
  });
  const uncertain: Record<string, unknown>[] = [];
  for (const fault of ["before-send", "unknown-ack", "context-race"] as const) {
    uncertain.push(
      await scenario(async (lab) => {
        const request = await lab.request(lab.a, lab.b);
        const before = await fs.readFile(lab.transcript);
        lab.control.fault = fault;
        const interrupted = await lab.engine().execute(request);
        const sends = lab.operations.sends;
        let retried = await lab.engine().execute(request);
        for (let attempt = 1; attempt < 3; attempt++)
          retried = await lab.engine().execute(request);
        assert.notEqual(retried.status, "continued");
        assert.equal(lab.operations.sends, sends);
        assert.deepEqual(await fs.readFile(lab.transcript), before);
        const replacement = await lab
          .engine()
          .execute({ ...request, id: randomUUID() });
        assert.equal(replacement.status, "blocked");
        assert.equal(replacement.reason, "unresolved-host-intent");
        assert.equal(lab.operations.sends, sends);
        return {
          scenario: fault,
          beforeRecovery: interrupted.status,
          afterRecovery: retried.status,
          reason: retried.reason,
          automaticResend: false,
          transcriptChanged: false,
          sendCount: sends,
          retries: 3,
          replacementRequestBlocked: true,
          replacementReason: replacement.reason,
        };
      }),
    );
  }
  const partialCommit = await scenario(async (lab) => {
    const request = await lab.request(lab.a, lab.b);
    const before = await fs.readFile(lab.transcript);
    lab.control.fault = "receiver-crash-before-receipt";
    const interrupted = await lab.engine().execute(request);
    assert.equal(interrupted.status, "reconciliation-required");
    const after = await fs.readFile(lab.transcript);
    assert.notDeepEqual(after, before);
    assert.deepEqual(after.subarray(0, before.length), before);
    assert.equal(after.toString().trim().split("\n").length, 4);
    const recovered = await lab.engine().execute(request);
    assert.equal(recovered.status, "reconciliation-required");
    assert.equal(recovered.reason, "delivery-absent");
    const replacement = await lab
      .engine()
      .execute({ ...request, id: randomUUID() });
    assert.equal(replacement.reason, "unresolved-host-intent");
    assert.equal(lab.operations.sends, 1);
    assert.deepEqual(await fs.readFile(lab.transcript), after);
    return {
      scenario: "receiver-process-exited-after-transcript-before-receipt",
      receiverExitCode: 86,
      beforeRecovery: interrupted.status,
      afterRecovery: recovered.status,
      transcriptAdvanced: true,
      receiptAvailable: false,
      automaticResend: false,
      replacementRequestBlocked: true,
      sendCount: 1,
      duplicateTurns: 0,
      beforeRevision: digest(before),
      afterRevision: digest(after),
    };
  });
  return {
    version: 1,
    mode: "simulated-isolated-executable-lab",
    operation: "checkpointed-handoff-and-new-turn",
    actualAccountsUsed: false,
    actualClaudeControlled: false,
    actualClaudeInvocations: 0,
    anthropicRequests: 0,
    syntheticCredentialsOnly: true,
    temporaryFilesystemOnly: true,
    childEnvironment: "scrubbed-temporary-home-and-claude-sentinel",
    nativeApplicationTransport: "injected-fake-host",
    conversationReceiver: "deterministic-node-subprocess",
    realProductionComponents: [
      "Store",
      "DesktopManager",
      "desktop-vault",
      "Desktop history merge",
      "ContinuationEngine",
    ],
    routinesEnabled: false,
    uninterruptedWorkerTransferProven: false,
    productionAdapterEnabled: false,
    crashEvidenceScope:
      "receiver-process exit and injected engine/acknowledgement loss; no power-loss guarantee",
    roundTrip,
    blocked,
    crashRecovery,
    preSendRecovery,
    partialCommit,
    uncertain,
    assertionsPassed: true,
  };
}

const help = `Usage: node --import tsx scripts/continuation-lab.ts [--json]\n\nExecutes an isolated A → B → A checkpoint continuation using synthetic accounts,\nreal Relay switching/history code and a deterministic local receiver. No Claude\napplication, CLI, real credential, network or routine is used.\n`;
async function main(args: string[]) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    process.stdout.write(help);
    return;
  }
  if (args.length && (args.length !== 1 || args[0] !== "--json")) {
    process.stderr.write("Invalid lab arguments. Use --help.\n");
    process.exitCode = 2;
    return;
  }
  try {
    const report = await runContinuationLab();
    process.stdout.write(
      args[0] === "--json"
        ? JSON.stringify(report, null, 2) + "\n"
        : `Isolated continuation lab passed: A → B → A, two new turns, five blocked cases, committed-receipt recovery, three uncertain-delivery cases.\nSynthetic accounts and deterministic receiver only; real Claude untouched.\n`,
    );
  } catch {
    process.stderr.write(
      "The isolated continuation lab failed; no real Claude action was attempted.\n",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  void main(process.argv.slice(2));
