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
