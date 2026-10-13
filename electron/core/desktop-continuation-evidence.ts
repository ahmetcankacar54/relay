import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readObject, readBytes, scopePath } from "./desktop-files";
import type { Store } from "./store";
import type { DesktopManager } from "./desktop";
import {
  privateJournalDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./continuation-journal";
import type {
  ContinuationCheckpoint,
  ContinuationDelivery,
  ContinuationIdentity,
  ContinuationReceipt,
  ContinuationSession,
} from "./continuation";
import {
  DesktopAutomationError,
  type DesktopAutomation,
  type DesktopAutomationSnapshot,
  type DesktopContinuationEvidence,
  type DesktopContinuationObservation,
} from "./desktop-continuation-host";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST = /^[A-Za-z0-9._:-]{1,128}$/;
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
type Row = Record<string, any>;
export interface DesktopProcess {
  pid: number;
  ppid: number;
  executable: string;
  args: string;
}

/** Native installs use a version filename; npm installs can run under Node. */
export function isDesktopClaudeEngine(process: DesktopProcess): boolean {
  const executable = process.executable.replaceAll("\\", "/");
  if (
    /(?:^|\/)claude(?:-code)?(?:\.exe)?$/i.test(executable) ||
    /\/claude-code\//i.test(executable) ||
    /\/(?:\.local\/share\/claude\/versions|\.claude\/local)\/[^/]+$/i.test(
      executable,
    )
  )
    return true;
  // Restrict argument-based recognition to JS runtimes. A shell's task prompt or
  // an unrelated process mentioning a package path must not masquerade as the
  // one permitted source engine.
  if (!/(?:^|\/)(?:node|nodejs|bun)(?:\.exe)?$/i.test(executable)) return false;
  const entryPrefix = process.args.replaceAll("\\", "/").split(/\s+--/)[0];
  if (entryPrefix.includes("/node_modules/@anthropic-ai/claude-code/"))
    return true;
  return /(?:^|\s)\/(?:[^\s]*\/)?claude(?:-code)?(?:\.(?:js|cjs|mjs))?(?=\s|$)/i.test(
    entryPrefix,
  );
}

/** Parse two OS snapshots rather than splitting executable paths on spaces. */
export function combineDesktopProcesses(
  commands: string,
  arguments_: string,
): string {
  const args = new Map<number, string>();
  for (const line of arguments_.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) args.set(Number(m[1]), m[2]);
  }
  const processes = commands
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!m)
        throw new DesktopAutomationError("desktop-observation-incomplete");
      const pid = Number(m[1]);
      return {
        pid,
        ppid: Number(m[2]),
        executable: m[3],
        args: args.get(pid) ?? "",
      };
    });
  return JSON.stringify(processes);
}
async function collectProcesses() {
  const [commands, arguments_] = await Promise.all([
    exec("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
    }),
    exec("/bin/ps", ["-axo", "pid=,args="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
    }),
  ]);
  return combineDesktopProcesses(commands.stdout, arguments_.stdout);
}
function collectProcessesSync() {
  return combineDesktopProcesses(
    execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
      encoding: "utf8",
    }),
    execFileSync("/bin/ps", ["-axo", "pid=,args="], {
      timeout: 3000,
      maxBuffer: 2_097_152,
      encoding: "utf8",
    }),
  );
}

export function desktopProcessQuiescence(
  raw: string,
  appPid: number,
  sessionId: string,
  selectedStopped: boolean,
) {
  const result = {
    coverage: "unknown" as "unknown" | "guarded-local",
    busyWorkers: 0,
    subagents: 0,
    pendingTasks: 0,
    waiting: 0,
    queuedPrompts: 0,
    scheduledWakeups: 0,
    unknownWork: 0,
  };
  let rows: DesktopProcess[];
  try {
    const input = JSON.parse(raw);
    if (!Array.isArray(input) || input.length > 100_000) throw 0;
    rows = input;
    const seen = new Set<number>();
    for (const r of rows) {
      if (
        !Number.isSafeInteger(r.pid) ||
        r.pid <= 0 ||
        !Number.isSafeInteger(r.ppid) ||
        r.ppid < 0 ||
        seen.has(r.pid) ||
        typeof r.executable !== "string" ||
        typeof r.args !== "string"
      )
        throw 0;
      seen.add(r.pid);
    }
    if (!rows.some((r) => r.pid === appPid)) throw 0;
  } catch {
    result.unknownWork = 1;
    return result;
  }
  const app = rows.find((r) => r.pid === appPid)!;
  if (!/\/Claude\.app\/Contents\/MacOS\/Claude$/.test(app.executable)) {
    result.unknownWork = 1;
    return result;
  }
  const bundle = app.executable.slice(0, app.executable.indexOf(".app/") + 5);
  const descendants = new Set<number>([appPid]);
  let prior = -1;
  while (prior !== descendants.size) {
    prior = descendants.size;
    for (const row of rows)
      if (descendants.has(row.ppid)) descendants.add(row.pid);
  }
  let allowedSource = 0;
  for (const row of rows) {
    if (row.pid === appPid) continue;
    const engine = isDesktopClaudeEngine(row);
    const descendant = descendants.has(row.pid);
    if (!engine && !descendant) continue;
    const chromium =
      row.executable.startsWith(`${bundle}Contents/Frameworks/Claude Helper`) &&
      /\.app\/Contents\/MacOS\/Claude Helper(?: \((?:Renderer|GPU|Plugin)\))?$/.test(
        row.executable,
      );
    if (chromium && !engine) continue;
    // Exactly one exhausted source engine is permitted. Its child tools/shells
    // are separate descendants and must still be absent. Unknown engines block.
    const resume = /(?:^|\s)--resume(?:\s+|=)([0-9a-f-]{36})(?=\s|$)/i.exec(
      row.args,
    )?.[1];
    if (
      engine &&
      descendant &&
      selectedStopped &&
      resume?.toLowerCase() === sessionId.toLowerCase() &&
      ++allowedSource === 1
    )
      continue;
    if (engine) result.busyWorkers++;
    else result.unknownWork++;
  }
  result.coverage = "guarded-local";
  return result;
}

interface CheckpointRecord {
  version: 1;
  requestId: string;
  checkpoint: ContinuationCheckpoint;
  source: ContinuationIdentity;
  target?: ContinuationIdentity;
  localSessionId: string;
  transcriptRelative: string;
  transcriptBytes: number;
  transcriptSha256: string;
  createdAt: number;
}
export interface DesktopEvidenceOptions {
  store: Store;
  desktop: DesktopManager;
  automation: DesktopAutomation;
  claudeRoot: string;
  transcriptRoot: string;
  processes?: () => Promise<string>;
  processesSync?: () => string;
  now?: () => number;
}
export function transcriptMessageText(row: Row) {
  const content = row.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
export function parseDesktopTranscript(data: Buffer) {
  if (
    data.length > 64 * 1024 * 1024 ||
    (data.length && data[data.length - 1] !== 10)
  )
    throw new DesktopAutomationError("desktop-observation-incomplete");
  const rows: Row[] = [];
  for (const line of data.toString("utf8").split("\n")) {
    if (!line) continue;
    if (line.length > 2_097_152)
      throw new DesktopAutomationError("desktop-observation-incomplete");
    let row: Row;
    try {
      row = JSON.parse(line);
    } catch {
      throw new DesktopAutomationError("desktop-observation-incomplete");
    }
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new DesktopAutomationError("desktop-observation-incomplete");
    rows.push(row);
  }
  return rows;
}
/** Use the same persisted error forms for stop detection and delivery receipts. */
function transcriptError(row: Row): "quota" | "other" | undefined {
  const reasons = [
    row.error,
    row.error?.type,
    row.errorType,
    row.apiError?.type,
    row.message?.stop_reason,
  ];
  if (
    reasons.some((reason) =>
      ["rate_limit", "rate_limit_error", "rate-limit", "usage_limit"].includes(
        reason,
      ),
    )
  )
    return "quota";
  if (
    row.isApiErrorMessage === true ||
    row.error ||
    row.errorType ||
    row.apiError
  )
    return "other";
  return undefined;
}

export function latestQuotaEndedTurn(rows: Row[]) {
  const turns = rows.filter(
    (r) =>
      !r.isSidechain && !r.isMeta && ["user", "assistant"].includes(r.type),
  );
  const tail = turns.at(-1);
  if (!tail || tail.type !== "assistant" || !UUID.test(tail.uuid ?? "")) return;
  if (transcriptError(tail) !== "quota") return;
  return {
    turnId: tail.uuid as string,
    timestamp: Date.parse(tail.timestamp ?? ""),
  };
}

export function continuationTurn(rows: Row[], requestId?: string) {
  const users = rows.filter(
    (r) =>
      r.type === "user" &&
      !r.isMeta &&
      !r.isSidechain &&
      transcriptMessageText(r),
  );
  const user = users.at(-1);
  if (!user || !UUID.test(user.uuid ?? "")) return;
  const marker = /\[Relay continuation: ([A-Za-z0-9._:-]{1,128})\]\s*$/.exec(
    transcriptMessageText(user),
  );
  if (!marker || (requestId && marker[1] !== requestId)) return;
  const turns = rows.filter(
    (r) =>
      ["user", "assistant"].includes(r.type) && !r.isMeta && !r.isSidechain,
  );
  const tail = turns.at(-1);
  if (!tail || tail.type !== "assistant" || !UUID.test(tail.uuid ?? ""))
    return { requestId: marker[1], user };
  // A persisted API error acknowledges the user input, not productive resumed
  // work. In particular a second quota failure must never report "continued".
  if (transcriptError(tail)) return { requestId: marker[1], user };
  const byId = new Map(
    rows.filter((r) => UUID.test(r.uuid ?? "")).map((r) => [r.uuid, r]),
  );
  let cursor: Row | undefined = tail;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.uuid)) {
    if (cursor.uuid === user.uuid)
      return { requestId: marker[1], user, assistant: tail };
    seen.add(cursor.uuid);
    cursor = byId.get(cursor.parentUuid);
  }
  return;
}

export class NativeDesktopContinuationEvidence implements DesktopContinuationEvidence {
  private readonly recordsRoot: string;
  private readonly now: () => number;
  private revision = 0;
  private signature = "";
  private last?: DesktopContinuationObservation;
  constructor(private readonly options: DesktopEvidenceOptions) {
    this.recordsRoot = path.join(
      options.store.root,
      "continuation-checkpoints",
    );
    this.now = options.now ?? Date.now;
    privateJournalDirectory(this.recordsRoot);
  }
  private async transcript(cliId: string, cwd: string) {
    const folders = await fs.readdir(
      path.join(this.options.transcriptRoot, "projects"),
      { withFileTypes: true },
    );
    const found: { relative: string; data: Buffer; rows: Row[] }[] = [];
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const relative = `projects/${folder.name}/${cliId}.jsonl`;
      const data = await readBytes(this.options.transcriptRoot, relative);
      if (!data) continue;
      const rows = parseDesktopTranscript(data);
      const paths = rows
        .filter((row) => typeof row.cwd === "string")
        .map((row) => path.resolve(row.cwd));
      if (!paths.length || paths.some((value) => value !== path.resolve(cwd)))
        throw new DesktopAutomationError("exact-session-not-observed");
      found.push({ relative, data, rows });
    }
    if (found.length !== 1)
      throw new DesktopAutomationError("exact-session-not-observed");
    return found[0];
  }
  async read(
    snapshot: DesktopAutomationSnapshot,
  ): Promise<DesktopContinuationObservation> {
    const desktop = await this.options.desktop.snapshot();
    if (
      !snapshot.localSessionId ||
      !desktop.currentAccountUuid ||
      desktop.recoveryRequired ||
      desktop.pendingProfileId
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    const aliases = this.options.store.state.accounts.filter(
      (account) =>
        account.desktop?.accountUuid.toLowerCase() ===
        desktop.currentAccountUuid!.toLowerCase(),
    );
    const matches = [];
    for (const account of aliases) {
      const metadata = await readObject(
        this.options.claudeRoot,
        `${scopePath("claude-code-sessions", account.desktop!)}/${snapshot.localSessionId}.json`,
      );
      if (metadata) matches.push({ account, metadata });
    }
    if (matches.length !== 1)
      throw new DesktopAutomationError("exact-session-not-observed");
    const { account, metadata } = matches[0];
    const scopes = desktop.organizations ?? [];
    const organizationLabel = account.auth?.orgName
      ?.trim()
      .normalize("NFC")
      .toLocaleLowerCase();
    const uiLabel = snapshot.accountLabel
      ?.trim()
      .normalize("NFC")
      .toLocaleLowerCase();
    const uniqueScope =
      scopes.length === 1 &&
      scopes[0].toLowerCase() === account.desktop!.orgId.toLowerCase();
    const labeledScope =
      organizationLabel &&
      uiLabel &&
      uiLabel.endsWith(organizationLabel) &&
      scopes.includes(account.desktop!.orgId);
    if (!uniqueScope && !labeledScope)
      throw new DesktopAutomationError("desktop-observation-incomplete");
    if (
      !UUID.test(metadata.cliSessionId ?? "") ||
      typeof metadata.cwd !== "string" ||
      !path.isAbsolute(metadata.cwd) ||
      metadata.archived ||
      metadata.isArchived ||
      !snapshot.permissionMode
    )
      throw new DesktopAutomationError("exact-session-not-observed");
    const transcript = await this.transcript(
      metadata.cliSessionId,
      metadata.cwd,
    );
    const tail = transcript.rows
      .filter(
        (r) =>
          ["user", "assistant"].includes(r.type) && !r.isMeta && !r.isSidechain,
      )
      .at(-1);
    const ended = latestQuotaEndedTurn(transcript.rows);
    const continuation = continuationTurn(transcript.rows);
    const now = this.now();
    const freshEnd =
      snapshot.quotaStopped &&
      snapshot.status === "stopped" &&
      ended &&
      Number.isFinite(ended.timestamp) &&
      ended.timestamp <= now;
    const selectedEnded =
      snapshot.status === "stopped" &&
      tail?.type === "assistant" &&
      (Boolean(ended) ||
        ["end_turn", "max_tokens", "stop_sequence"].includes(
          tail.message?.stop_reason,
        ));
    const quiescence = desktopProcessQuiescence(
      await (this.options.processes ?? collectProcesses)(),
      snapshot.pid,
      metadata.cliSessionId,
      selectedEnded,
    );
    if (
      metadata.remoteSessionId ||
      metadata.sshHost ||
      metadata.sessionType === "remote" ||
      metadata.sessionType === "ssh"
    ) {
      quiescence.coverage = "unknown";
      quiescence.unknownWork++;
    }
    if (!snapshot.composerEmpty) quiescence.queuedPrompts++;
    if (snapshot.status === "waiting") quiescence.waiting++;
    quiescence.busyWorkers += snapshot.visibleActiveTasks ?? 0;
    quiescence.waiting += snapshot.visibleWaitingTasks ?? 0;
    quiescence.scheduledWakeups +=
      (snapshot.visibleScheduledTasks ?? 0) +
      (snapshot.quotaAutoResume ? 1 : 0);
    const session: ContinuationSession = {
      id: metadata.cliSessionId.toLowerCase(),
      projectKey: path.resolve(metadata.cwd),
      transcriptRevision: sha(transcript.data),
      permissionMode: snapshot.permissionMode,
      status: snapshot.status,
      lastTurnId: UUID.test(tail?.uuid ?? "") ? tail!.uuid : undefined,
      lastRequestId: continuation?.requestId,
    };
    const identity = {
      profileId: account.id,
      accountUuid: account.desktop!.accountUuid.toLowerCase(),
      orgId: account.desktop!.orgId.toLowerCase(),
    };
    const signature = sha(
      JSON.stringify({
        identity,
        session,
        localSessionId: snapshot.localSessionId,
        ui: snapshot.contextFingerprint,
        quiescence,
      }),
    );
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
    }
    const value: DesktopContinuationObservation = {
      contextRevision: this.revision,
      observedAt: now,
      identity,
      session,
      quiescence,
      localSessionId: snapshot.localSessionId,
      ownQuotaWakeup: Boolean(
        freshEnd &&
        snapshot.quotaAutoResume &&
        quiescence.scheduledWakeups === 1,
      ),
      ...(freshEnd
        ? {
            quotaStop: {
              sessionId: session.id,
              turnId: ended!.turnId,
              observedAt: now,
              reason: "rate-limit" as const,
            },
          }
        : {}),
    };
    this.last = value;
    return structuredClone(value);
  }
  private file(requestId: string) {
    if (!REQUEST.test(requestId))
      throw new DesktopAutomationError("desktop-ui-unsupported");
    return `${requestId}.json`;
  }
  async checkpoint(input: {
    requestId: string;
    session: ContinuationSession;
    expectedContextRevision: number;
  }) {
    const current = await this.read(await this.options.automation.inspect());
    if (
      current.contextRevision !== input.expectedContextRevision ||
      current.session.id !== input.session.id ||
      current.session.transcriptRevision !== input.session.transcriptRevision
    )
      throw new DesktopAutomationError("context-changed");
    const account = this.options.store.account(current.identity.profileId);
    const metadata = await readObject(
      this.options.claudeRoot,
      `${scopePath("claude-code-sessions", account.desktop!)}/${current.localSessionId}.json`,
    );
    const transcript = await this.transcript(input.session.id, metadata!.cwd);
    const checkpoint = {
      id: input.requestId,
      session: structuredClone(input.session),
    };
    const record: CheckpointRecord = {
      version: 1,
      requestId: input.requestId,
      checkpoint,
      source: current.identity,
      localSessionId: current.localSessionId,
      transcriptRelative: transcript.relative,
      transcriptBytes: transcript.data.length,
      transcriptSha256: sha(transcript.data),
      createdAt: this.now(),
    };
    writePrivateJson(
      path.join(this.recordsRoot, this.file(input.requestId)),
      record,
    );
    return checkpoint;
  }
  async localSessionId(checkpoint: ContinuationCheckpoint) {
    const record = await this.record(checkpoint.id);
    if (
      record.checkpoint.session.id !== checkpoint.session.id ||
      record.checkpoint.session.transcriptRevision !==
        checkpoint.session.transcriptRevision
    )
      throw new DesktopAutomationError("context-changed");
    return record.localSessionId;
  }
  private async record(requestId: string): Promise<CheckpointRecord> {
    const value = readPrivateJson(
      path.join(this.recordsRoot, this.file(requestId)),
    ) as CheckpointRecord;
    if (
      !value ||
      value.version !== 1 ||
      value.requestId !== requestId ||
      !value.checkpoint ||
      !/^local_[0-9a-f-]{36}$/i.test(value.localSessionId ?? "") ||
      !Number.isSafeInteger(value.transcriptBytes) ||
      !/^[a-f0-9]{64}$/.test(value.transcriptSha256 ?? "")
    )
      throw new DesktopAutomationError("desktop-observation-incomplete");
    return value as CheckpointRecord;
  }
  async switchAccount(input: {
    requestId: string;
    target: ContinuationIdentity;
    expectedContextRevision: number;
  }) {
    const current = await this.read(await this.options.automation.inspect());
    if (
      current.contextRevision !== input.expectedContextRevision ||
      current.quiescence.coverage !== "guarded-local" ||
      Object.entries(current.quiescence).some(
        ([key, value]) => key !== "coverage" && value !== 0,
      ) ||
      !current.quotaStop
    )
      throw new DesktopAutomationError("desktop-work-active");
    const target = this.options.store.account(input.target.profileId);
    if (
      target.desktop?.accountUuid.toLowerCase() !==
        input.target.accountUuid.toLowerCase() ||
      target.desktop?.orgId.toLowerCase() !== input.target.orgId.toLowerCase()
    )
      throw new DesktopAutomationError("context-changed");
    const record = await this.record(input.requestId);
    record.target = input.target;
    writePrivateJson(
      path.join(this.recordsRoot, this.file(input.requestId)),
      record,
    );
    // DesktopManager rechecks this predicate immediately before graceful quit and
    // before each write. No frozen last-known-safe process list authorizes restart.
    const canProceed = () => {
      try {
        const raw = (this.options.processesSync ?? collectProcessesSync)();
        const parsed = JSON.parse(raw) as DesktopProcess[];
        if (!parsed.some((p) => p.pid === currentSnapshot.pid)) {
          // After graceful quit, any surviving engine/tool related to the old
          // process tree blocks the write; a newly running Claude also blocks it.
          return !parsed.some(
            (p) =>
              isDesktopClaudeEngine(p) || p.executable.includes("/Claude.app/"),
          );
        }
        const q = desktopProcessQuiescence(
          raw,
          currentSnapshot.pid,
          current.session.id,
          true,
        );
        const config = JSON.parse(
          fsSync.readFileSync(
            path.join(this.options.claudeRoot, "config.json"),
            "utf8",
          ),
        );
        const unchanged =
          sha(
            fsSync.readFileSync(
              path.join(this.options.transcriptRoot, record.transcriptRelative),
            ),
          ) === current.session.transcriptRevision;
        return (
          unchanged &&
          config.lastKnownAccountUuid?.toLowerCase() ===
            current.identity.accountUuid &&
          q.coverage === "guarded-local" &&
          Object.entries(q).every(
            ([key, value]) => key === "coverage" || value === 0,
          )
        );
      } catch {
        return false;
      }
    };
    const currentSnapshot = await this.options.automation.inspect();
    const beforeQuit = async () => {
      const fresh = await this.read(await this.options.automation.inspect());
      if (
        fresh.contextRevision !== input.expectedContextRevision ||
        fresh.identity.profileId !== current.identity.profileId ||
        fresh.session.id !== current.session.id ||
        fresh.session.transcriptRevision !==
          current.session.transcriptRevision ||
        fresh.session.permissionMode !== current.session.permissionMode ||
        fresh.session.status !== "stopped" ||
        !fresh.quotaStop ||
        fresh.quiescence.coverage !== "guarded-local" ||
        Object.entries(fresh.quiescence).some(
          ([key, value]) => key !== "coverage" && value !== 0,
        )
      )
        throw new DesktopAutomationError("desktop-work-active");
    };
    await this.options.desktop.switchTo(input.target.profileId, {
      canProceed,
      beforeQuit,
    });
    // Graceful launch is asynchronous and can land on a homepage. Establish the
    // exact target alias before the engine's post-switch identity/session read.
    let lastIssue: unknown;
    let opened = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const desktop = await this.options.desktop.snapshot();
        if (
          desktop.currentAccountUuid?.toLowerCase() !==
          input.target.accountUuid.toLowerCase()
        )
          throw new DesktopAutomationError("context-changed");
        const view = await this.options.automation.inspect();
        if (view.localSessionId !== record.localSessionId) {
          if (!opened) {
            await this.options.automation.openSession(record.localSessionId);
            opened = true;
          }
        } else {
          const targetState = await this.read(view);
          if (
            targetState.identity.profileId !== input.target.profileId ||
            targetState.session.id !== record.checkpoint.session.id ||
            targetState.session.projectKey !==
              record.checkpoint.session.projectKey ||
            targetState.session.transcriptRevision !==
              record.checkpoint.session.transcriptRevision
          )
            throw new DesktopAutomationError("exact-session-not-observed");
          return;
        }
      } catch (error) {
        lastIssue = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw lastIssue ?? new DesktopAutomationError("exact-session-not-observed");
  }
  async lookupDelivery(requestId: string): Promise<ContinuationDelivery> {
    let record: CheckpointRecord;
    try {
      record = await this.record(requestId);
    } catch {
      return { status: "unknown" };
    }
    const data = await readBytes(
      this.options.transcriptRoot,
      record.transcriptRelative,
    );
    if (
      !data ||
      data.length < record.transcriptBytes ||
      sha(data.subarray(0, record.transcriptBytes)) !== record.transcriptSha256
    )
      return { status: "unknown" };
    const appended = parseDesktopTranscript(
      data.subarray(record.transcriptBytes),
    );
    const marker = `[Relay continuation: ${requestId}]`;
    const users = appended.filter(
      (r) =>
        r.type === "user" &&
        !r.isMeta &&
        !r.isSidechain &&
        transcriptMessageText(r).includes(marker),
    );
    if (!users.length) return { status: "absent" };
    if (users.length !== 1 || !record.target || !UUID.test(users[0].uuid ?? ""))
      return { status: "unknown" };
    const state = await this.read(await this.options.automation.inspect());
    if (
      state.identity.profileId !== record.target.profileId ||
      state.identity.accountUuid !== record.target.accountUuid ||
      state.identity.orgId !== record.target.orgId ||
      state.session.id !== record.checkpoint.session.id ||
      state.session.projectKey !== record.checkpoint.session.projectKey ||
      state.session.permissionMode !==
        record.checkpoint.session.permissionMode ||
      state.localSessionId !== record.localSessionId
    )
      return { status: "unknown" };
    const turn = continuationTurn(appended, requestId);
    if (!turn || turn.user.uuid !== users[0].uuid) return { status: "unknown" };
    if (!turn.assistant) return { status: "accepted" };
    const receipt: ContinuationReceipt = {
      requestId,
      identity: record.target,
      sessionId: state.session.id,
      projectKey: state.session.projectKey,
      permissionMode: state.session.permissionMode,
      beforeRevision: record.checkpoint.session.transcriptRevision,
      afterRevision: sha(data),
      turnId: turn.assistant.uuid,
    };
    return { status: "started", receipt };
  }
}
