// An executable, deterministic receiver for Relay's isolated continuation lab.
// It never invokes Claude, reads real credentials, or contacts a model service.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const limit = 64 * 1024;

async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(value);
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

async function main() {
  if (process.env.RELAY_CONTINUATION_LAB !== "1")
    throw new Error("isolated-mode-required");
  const root = await fs.realpath(process.env.RELAY_LAB_ROOT ?? "");
  const marker = JSON.parse(
    await fs.readFile(path.join(root, "lab.json"), "utf8"),
  );
  if (marker.mode !== "simulated" || marker.actualClaudeControlled !== false)
    throw new Error("invalid-lab-marker");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > limit) throw new Error("input-too-large");
  }
  const command = JSON.parse(input);
  if (!["inspect", "open", "send", "lookup"].includes(command.op))
    throw new Error("invalid-command");
  const lockFile = path.join(root, "receiver-transaction.lock");
  const lock = await fs.open(lockFile, "wx", 0o600);
  try {
    const transcriptFile = path.join(root, marker.transcript);
    const desktopRoot = path.join(root, "Claude-fixture");
    const config = JSON.parse(
      await fs.readFile(path.join(desktopRoot, "config.json"), "utf8"),
    );
    const account = marker.accounts.find(
      (value) => value.accountUuid === config.lastKnownAccountUuid,
    );
    if (!account || config["oauth:tokenCacheV2"] !== `fixture:${account.label}`)
      throw new Error("synthetic-account-mismatch");
    const cookie = await fs.readFile(path.join(desktopRoot, "Cookies"), "utf8");
    if (cookie !== `fixture-cookie:${account.label}`)
      throw new Error("synthetic-cookie-mismatch");
    const recordFile = path.join(
      desktopRoot,
      "claude-code-sessions",
      account.accountUuid,
      account.orgId,
      `local_${marker.sessionId}.json`,
    );
    const record = JSON.parse(await fs.readFile(recordFile, "utf8"));
    const cwd = path.join(root, "project-fixture");
    if (
      record.cliSessionId !== marker.sessionId ||
      record.sessionId !== `local_${marker.sessionId}` ||
      record.cwd !== cwd
    )
      throw new Error("exact-session-mismatch");
    const bytes = await fs.readFile(transcriptFile);
    const messages = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      !messages.length ||
      messages.some(
        (message) =>
          message.sessionId !== marker.sessionId || message.cwd !== cwd,
      )
    )
      throw new Error("transcript-identity-mismatch");
    for (let index = 1; index < messages.length; index++)
      if (messages[index].parentUuid !== messages[index - 1].uuid)
        throw new Error("transcript-parent-chain-mismatch");
    const identity = {
      profileId: account.profileId,
      accountUuid: account.accountUuid,
      orgId: account.orgId,
    };
    const revision = hash(bytes);
    const loadedFile = path.join(root, "loaded-conversation.json");
    let loaded;
    try {
      loaded = JSON.parse(await fs.readFile(loadedFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.appendFile(
      path.join(root, "receiver-calls.jsonl"),
      JSON.stringify({ op: command.op, account: account.label }) + "\n",
      { mode: 0o600 },
    );
    if (command.op === "inspect")
      return {
        identity,
        sessionId: marker.sessionId,
        projectKey: "isolated-project",
        cwdVerified: true,
        transcriptRevision: revision,
        messages: messages.length,
        loaded:
          loaded?.accountUuid === identity.accountUuid &&
          loaded?.orgId === identity.orgId &&
          loaded?.sessionId === marker.sessionId,
        lastRequestId: messages.at(-1).requestId,
        lastTurnId:
          messages.at(-1).type === "assistant"
            ? messages.at(-1).uuid
            : undefined,
      };
    if (!uuid.test(command.requestId)) throw new Error("invalid-request-id");
    if (command.op === "open") {
      const state = JSON.parse(
        await fs.readFile(path.join(root, "receiver-state.json"), "utf8"),
      );
      if (state.contextRevision !== command.expectedContextRevision)
        throw new Error("context-revision-changed");
      if (
        command.sessionId !== marker.sessionId ||
        command.transcriptRevision !== revision
      )
        throw new Error("open-checkpoint-mismatch");
      await atomic(
        loadedFile,
        JSON.stringify({ ...identity, sessionId: marker.sessionId }),
      );
      return {
        identity,
        sessionId: marker.sessionId,
        transcriptRevision: revision,
        loaded: true,
      };
    }
    const receiptFile = path.join(
      root,
      "receiver-receipts",
      `${command.requestId}.json`,
    );
    let existing;
    try {
      existing = JSON.parse(await fs.readFile(receiptFile, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (command.op === "lookup")
      return existing
        ? { status: "started", receipt: existing }
        : { status: "absent" };
    if (existing) return { status: "started", receipt: existing };
    const state = JSON.parse(
      await fs.readFile(path.join(root, "receiver-state.json"), "utf8"),
    );
    if (
      state.contextRevision !== command.expectedContextRevision ||
      state.status !== "stopped" ||
      state.coverage !== "isolated-all" ||
      [
        "busyWorkers",
        "subagents",
        "pendingTasks",
        "waiting",
        "queuedPrompts",
        "scheduledWakeups",
        "unknownWork",
      ].some((key) => state[key] !== 0)
    )
      throw new Error("context-no-longer-quiescent");
    if (
      loaded?.accountUuid !== identity.accountUuid ||
      loaded?.orgId !== identity.orgId ||
      loaded?.sessionId !== marker.sessionId
    )
      throw new Error("target-conversation-not-loaded");
    if (
      command.identity.profileId !== identity.profileId ||
      command.identity.accountUuid !== identity.accountUuid ||
      command.identity.orgId !== identity.orgId
    )
      throw new Error("delivery-account-mismatch");
    if (
      command.session.id !== marker.sessionId ||
      command.session.projectKey !== "isolated-project" ||
      command.session.transcriptRevision !== revision ||
      command.session.permissionMode !== record.permissionMode
    )
      throw new Error("delivery-checkpoint-mismatch");
    if (
      typeof command.text !== "string" ||
      !command.text.trim() ||
      command.text.length > 8_192
    )
      throw new Error("invalid-continuation-message");
    const previous = messages.at(-1);
    if (previous.type !== "assistant" || !Number.isInteger(previous.labStep))
      throw new Error("checkpoint-progress-missing");
    const step = previous.labStep + 1;
    const userId = randomUUID(),
      turnId = randomUUID();
    const user = {
      type: "user",
      uuid: userId,
      parentUuid: previous.uuid,
      sessionId: marker.sessionId,
      cwd,
      message: { role: "user", content: command.text },
      requestId: command.requestId,
    };
    const assistant = {
      type: "assistant",
      uuid: turnId,
      parentUuid: userId,
      sessionId: marker.sessionId,
      cwd,
      message: { role: "assistant", content: `LAB_STEP_${step}_OK` },
      labStep: step,
      accountLabel: account.label,
      requestId: command.requestId,
    };
    const next = Buffer.concat([
      bytes,
      Buffer.from(
        JSON.stringify(user) + "\n" + JSON.stringify(assistant) + "\n",
      ),
    ]);
    await atomic(
      path.join(cwd, "progress.json"),
      JSON.stringify({
        sessionId: marker.sessionId,
        completedStep: step,
        lastTurnId: turnId,
      }),
    );
    await atomic(transcriptFile, next);
    if (command.fault === "crash-before-receipt") process.exit(86);
    await atomic(
      recordFile,
      JSON.stringify({
        ...record,
        lastActivityAt: marker.clock + step,
        labStep: step,
      }),
    );
    const receipt = {
      requestId: command.requestId,
      identity,
      sessionId: marker.sessionId,
      projectKey: "isolated-project",
      permissionMode: record.permissionMode,
      beforeRevision: revision,
      afterRevision: hash(next),
      turnId,
    };
    await atomic(receiptFile, JSON.stringify(receipt));
    return { status: "started", receipt };
  } finally {
    await lock.close();
    await fs.rm(lockFile, { force: true });
  }
}

try {
  process.stdout.write(JSON.stringify(await main()) + "\n");
} catch {
  // Input may contain project paths or prompt text. Never echo it on failure.
  process.stderr.write("Isolated receiver rejected the operation.\n");
  process.exitCode = 2;
}
