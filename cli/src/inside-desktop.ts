import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readPrivateJson, writePrivateJson } from "../../electron/core/continuation-journal";
import { claudeExecutable } from "../../electron/core/desktop-host-node";
import { redact } from "../../electron/core/redact";
import type { CliContext } from "./context";
import type { CliDeps } from "./deps";
import { probeWritable } from "./guards";
import type { Lang } from "./i18n";
import { CliError, EXIT, type CliIO } from "./io";

/** A Claude-quitting command handed to a detached worker, and what became of it. */
export interface WorkerRecord {
  id: string;
  /** The command's arguments, without --yes and --lang. */
  argv: string[];
  lang: Lang;
  createdAt: string;
  status: "pending" | "running" | "done" | "failed";
  error?: string;
  finishedAt?: string;
  shown?: true;
}

/**
 * Whether `pid` runs inside Claude Desktop: one of its ancestors in a `ps -axo pid=,ppid=,comm=`
 * listing is a process of the Claude.app bundle `executable` belongs to.
 */
export function insideClaudeDesktop(listing: string, pid: number, executable: string): boolean {
  const bundle = executable.slice(0, executable.indexOf(".app/") + 5);
  if (!bundle.endsWith(".app/")) return false;
  const processes = new Map<number, { ppid: number; comm: string }>();
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) processes.set(Number(match[1]), { ppid: Number(match[2]), comm: match[3] });
  }
  const seen = new Set<number>();
  for (let current = processes.get(pid)?.ppid; current && !seen.has(current); ) {
    seen.add(current);
    const process = processes.get(current);
    if (!process) return false;
    if (process.comm.startsWith(bundle)) return true;
    current = process.ppid;
  }
  return false;
}

const RECORD = /^[0-9a-f-]{36}\.json$/;
const KEEP = 20;

export function writeWorkerRecord(dir: string, record: WorkerRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateJson(path.join(dir, `${record.id}.json`), record);
  const names = fs
    .readdirSync(dir)
    .filter((name) => RECORD.test(name))
    .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const old of names.slice(KEEP)) fs.rmSync(path.join(dir, old.name), { force: true });
}

export function readWorkerRecord(dir: string, id: string): WorkerRecord | undefined {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  try {
    return readPrivateJson(path.join(dir, `${id}.json`)) as WorkerRecord;
  } catch {
    return undefined;
  }
}

/** The newest record, or undefined. */
export function lastWorkerRecord(dir: string): WorkerRecord | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => RECORD.test(name));
  } catch {
    return undefined;
  }
  const records = names
    .map((name) => readWorkerRecord(dir, name.slice(0, -5)))
    .filter((r): r is WorkerRecord => !!r)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return records[0];
}

/** Whether this CLI runs inside a Claude Desktop Code session (never true in the worker). */
export async function insideDesktop(ctx: CliContext): Promise<boolean> {
  if (ctx.io.env.RELAY_WORKER === "1") return false;
  const executable = claudeExecutable(ctx.paths.claudeApps);
  if (!executable) return false;
  try {
    return insideClaudeDesktop(await ctx.deps.processList(), ctx.io.pid, executable);
  } catch {
    return false;
  }
}

/** The line the prompt adds when this terminal lives inside Claude Desktop. */
export const sessionEndsLine = (ctx: CliContext) =>
  ctx.t("Bu oturum da kapanacak.", "This session will end too.");

/** The arguments a worker re-runs: the user's, without --yes and --lang. */
function workerArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--yes" || argv[i] === "-y") continue;
    if (argv[i] === "--lang") {
      i++;
      continue;
    }
    if (argv[i].startsWith("--lang=")) continue;
    out.push(argv[i]);
  }
  return out;
}

/**
 * Hands a confirmed Claude-quitting command to a detached worker, since Claude's quit would
 * kill this process: the worker is started in its own session and outlives this one, which
 * returns at once. A sandbox that forbids writing Relay's folder refuses it first.
 */
export function detach(ctx: CliContext, argv: string[]): number {
  const { t } = ctx;
  if (!probeWritable(ctx.paths.cliOperations))
    throw new CliError(
      t(
        "Bu oturum korumalı alanda (sandbox) çalışıyor; komutu normal bir terminalden çalıştır.",
        "This session runs in a sandbox; run the command from a normal terminal.",
      ),
      EXIT.environment,
    );
  const record: WorkerRecord = {
    id: randomUUID(),
    argv: workerArgv(argv),
    lang: ctx.lang,
    createdAt: new Date(ctx.io.now()).toISOString(),
    status: "pending",
  };
  writeWorkerRecord(ctx.paths.cliOperations, record);
  startWorker(ctx.deps, ctx.io, record.id);
  ctx.io.stdout(
    t(
      "Claude uygulaması kapanınca işlem ayrı bir süreçte sürecek. Claude yeniden açılınca sonucunu relay status gösterir.",
      "The operation continues in a separate process when the Claude app quits. Once Claude reopens, relay status shows how it went.",
    ),
  );
  return EXIT.ok;
}

export function startWorker(deps: Pick<CliDeps, "spawn" | "selfPath">, io: CliIO, id: string): void {
  const child = deps.spawn(process.execPath, [deps.selfPath, "__worker", id], {
    detached: true,
    stdio: "ignore",
    env: { ...io.env, RELAY_WORKER: "1" },
  });
  child.unref();
}

/** Runs a worker's command with no terminal and records how it ended; the error is redacted. */
export async function runWorker(
  dir: string,
  id: string,
  io: CliIO,
  run: (argv: string[], io: CliIO) => Promise<number>,
): Promise<number> {
  const record = readWorkerRecord(dir, id);
  if (!record || record.status !== "pending") return EXIT.usage;
  writeWorkerRecord(dir, { ...record, status: "running" });
  const delay = Number(io.env.RELAY_WORKER_DELAY_MS ?? 1000);
  // Let the process that started this one exit first, so Claude's quit cannot reach it.
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  const errors: string[] = [];
  const silent: CliIO = {
    ...io,
    stdout: () => {},
    stderr: (line) => errors.push(line),
    isTTY: false,
    prompt: async () => undefined,
  };
  const code = await run([...record.argv, "--yes", "--lang", record.lang], silent).catch(() => EXIT.failed);
  writeWorkerRecord(dir, {
    ...record,
    status: code === EXIT.ok ? "done" : "failed",
    ...(code === EXIT.ok ? {} : { error: redact(errors.at(-1)?.replace(/^relay: /, "") ?? `exit ${code}`) }),
    finishedAt: new Date(io.now()).toISOString(),
  });
  return code;
}
