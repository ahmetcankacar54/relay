import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../electron/core/store";
import type { DesktopManager } from "../electron/core/desktop";
import {
  combineDesktopProcesses,
  desktopProcessQuiescence,
  isDesktopClaudeEngine,
  latestQuotaEndedTurn,
  parseCpuTimes,
  parseDesktopTranscript,
  transcriptTurnState,
  movedOn,
  engineCommands,
  parseListeningPorts,
  continuationTurn,
  NativeDesktopContinuationEvidence,
  type DesktopProcess,
} from "../electron/core/desktop-continuation-evidence";
import type {
  DesktopAutomation,
  DesktopAutomationSnapshot,
} from "../electron/core/desktop-continuation-host";

const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const assistantId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const nextAssistant = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const app: DesktopProcess = {
  pid: 456,
  ppid: 1,
  executable: "/Applications/Claude.app/Contents/MacOS/Claude",
  args: "Claude",
};
const sourceEngine: DesktopProcess = {
  pid: 457,
  ppid: 456,
  executable: "/test/claude",
  args: `claude --resume ${uuid}`,
};
const roster = (...extra: DesktopProcess[]) => JSON.stringify([app, ...extra]);
const terminal = {
  type: "assistant",
  uuid: assistantId,
  timestamp: "2026-10-13T14:00:00.000Z",
  error: "rate_limit",
  message: { content: "limited" },
};

test("process census preserves paths with spaces and pairs args by PID", () => {
  const combined = JSON.parse(
    combineDesktopProcesses(
      "456 1 /Applications/Claude.app/Contents/MacOS/Claude\n457 456 /path with spaces/claude\n",
      "457 claude --resume id\n456 Claude\n",
    ),
  );
  assert.equal(combined[1].executable, "/path with spaces/claude");
  assert.equal(combined[1].args, "claude --resume id");
});
test("one exact selected engine with terminal transcript may remain alive", () => {
  assert.equal(
    desktopProcessQuiescence(roster(sourceEngine), 456, uuid, true).busyWorkers,
    0,
  );
  assert.equal(
    desktopProcessQuiescence(roster(sourceEngine), 456, uuid, false)
      .busyWorkers,
    1,
  );
});
test("idle sibling engines do not block; unfinished transcripts and active tools do", () => {
  const sibling = {
    ...sourceEngine,
    pid: 458,
    args: "claude --resume eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
  };
  const wrapper = {
    pid: 460,
    ppid: 456,
    executable: "/Applications/Claude.app/Contents/Helpers/disclaimer",
    args: "disclaimer --pgroup -- claude",
  };
  assert.deepEqual(
    desktopProcessQuiescence(
      roster(sourceEngine, sibling, wrapper),
      456,
      uuid,
      true,
      { busyTranscripts: 0, activePids: new Set() },
    ),
    {
      coverage: "guarded-local",
      busyWorkers: 0,
      subagents: 0,
      pendingTasks: 0,
      waiting: 0,
      queuedPrompts: 0,
      scheduledWakeups: 0,
      unknownWork: 0,
    },
  );
  assert.equal(
    desktopProcessQuiescence(roster(sourceEngine, sibling), 456, uuid, true, {
      busyTranscripts: 1,
      activePids: new Set(),
    }).busyWorkers,
    1,
  );
  const shell = { pid: 459, ppid: 457, executable: "/bin/bash", args: "bash" };
  // A tool process blocks until CPU has been measured, and while it is busy.
  for (const [inputs, expected] of [
    [{}, 1],
    [{ activePids: new Set([459]) }, 1],
    [{ activePids: new Set<number>() }, 0],
  ] as const)
    assert.equal(
      desktopProcessQuiescence(
        roster(sourceEngine, shell),
        456,
        uuid,
        true,
        inputs,
      ).unknownWork,
      expected,
    );
});
test("normal Chromium helpers are allowed but their arbitrary child is not", () => {
  const helper = {
    pid: 458,
    ppid: 456,
    executable:
      "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)",
    args: "helper",
  };
  assert.equal(
    desktopProcessQuiescence(roster(helper), 456, uuid, false).unknownWork,
    0,
  );
  assert.equal(
    desktopProcessQuiescence(
      roster(helper, {
        pid: 459,
        ppid: 458,
        executable: "/bin/python",
        args: "python task",
      }),
      456,
      uuid,
      false,
    ).unknownWork,
    1,
  );
});
test("bad or missing app census remains unknown", () => {
  for (const raw of [
    "not json",
    "[]",
    JSON.stringify([app, app]),
    JSON.stringify([{ ...app, args: undefined }]),
  ]) {
    assert.equal(
      desktopProcessQuiescence(raw, 456, uuid, true).coverage,
      "unknown",
    );
  }
});
test("Claude Code engines are recognized, but those outside Claude's tree do not block", () => {
  const versioned = {
    pid: 900,
    ppid: 1,
    executable: "/Users/test/.local/share/claude/versions/2.1.296",
    args: "claude --resume different",
  };
  const npm = {
    pid: 901,
    ppid: 1,
    executable: "/opt/homebrew/bin/node",
    args: "node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume different",
  };
  const npmBin = {
    ...npm,
    pid: 902,
    args: "node /opt/homebrew/bin/claude --resume different",
  };
  const npmSpaces = {
    ...npm,
    pid: 903,
    args: "node /Users/Test User/node_modules/@anthropic-ai/claude-code/cli.js --resume different",
  };
  const nativeHost = {
    pid: 904,
    ppid: 1,
    executable: "/Applications/Claude.app/Contents/Helpers/chrome-native-host",
    args: "chrome-native-host",
  };
  for (const worker of [versioned, npm, npmBin, npmSpaces]) {
    assert.equal(isDesktopClaudeEngine(worker), true);
    const census = desktopProcessQuiescence(
      roster(worker, nativeHost),
      456,
      uuid,
      true,
      { busyTranscripts: 0, activePids: new Set() },
    );
    assert.equal(census.busyWorkers + census.unknownWork, 0);
  }
  assert.equal(
    isDesktopClaudeEngine({
      ...npm,
      args: "node /test/unrelated.js --prompt @anthropic-ai/claude-code",
    }),
    false,
  );
});
test("transcript turn state: finished, interrupted and errored turns are idle; tools and prompts are busy", () => {
  const user = (content: unknown, extra = {}) => ({
    type: "user",
    message: { content },
    ...extra,
  });
  const assistant = (content: unknown, stop_reason: string | null) => ({
    type: "assistant",
    message: { content, stop_reason },
  });
  const cases: [Record<string, unknown>[], "idle" | "busy"][] = [
    [
      [user("hi"), assistant([{ type: "text", text: "done" }], "end_turn")],
      "idle",
    ],
    [[user("hi")], "busy"],
    [[user([{ type: "tool_result", content: "ok" }])], "busy"],
    [[assistant([{ type: "tool_use", name: "Bash" }], "tool_use")], "busy"],
    [[user("[Request interrupted by user]")], "idle"],
    [
      [user("hi"), { ...assistant("limited", null), error: "rate_limit" }],
      "idle",
    ],
    [
      [
        assistant([{ type: "text", text: "x" }], "end_turn"),
        user("note", { isMeta: true }),
      ],
      "idle",
    ],
    [[assistant([{ type: "text", text: "x" }], null)], "busy"],
    [[], "idle"],
  ];
  for (const [rows, expected] of cases)
    assert.equal(transcriptTurnState(rows), expected, JSON.stringify(rows));
});
test("cumulative CPU times parse minutes, hours and days", () => {
  const times = parseCpuTimes(
    "  1 161:55.53\n 295   0:00.96\n 7 1-02:03:04.50\nbad line\n",
  );
  assert.equal(times.get(1), 161 * 60 + 55.53);
  assert.equal(times.get(295), 0.96);
  assert.equal(times.get(7), 86_400 + 2 * 3600 + 3 * 60 + 4.5);
  assert.equal(times.size, 3);
});
test("only the latest main assistant structured rate error is a quota-ended turn", () => {
  assert.equal(latestQuotaEndedTurn([terminal])?.turnId, assistantId);
  assert.equal(
    latestQuotaEndedTurn([
      terminal,
      { type: "user", uuid: userId, message: { content: "new task" } },
    ]),
    undefined,
  );
  assert.equal(
    latestQuotaEndedTurn([{ ...terminal, error: "network_error" }]),
    undefined,
  );
  assert.equal(
    latestQuotaEndedTurn([{ ...terminal, isSidechain: true }]),
    undefined,
  );
});

const noticeA = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const noticeB = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
/** A background task's notification, as Claude Code writes it. */
const notice = (id: string, parentUuid: string) => ({
  type: "user",
  uuid: id,
  parentUuid,
  timestamp: "2026-10-13T14:00:30.000Z",
  origin: { kind: "task-notification", producer: "session-task" },
  message: {
    role: "user",
    content:
      "<task-notification>\n<task-id>a3870edfc2231487c</task-id>\n<status>completed</status>\n</task-notification>",
  },
});
test("task notifications after a quota stop leave it stopped and idle; after a finished turn they start one", () => {
  const stopped = [
    terminal,
    notice(noticeA, assistantId),
    notice(noticeB, noticeA),
  ];
  assert.equal(transcriptTurnState(stopped), "idle");
  assert.equal(latestQuotaEndedTurn(stopped)?.turnId, assistantId);
  assert.equal(
    latestQuotaEndedTurn(stopped)?.timestamp,
    Date.parse(terminal.timestamp),
  );
  // Older transcripts carry no origin; the text still says what the row is.
  const { origin: _, ...legacy } = notice(noticeA, assistantId);
  assert.equal(transcriptTurnState([terminal, legacy]), "idle");
  assert.equal(latestQuotaEndedTurn([terminal, legacy])?.turnId, assistantId);
  // A newer quota stop answering a notification is the stop.
  assert.equal(
    latestQuotaEndedTurn([
      ...stopped,
      { ...terminal, uuid: nextAssistant, parentUuid: noticeB },
    ])?.turnId,
    nextAssistant,
  );
  // With quota, a notification after a finished or otherwise failed turn
  // starts a new turn: work is running until its reply ends.
  for (const before of [
    {
      type: "assistant",
      uuid: assistantId,
      message: {
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
      },
    },
    { ...terminal, error: "network_error" },
  ]) {
    const rows = [before, notice(noticeA, assistantId)];
    assert.equal(transcriptTurnState(rows), "busy", JSON.stringify(before));
    assert.equal(latestQuotaEndedTurn(rows), undefined);
  }
  // A person's prompt, even one quoting a notification, ends the stop.
  for (const after of [
    { type: "user", uuid: userId, message: { content: "go on" } },
    { ...notice(userId, noticeA), origin: { kind: "human" } },
  ]) {
    const rows = [...stopped, after];
    assert.equal(transcriptTurnState(rows), "busy", JSON.stringify(after));
    assert.equal(latestQuotaEndedTurn(rows), undefined);
  }
});
test("the receipt looks past Claude's synthetic reply before the prompt and notifications after it", () => {
  const filler = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
  /** What Claude Code writes before the first prompt after a stop. */
  const noResponse = {
    type: "assistant",
    uuid: filler,
    parentUuid: noticeB,
    isApiErrorMessage: false,
    message: {
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      content: [{ type: "text", text: "No response requested." }],
    },
  };
  const prompt = {
    type: "user",
    uuid: userId,
    parentUuid: filler,
    message: { content: "Continue\n[Relay continuation: request]" },
  };
  const reply = {
    type: "assistant",
    uuid: nextAssistant,
    parentUuid: userId,
    message: {
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    },
  };
  const accepted = continuationTurn([noResponse, prompt], "request");
  assert.equal(accepted?.user.uuid, userId);
  assert.equal(accepted?.assistant, undefined);
  assert.equal(
    continuationTurn([noResponse, prompt, reply], "request")?.assistant?.uuid,
    nextAssistant,
  );
  // A background task finishing during the resumed turn is not a new prompt.
  assert.equal(
    continuationTurn(
      [noResponse, prompt, reply, notice(noticeA, nextAssistant)],
      "request",
    )?.assistant?.uuid,
    nextAssistant,
  );
  // A synthetic row after the prompt proves nothing resumed.
  assert.equal(
    continuationTurn(
      [prompt, { ...noResponse, uuid: nextAssistant, parentUuid: userId }],
      "request",
    )?.assistant,
    undefined,
  );
  // One outside the prompt's own chain is still other work.
  assert.equal(
    continuationTurn(
      [noResponse, { ...prompt, parentUuid: noticeB }],
      "request",
    ),
    undefined,
  );
});
test("partial or malformed transcript records cannot become a safe checkpoint", () => {
  assert.throws(() =>
    parseDesktopTranscript(Buffer.from('{"type":"assistant"}')),
  );
  assert.throws(() => parseDesktopTranscript(Buffer.from("invalid\n")));
  assert.equal(
    parseDesktopTranscript(Buffer.from('{"type":"assistant"}\n')).length,
    1,
  );
});
test("continuation receipt binds the latest assistant chain to the nonce user turn", () => {
  const working = [
    {
      type: "user",
      uuid: userId,
      message: { content: "Continue\n[Relay continuation: request]" },
    },
    {
      type: "assistant",
      uuid: assistantId,
      parentUuid: userId,
      message: { content: [{ type: "tool_use" }], stop_reason: "tool_use" },
    },
    {
      type: "user",
      uuid: nextAssistant.replace(/d/g, "e"),
      parentUuid: assistantId,
      message: { content: [{ type: "tool_result", content: "ok" }] },
    },
  ];
  // A tool result as the latest row still proves the resumed turn started.
  assert.equal(
    continuationTurn(working, "request")?.assistant?.uuid,
    assistantId,
  );
  const user = {
    type: "user",
    uuid: userId,
    message: { content: "Continue\n[Relay continuation: request]" },
  };
  const assistant = {
    type: "assistant",
    uuid: assistantId,
    parentUuid: userId,
    message: { content: "started" },
  };
  const final = { ...assistant, uuid: nextAssistant, parentUuid: assistantId };
  assert.equal(continuationTurn([user])?.assistant, undefined);
  assert.equal(
    continuationTurn([user, assistant, final], "request")?.assistant?.uuid,
    nextAssistant,
  );
  assert.equal(
    continuationTurn([user, { ...assistant, parentUuid: uuid }], "request"),
    undefined,
  );
  assert.equal(
    continuationTurn(
      [
        user,
        assistant,
        { type: "user", uuid, message: { content: "human changed the task" } },
      ],
      "request",
    ),
    undefined,
  );
});

test("every supported quota error form acknowledges the user turn without claiming resumed work", () => {
  const user = {
    type: "user",
    uuid: userId,
    message: { content: "Continue\n[Relay continuation: request]" },
  };
  for (const reason of [
    "rate_limit",
    "rate_limit_error",
    "rate-limit",
    "usage_limit",
  ]) {
    for (const error of [
      { error: reason },
      { error: { type: reason } },
      { errorType: reason },
      { apiError: { type: reason } },
      { message: { content: "limited", stop_reason: reason } },
    ]) {
      const assistant = {
        type: "assistant",
        uuid: assistantId,
        parentUuid: userId,
        timestamp: "2026-10-13T14:00:00.000Z",
        message: { content: "limited" },
        ...error,
      };
      const rows = [user, assistant];
      assert.equal(latestQuotaEndedTurn(rows)?.turnId, assistantId);
      assert.equal(continuationTurn(rows, "request")?.user.uuid, userId);
      assert.equal(continuationTurn(rows, "request")?.assistant, undefined);
    }
  }
  for (const error of [
    { errorType: "network_error" },
    { errorType: "overloaded_error" },
    { isApiErrorMessage: true },
  ]) {
    const rows = [
      user,
      {
        type: "assistant",
        uuid: assistantId,
        parentUuid: userId,
        message: { content: "request failed" },
        ...error,
      },
    ];
    assert.equal(latestQuotaEndedTurn(rows), undefined);
    assert.equal(continuationTurn(rows, "request")?.assistant, undefined);
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-evidence-test-"));
  const store = new Store(path.join(root, "relay"));
  const source = store.create({ name: "source", kind: "personal" });
  const target = store.create({ name: "target", kind: "personal" });
  const org = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  store.update((s) => {
    for (const account of s.accounts)
      account.desktop = {
        accountUuid: account.id,
        orgId: org,
        savedAt: "2026-10-13T14:00:00.000Z",
      };
  });
  const claudeRoot = path.join(root, "desktop");
  const transcriptRoot = path.join(root, "transcripts");
  const cwd = path.join(root, "project");
  const relative = `projects/-test/${uuid}.jsonl`;
  const transcriptFile = path.join(transcriptRoot, relative);
  const metadata = {
    cliSessionId: uuid,
    cwd,
    lastActivityAt: 1,
    permissionMode: "auto",
  };
  const metadataFile = (accountId: string) =>
    path.join(
      claudeRoot,
      "claude-code-sessions",
      accountId,
      org,
      `local_${uuid}.json`,
    );
  for (const account of [source, target]) {
    await fs.mkdir(path.dirname(metadataFile(account.id)), { recursive: true });
    await fs.writeFile(metadataFile(account.id), JSON.stringify(metadata));
  }
  await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
  await fs.writeFile(
    transcriptFile,
    JSON.stringify({ ...terminal, cwd }) + "\n",
  );
  let active = source.id;
  await fs.writeFile(
    path.join(claudeRoot, "config.json"),
    JSON.stringify({ lastKnownAccountUuid: active }),
  );
  const ui: DesktopAutomationSnapshot = {
    observedAt: Date.parse("2026-10-13T14:01:00.000Z"),
    pid: 456,
    localSessionId: `local_${uuid}`,
    accountLabel: "Test account",
    permissionMode: "Auto",
    status: "stopped",
    quotaStopped: true,
    composerEmpty: true,
    sendEnabled: true,
    contextFingerprint: "a".repeat(64),
    coverage: "active-conversation-only",
  };
  const automation: DesktopAutomation = {
    inspect: async () => ({ ...ui }),
    openSession: async () => {},
    openNewSession: async () => {
      throw new Error("openNewSession must not be called here");
    },
    setPermission: async (_g, mode) => ({ ...ui, permissionMode: mode }),
    send: async () => ({ acceptedVisible: false }),
    hasRequestMarker: async () => false,
    writeDraft: async () => {
      throw new Error("writeDraft must not be called here");
    },
  };
  const desktop = {
    snapshot: async () => ({
      currentAccountUuid: active,
      organizations: [org],
      recoveryRequired: false,
      pendingProfileId: undefined,
    }),
    switchTo: async (
      accountId: string,
      options: { beforeQuit?: () => Promise<void>; canProceed?: () => boolean },
    ) => {
      await options.beforeQuit?.();
      assert.equal(options.canProceed?.(), true);
      active = accountId;
      await fs.writeFile(
        path.join(claudeRoot, "config.json"),
        JSON.stringify({ lastKnownAccountUuid: active }),
      );
    },
  } as unknown as DesktopManager;
  const evidence = new NativeDesktopContinuationEvidence({
    store,
    desktop,
    automation,
    claudeRoot,
    transcriptRoot,
    processes: async () => roster(),
    processesSync: () => roster(),
    cpuTimes: () => "456 0:01.00\n",
    now: () => ui.observedAt,
  });
  return { root, evidence, ui, source, target, org, transcriptFile, store };
}
test("real metadata adapter binds alias, account, project, transcript and quota turn", async () => {
  const f = await fixture();
  try {
    const state = await f.evidence.read(f.ui);
    assert.equal(state.session.id, uuid);
    assert.equal(state.identity.profileId, f.source.id);
    assert.equal(state.quotaStop?.turnId, assistantId);
    assert.equal(state.quiescence.coverage, "guarded-local");
    assert.equal(state.session.projectKey, path.join(f.root, "project"));
    assert.equal(
      state.contextRevision,
      (await f.evidence.read(f.ui)).contextRevision,
    );
    f.ui.quotaAutoResume = true;
    const wake = await f.evidence.read(f.ui);
    assert.equal(wake.quiescence.scheduledWakeups, 1);
    assert.equal(wake.ownQuotaWakeup, true);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("durable receipt progresses absent→accepted→started with exact assistant turn ID", async () => {
  const f = await fixture();
  try {
    const state = await f.evidence.read(f.ui);
    await f.evidence.checkpoint({
      requestId: "request",
      session: state.session,
      expectedContextRevision: state.contextRevision,
    });
    await f.evidence.switchAccount({
      requestId: "request",
      target: {
        profileId: f.target.id,
        accountUuid: f.target.id,
        orgId: f.org,
      },
      expectedContextRevision: state.contextRevision,
    });
    assert.deepEqual(await f.evidence.lookupDelivery("request"), {
      status: "absent",
    });
    const user = {
      type: "user",
      uuid: userId,
      parentUuid: assistantId,
      message: { content: "Continue\n[Relay continuation: request]" },
    };
    await fs.appendFile(f.transcriptFile, JSON.stringify(user) + "\n");
    assert.deepEqual(await f.evidence.lookupDelivery("request"), {
      status: "accepted",
    });
    for (const [index, error] of [
      { errorType: "rate_limit" },
      { message: { content: "quota exhausted", stop_reason: "usage_limit" } },
    ].entries()) {
      await fs.appendFile(
        f.transcriptFile,
        JSON.stringify({
          type: "assistant",
          uuid: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          parentUuid: userId,
          timestamp: "2026-10-13T14:01:00.000Z",
          message: { content: "quota exhausted" },
          ...error,
        }) + "\n",
      );
      assert.deepEqual(await f.evidence.lookupDelivery("request"), {
        status: "accepted",
      });
    }
    await fs.appendFile(
      f.transcriptFile,
      JSON.stringify({
        type: "assistant",
        uuid: nextAssistant,
        parentUuid: userId,
        message: { content: "continuing", stop_reason: "end_turn" },
      }) + "\n",
    );
    const receipt = await f.evidence.lookupDelivery("request");
    assert.equal(receipt.status, "started");
    assert.equal(receipt.receipt?.turnId, nextAssistant);
    const read = await f.evidence.read(f.ui);
    assert.equal(read.session.lastRequestId, "request");
    assert.equal(read.session.lastTurnId, nextAssistant);
    assert.equal(
      read.session.transcriptRevision,
      receipt.receipt?.afterRevision,
    );
    await fs.appendFile(
      f.transcriptFile,
      JSON.stringify({
        type: "assistant",
        uuid: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        parentUuid: nextAssistant,
        isApiErrorMessage: true,
        error: "rate_limit",
        apiError: { type: "rate_limit_error" },
        timestamp: "2026-10-13T14:01:00.000Z",
        message: { content: "rate limit", stop_reason: "stop_sequence" },
      }) + "\n",
    );
    // The handoff succeeded: work resumed on the target before its own limit.
    const later = await f.evidence.lookupDelivery("request");
    assert.equal(later.status, "started");
    assert.equal(later.receipt?.turnId, nextAssistant);
    await fs.appendFile(
      f.transcriptFile,
      JSON.stringify({
        type: "user",
        uuid,
        message: { content: "new manual prompt" },
      }) + "\n",
    );
    assert.deepEqual(await f.evidence.lookupDelivery("request"), {
      status: "unknown",
    });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("a conversation whose tools changed directory is still observed; another unfinished turn blocks", async () => {
  const f = await fixture();
  try {
    const cwd = path.join(f.root, "project");
    await fs.writeFile(
      f.transcriptFile,
      [
        { type: "user", uuid: userId, cwd, message: { content: "go" } },
        {
          type: "attachment",
          cwd: path.join(cwd, "app", "Models"),
        },
        { ...terminal, parentUuid: userId, cwd: path.join(cwd, "app") },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    const quiet = await f.evidence.read(f.ui);
    assert.equal(quiet.quotaStop?.turnId, assistantId);
    assert.equal(quiet.quiescence.busyWorkers, 0);
    const other = path.join(path.dirname(f.transcriptFile), `${userId}.jsonl`);
    await fs.writeFile(
      other,
      JSON.stringify({ type: "user", message: { content: "still working" } }) +
        "\n",
    );
    const busy = await f.evidence.read(f.ui);
    assert.equal(busy.quiescence.busyWorkers, 1);
    // A transcript last written long ago is not a live conversation.
    const old = new Date(Date.parse("2026-10-13T10:00:00.000Z"));
    await fs.utimes(other, old, old);
    assert.equal((await f.evidence.read(f.ui)).quiescence.busyWorkers, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("other, empty organization folders of the account do not hide the open conversation's organization", async () => {
  const f = await fixture();
  try {
    const other = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const desktop = (
      f.evidence as unknown as {
        options: { desktop: { snapshot: () => Promise<any> } };
      }
    ).options.desktop;
    const original = desktop.snapshot;
    desktop.snapshot = async () => ({
      ...(await original()),
      organizations: [other, f.org],
    });
    const ui = { ...f.ui, accountLabel: "Ahmet" };
    const state = await f.evidence.read(ui);
    assert.equal(state.identity.profileId, f.source.id);
    // The same record under another organization makes the scope ambiguous.
    const duplicate = path.join(
      f.root,
      "desktop",
      "claude-code-sessions",
      f.source.id,
      other,
      `local_${uuid}.json`,
    );
    await fs.mkdir(path.dirname(duplicate), { recursive: true });
    await fs.writeFile(duplicate, "{}");
    await assert.rejects(f.evidence.read(ui), /desktop-observation-incomplete/);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("every quota-stopped conversation of an account is found from files, and its continuation is verified", async () => {
  const f = await fixture();
  try {
    const metadataFile = path.join(
      f.root,
      "desktop",
      "claude-code-sessions",
      f.source.id,
      f.org,
      `local_${uuid}.json`,
    );
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    metadata.lastActivityAt = Date.parse("2026-10-13T14:00:00.000Z");
    await fs.writeFile(metadataFile, JSON.stringify(metadata));
    const stops = await f.evidence.quotaStops(f.store.account(f.source.id));
    assert.equal(stops.length, 1);
    assert.equal(stops[0].localSessionId, `local_${uuid}`);
    assert.equal(stops[0].cliSessionId, uuid);
    assert.equal(stops[0].turnId, assistantId);
    assert.equal(stops[0].permissionMode, "Auto");
    assert.equal(f.evidence.unchanged(stops[0]), true);
    assert.equal(await f.evidence.quietExcept(stops), undefined);
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "absent");
    await fs.appendFile(
      f.transcriptFile,
      JSON.stringify({
        type: "user",
        uuid: userId,
        parentUuid: assistantId,
        message: { content: "Continue\n[Relay continuation: r1]" },
      }) + "\n",
    );
    assert.equal(f.evidence.unchanged(stops[0]), false);
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "accepted");
    await fs.appendFile(
      f.transcriptFile,
      JSON.stringify({
        type: "assistant",
        uuid: nextAssistant,
        parentUuid: userId,
        message: {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "started");
    // The conversation no longer ends at its limit.
    assert.equal(
      (await f.evidence.quotaStops(f.store.account(f.source.id))).length,
      0,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("a quota stop followed by background-task notifications is a quiet stop, and its continuation is verified", async () => {
  const f = await recentFixture();
  try {
    const account = f.store.account(f.source.id);
    const append = (...rows: unknown[]) =>
      fs.appendFile(
        f.transcriptFile,
        rows.map((row) => JSON.stringify(row) + "\n").join(""),
      );
    // Scanned once before the notifications, as polling does.
    assert.equal((await f.evidence.quotaStops(account)).length, 1);
    await append(
      { type: "queue-operation", operation: "enqueue" },
      notice(noticeA, assistantId),
      { type: "queue-operation", operation: "dequeue" },
      notice(noticeB, noticeA),
    );
    const stops = await f.evidence.quotaStops(account);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].turnId, assistantId);
    assert.equal(stops[0].stoppedAt, Date.parse(terminal.timestamp));
    assert.equal(
      stops[0].transcriptBytes,
      (await fs.stat(f.transcriptFile)).size,
    );
    assert.equal(f.evidence.unchanged(stops[0]), true);
    // Neither the fleet's check nor the open conversation's sees work running.
    assert.equal(await f.evidence.quietExcept([]), undefined);
    const state = await f.evidence.read(f.ui);
    assert.equal(state.quotaStop?.turnId, assistantId);
    assert.equal(state.quiescence.busyWorkers, 0);
    // With quota, a notification after a finished turn is work running.
    const other = path.join(path.dirname(f.transcriptFile), `${userId}.jsonl`);
    await fs.writeFile(
      other,
      [
        {
          type: "assistant",
          uuid: nextAssistant,
          message: { content: "done", stop_reason: "end_turn" },
        },
        notice(noticeA, nextAssistant),
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join(""),
    );
    assert.equal(
      await f.evidence.quietExcept(stops),
      "not-quiescent:busyWorkers",
    );
    await fs.rm(other);
    // After the switch, Claude writes its synthetic reply, then the prompt.
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "absent");
    const filler = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0";
    await append(
      {
        type: "assistant",
        uuid: filler,
        parentUuid: noticeB,
        isApiErrorMessage: false,
        message: {
          model: "<synthetic>",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "No response requested." }],
        },
      },
      {
        type: "user",
        uuid: userId,
        parentUuid: filler,
        origin: { kind: "human" },
        message: { content: "Continue\n[Relay continuation: r1]" },
      },
    );
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "accepted");
    await append({
      type: "assistant",
      uuid: nextAssistant,
      parentUuid: userId,
      message: {
        model: "claude-opus-5-5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      },
    });
    assert.equal(await f.evidence.deliveryAfter(stops[0], "r1"), "started");
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("Claude's own rows after a stop, as it quits and opens again, leave the stop unchanged; a prompt does not", async () => {
  const f = await recentFixture();
  try {
    const account = f.store.account(f.source.id);
    const append = (...rows: unknown[]) =>
      fs.appendFile(
        f.transcriptFile,
        rows.map((row) => JSON.stringify(row) + "\n").join(""),
      );
    const [stop] = await f.evidence.quotaStops(account);
    // Seen in real transcripts after a switch: bookkeeping rows, a background task's notice
    // queued and written to the transcript only, titles and modes.
    await append(
      { type: "last-prompt", lastPrompt: "x" },
      { type: "cost-state", cost: 1 },
      {
        type: "queue-operation",
        operation: "enqueue",
        content: "<task-notification>\n<task-id>t1</task-id>",
      },
      { type: "queue-operation", operation: "dequeue" },
      { ...notice(noticeA, assistantId), queueTranscriptOnly: true },
      { type: "custom-title", customTitle: "t" },
      { type: "isolation-latch" },
      { type: "system", subtype: "stop_hook_summary" },
    );
    assert.equal(f.evidence.unchanged(stop), true);
    // The stop is still the conversation's latest turn, and nothing reads as running.
    assert.equal((await f.evidence.quotaStops(account))[0].turnId, stop.turnId);
    assert.equal(await f.evidence.quietExcept([]), undefined);
    // A prompt queued to be sent, or one sent, is the conversation moving on.
    const queued = structuredClone(stop);
    await append({
      type: "queue-operation",
      operation: "enqueue",
      content: "carry on",
    });
    assert.equal(f.evidence.unchanged(queued), false);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("the rows that move a stopped conversation on", () => {
  const prompt = { type: "user", message: { content: "go" } };
  for (const [rows, expected] of [
    [[prompt], true],
    [[{ type: "assistant", message: { content: [] } }], true],
    // A stopped command's notification, answered by the limit again (seen live 2026-10-26).
    [
      [
        { type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>" } },
        {
          type: "assistant",
          isApiErrorMessage: true,
          error: "rate_limit",
          message: { content: [{ type: "text", text: "You've hit your session limit" }] },
        },
      ],
      false,
    ],
    [[{ type: "assistant", isApiErrorMessage: true, error: "overloaded", message: { content: [] } }], true],
    [[{ type: "attachment", attachment: { type: "queued_command" } }], true],
    [[{ type: "queue-operation", operation: "enqueue", content: [{ type: "image" }] }], true],
    [[{ ...prompt, isSidechain: true }], false],
    [[{ ...prompt, isMeta: true }], false],
    [[{ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>" } }], false],
    [[{ type: "attachment", attachment: { type: "todo_reminder" } }], false],
    [[{ type: "queue-operation", operation: "remove" }], false],
    [[], false],
  ] as const)
    assert.equal(movedOn([...rows] as never[]), expected, JSON.stringify(rows));
});
test("a notice written to the transcript only starts no turn, so it hides no finished turn", () => {
  const finished = {
    type: "assistant",
    uuid: "a",
    message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
  };
  const notice = {
    type: "user",
    origin: { kind: "task-notification" },
    queueTranscriptOnly: true,
    message: { content: "<task-notification>\n<task-id>t</task-id>" },
  };
  assert.equal(transcriptTurnState([finished, notice]), "idle");
  // One that is sent to the model starts a turn, as before.
  const { queueTranscriptOnly: _, ...sent } = notice;
  assert.equal(transcriptTurnState([finished, sent]), "busy");
});
test("quota-stop polling follows a growing transcript and refuses a malformed one", async () => {
  const f = await fixture();
  try {
    const metadataFile = path.join(
      f.root,
      "desktop",
      "claude-code-sessions",
      f.source.id,
      f.org,
      `local_${uuid}.json`,
    );
    const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
    metadata.lastActivityAt = Date.parse("2026-10-13T14:00:00.000Z");
    await fs.writeFile(metadataFile, JSON.stringify(metadata));
    const account = f.store.account(f.source.id);
    const append = (row: unknown) =>
      fs.appendFile(f.transcriptFile, JSON.stringify(row) + "\n");
    assert.equal((await f.evidence.quotaStops(account)).length, 1);
    // Agent and meta rows after the stop do not end the main chain's turn.
    await append({ type: "assistant", uuid: nextAssistant, isSidechain: true });
    await append({ type: "user", uuid: userId, isMeta: true });
    const [stop] = await f.evidence.quotaStops(account);
    assert.equal(stop.turnId, assistantId);
    assert.equal(stop.transcriptBytes, (await fs.stat(f.transcriptFile)).size);
    assert.equal(f.evidence.unchanged(stop), true);
    // A line still being written hides the conversation until it is complete.
    await fs.appendFile(f.transcriptFile, '{"type":"summary"');
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
    await fs.appendFile(f.transcriptFile, "}\n");
    assert.equal((await f.evidence.quotaStops(account)).length, 1);
    // A malformed line makes the transcript unusable, also after more rows.
    await fs.appendFile(f.transcriptFile, "{not json\n");
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
    await append({ ...terminal, uuid: nextAssistant });
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

/** The fixture with its conversation active within the quota-stop window. */
async function recentFixture() {
  const f = await fixture();
  const metadataFile = path.join(
    f.root,
    "desktop",
    "claude-code-sessions",
    f.source.id,
    f.org,
    `local_${uuid}.json`,
  );
  const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
  metadata.lastActivityAt = Date.parse("2026-10-13T14:00:00.000Z");
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  return f;
}
test("a known conversation's project folder is looked up alone, without listing every folder", async () => {
  const f = await recentFixture();
  const projects = path.join(f.root, "transcripts", "projects");
  try {
    const account = f.store.account(f.source.id);
    assert.equal((await f.evidence.quotaStops(account)).length, 1);
    // The project list cannot be read now; the folder found before still can.
    await fs.chmod(projects, 0o333);
    const [stop] = await f.evidence.quotaStops(account);
    assert.equal(stop?.transcriptRelative, `projects/-test/${uuid}.jsonl`);
  } finally {
    await fs.chmod(projects, 0o755);
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
test("a conversation no folder holds is probed again only after a minute", async () => {
  const f = await recentFixture();
  const aside = `${f.transcriptFile}.aside`;
  try {
    const account = f.store.account(f.source.id);
    await fs.rename(f.transcriptFile, aside);
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
    await fs.rename(aside, f.transcriptFile);
    f.ui.observedAt += 30_000;
    assert.equal((await f.evidence.quotaStops(account)).length, 0);
    f.ui.observedAt += 30_000;
    assert.equal((await f.evidence.quotaStops(account)).length, 1);
    // A folder that lost the transcript is forgotten and probed again.
    await fs.mkdir(path.join(f.root, "transcripts", "projects", "-moved"));
    await fs.rename(
      f.transcriptFile,
      path.join(f.root, "transcripts", "projects", "-moved", `${uuid}.jsonl`),
    );
    const [moved] = await f.evidence.quotaStops(account);
    assert.equal(moved?.transcriptRelative, `projects/-moved/${uuid}.jsonl`);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("the periodic CPU sample is read asynchronously; only the switch-time guards read synchronously", async () => {
  const f = await recentFixture();
  try {
    const stops = await f.evidence.quotaStops(f.store.account(f.source.id));
    let release!: (times: string) => void;
    const evidence = new NativeDesktopContinuationEvidence({
      store: f.store,
      desktop: {} as DesktopManager,
      automation: {} as DesktopAutomation,
      claudeRoot: path.join(f.root, "desktop"),
      transcriptRoot: path.join(f.root, "transcripts"),
      processes: async () => roster(),
      cpuTimes: () => new Promise<string>((resolve) => (release = resolve)),
      now: () => f.ui.observedAt,
    });
    let settled = false;
    const quiet = evidence.quietExcept(stops).finally(() => (settled = true));
    // ps is still running, and the main process goes on meanwhile.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release("456 0:01.00\n");
    assert.equal(await quiet, undefined);
    const source = await fs.readFile(
      new URL(
        "../electron/core/desktop-continuation-evidence.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const body = (start: string) => {
      const at = source.indexOf(start);
      assert.ok(at >= 0, start);
      return source.slice(at, source.indexOf("\n  }\n", at));
    };
    for (const periodic of [
      "private async activePids(",
      "private async measure(",
      "async quietExcept(",
      "async read(",
    ])
      assert.doesNotMatch(body(periodic), /Sync\(/, periodic);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

const engineShell = (pid: number, ppid: number, command: string): DesktopProcess => ({
  pid,
  ppid,
  executable: "/bin/zsh",
  args: `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1-ab.sh 2>/dev/null || true && eval '${command}'`,
});
const devServer = [
  engineShell(600, 457, "npm run dev"),
  { pid: 601, ppid: 600, executable: "/usr/local/bin/node", args: "node vite" },
  { pid: 602, ppid: 601, executable: "/x/esbuild", args: "esbuild --service" },
];

test("a command an engine runs in its own shell is a background command; MCP servers and other shells are not", () => {
  const commands = engineCommands(
    [
      app,
      sourceEngine,
      { pid: 510, ppid: 457, executable: "/usr/local/bin/node", args: "node playwright-mcp" },
      ...devServer,
      // A shell under Claude but not under an engine, and a Terminal one outside Claude.
      engineShell(700, 456, "ls"),
      engineShell(800, 1, "ls"),
    ],
    456,
  );
  assert.deepEqual(commands, [
    { pid: 600, pids: [600, 601, 602], names: ["node", "esbuild"] },
  ]);
});

test("lsof's field output gives each process's listening ports", () => {
  const ports = parseListeningPorts("p601\nn*:5173\nn[::1]:5173\np700\nn127.0.0.1:3000\nnbad\n");
  assert.deepEqual([...ports], [
    [601, [5173]],
    [700, [3000]],
  ]);
});

test("background commands are weighed apart from other work: servers by their ports, builds by their CPU", async () => {
  const f = await fixture();
  try {
    let clock = Date.parse("2026-10-13T15:00:00.000Z");
    let cpu = "601 0:01.00\n";
    const build = [
      engineShell(650, 457, "docker build ."),
      { pid: 651, ppid: 650, executable: "/usr/local/bin/docker", args: "docker build ." },
    ];
    const evidence = new NativeDesktopContinuationEvidence({
      store: f.store,
      desktop: {} as DesktopManager,
      automation: {} as DesktopAutomation,
      claudeRoot: path.join(f.root, "desktop"),
      transcriptRoot: path.join(f.root, "transcripts"),
      processes: async () => roster(sourceEngine, ...devServer, ...build),
      cpuTimes: () => cpu,
      listeningPorts: async (pids) => {
        assert.deepEqual(pids, [600, 601, 602, 650, 651]);
        return new Map([[601, [5173]]]);
      },
      now: () => clock,
    });
    // Busy CPU in them is not unknown work: the fleet weighs them itself.
    assert.equal(await evidence.quietExcept([]), undefined);
    const first = evidence.backgroundCommands();
    assert.deepEqual(
      first.map((c) => [c.pid, c.ports, c.activeAt === clock]),
      [
        [600, [5173], true],
        // Without a CPU sample to compare with, a command counts as working.
        [650, [], true],
      ],
    );
    // 10 s later the build used CPU and the server did not.
    const seen = clock;
    clock += 10_000;
    cpu = "601 0:01.00\n651 0:05.00\n";
    await evidence.quietExcept([]);
    clock += 10_000;
    cpu = "601 0:01.10\n651 0:09.00\n";
    await evidence.quietExcept([]);
    const later = evidence.backgroundCommands();
    assert.equal(later[0].seenAt, seen);
    assert.equal(later[0].activeAt, seen);
    assert.equal(later[1].activeAt, clock);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test("stopping background commands ends their process groups, kills what stays, and refuses an unexpected one", async () => {
  const f = await fixture();
  try {
    const signals: [number, string | number][] = [];
    const alive = new Set([600, 601, 602]);
    let stubborn = true;
    const evidence = new NativeDesktopContinuationEvidence({
      store: f.store,
      desktop: {} as DesktopManager,
      automation: {} as DesktopAutomation,
      claudeRoot: path.join(f.root, "desktop"),
      transcriptRoot: path.join(f.root, "transcripts"),
      processes: async () => roster(sourceEngine, ...devServer),
      signal: (pid, signal) => {
        signals.push([pid, signal]);
        if (signal === 0) return alive.has(pid);
        if (signal === "SIGTERM") {
          alive.delete(600);
          alive.delete(601);
        }
        if (signal === "SIGKILL") stubborn = false;
        if (!stubborn) alive.clear();
        return pid < 0 || alive.has(pid);
      },
      sleep: async () => {},
    });
    // A command the fleet did not weigh: nothing is stopped.
    assert.deepEqual(await evidence.stopBackground(new Set([999])), {
      stopped: [],
      left: 0,
      unexpected: 1,
    });
    assert.equal(signals.length, 0);
    // esbuild ignores TERM: it is killed.
    assert.deepEqual(await evidence.stopBackground(new Set([600])), {
      stopped: ["node", "esbuild"],
      left: 0,
      unexpected: 0,
    });
    assert.deepEqual(signals.slice(0, 4), [
      [-600, "SIGTERM"],
      [600, "SIGTERM"],
      [601, "SIGTERM"],
      [602, "SIGTERM"],
    ]);
    assert.ok(signals.some(([pid, s]) => pid === -600 && s === "SIGKILL"));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
