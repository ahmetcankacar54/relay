import fs from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import {
  observeLiveSessions,
  type LiveObservationIssue,
  type LiveSessionObservation,
} from "../shared/live-session-observation";

const MAX_SNAPSHOT_BYTES = 1_048_576;
const identifier = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const expectedSession = z
  .object({ scopeId: identifier, sessionId: uuid })
  .strict();
// Adapter envelopes are exact. Official roster row metadata is allowed to
// evolve; the observer validates execution fields and discards private content.
const snapshotSchema = z
  .object({
    rosters: z
      .array(
        z
          .object({
            scopeId: identifier,
            collectedAt: timestamp,
            includeCompleted: z.boolean(),
            rows: z.array(z.unknown()).max(5_000),
          })
          .strict(),
      )
      .max(50),
    expectedScopeIds: z.array(identifier).max(50),
    expectedSessions: z.array(expectedSession).max(5_000).optional(),
    children: z
      .array(
        expectedSession.extend({
          collectedAt: timestamp,
          complete: z.boolean(),
          tasks: z.array(z.unknown()).max(5_000),
        }),
      )
      .max(5_000)
      .optional(),
  })
  .strict();
const isoTime = z.iso.datetime({ offset: true }).refine((value) => {
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0;
});
const malformedCodes = new Set<LiveObservationIssue["code"]>([
  "invalid-input",
  "invalid-clock",
  "invalid-scope",
  "duplicate-scope",
  "invalid-roster",
  "invalid-row",
  "conflicting-state",
  "duplicate-session",
  "invalid-expected-session",
  "invalid-child-snapshot",
  "duplicate-child-snapshot",
  "invalid-child-task",
]);
const help = `Usage: node --import tsx scripts/live-preflight.ts SNAPSHOT.json [--now ISO] [--json]

Offline diagnostics for an explicitly supplied JSON snapshot only.
The command never runs Claude, reads user configuration or credentials,
installs hooks, changes Desktop accounts, or sends a continuation message.
Snapshots must be regular files of at most 1 MiB. --now sets the fixture clock.
`;
class InputError extends Error {}

function argumentsFor(args: string[]) {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))
    return { help: true } as const;
  let file: string | undefined;
  let now: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--json" && !json) json = true;
    else if (argument === "--now" && now === undefined) {
      const value = args[++index];
      if (!value || value.length > 100 || !isoTime.safeParse(value).success)
        throw new InputError(
          "--now requires a valid ISO timestamp with a time zone.",
        );
      now = Date.parse(value);
    } else if (!argument.startsWith("-") && !file) file = argument;
    else
      throw new InputError(
        "Invalid arguments. Use --help for the command format.",
      );
  }
  if (!file || file.length > 4_096 || file.includes("\0"))
    throw new InputError(
      "Provide exactly one snapshot JSON file. Use --help for details.",
    );
  return { help: false, file, now: now ?? Date.now(), json } as const;
}

async function readSnapshot(file: string): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const before = await fs.lstat(file);
    if (!before.isFile() || before.isSymbolicLink())
      throw new InputError(
        "The snapshot must be a regular file, not a symbolic link.",
      );
    if (before.size > MAX_SNAPSHOT_BYTES)
      throw new InputError("The snapshot exceeds the 1 MiB input limit.");
    handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      throw new InputError(
        "The snapshot file changed before it could be read.",
      );
    if (opened.size > MAX_SNAPSHOT_BYTES)
      throw new InputError("The snapshot exceeds the 1 MiB input limit.");
    // Bound the actual read as well as the initial stat, even if another writer
    // grows the explicitly supplied file while diagnostics are running.
    const bytes = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_SNAPSHOT_BYTES)
      throw new InputError("The snapshot exceeds the 1 MiB input limit.");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } catch {
      throw new InputError("The snapshot must contain valid UTF-8 JSON.");
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    // Do not echo filesystem paths, parser context or arbitrary error content.
    throw new InputError("The snapshot file could not be read.");
  } finally {
    await handle?.close();
  }
}

function reportFor(observation: LiveSessionObservation) {
  const issues = new Map<LiveObservationIssue["code"], number>();
  for (const issue of observation.issues)
    issues.set(issue.code, (issues.get(issue.code) ?? 0) + 1);
  return {
    mode: "offline-diagnostics" as const,
    observedAt: new Date(observation.observedAt).toISOString(),
    rosterActivity: observation.rosterActivity,
    sessions: observation.sessions.length,
    tasks: observation.tasks.length,
    sessionCounts: observation.counts,
    taskCounts: observation.taskCounts,
    coverage: observation.coverage,
    capabilities: observation.capabilities,
    issues: [...issues].map(([code, count]) => ({ code, count })),
    canSwitchLive: false,
    canContinueAutomatically: false,
    actionsExecuted: 0,
  };
}

function textReport(report: ReturnType<typeof reportFor>) {
  const counts = (value: typeof report.sessionCounts) =>
    Object.entries(value)
      .filter(([, count]) => count)
      .map(([activity, count]) => `${activity}=${count}`)
      .join(", ") || "none";
  return [
    "Relay live-switch preflight (offline)",
    `Observed at: ${report.observedAt}`,
    `Roster activity: ${report.rosterActivity}`,
    `Sessions: ${report.sessions} (${counts(report.sessionCounts)})`,
    `Parent tasks: ${report.tasks} (${counts(report.taskCounts)})`,
    `Declared scopes: ${report.coverage.declaredScopes}; expected sessions: ${report.coverage.expectedSessions}; parent task details: ${report.coverage.parentTaskDetails}`,
    `Desktop coverage: ${report.coverage.desktop}; remote work: ${report.coverage.remoteWork}`,
    "Live account switch: unsupported",
    "Automatic cross-account continuation: unsupported",
    `Diagnostic issues: ${report.issues.map((issue) => `${issue.code} (${issue.count})`).join(", ") || "none"}`,
    "No Claude command, Desktop change or continuation message was executed.",
    "",
  ].join("\n");
}

async function main(args: string[]) {
  try {
    const options = argumentsFor(args);
    if (options.help) {
      process.stdout.write(help);
      return 0;
    }
    const raw = await readSnapshot(options.file);
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success)
      throw new InputError(
        "The snapshot does not match the diagnostic input schema.",
      );
    const observation = observeLiveSessions(parsed.data, options.now);
    if (observation.issues.some((issue) => malformedCodes.has(issue.code)))
      throw new InputError(
        "The snapshot contains invalid or conflicting execution records.",
      );
    const report = reportFor(observation);
    process.stdout.write(
      options.json
        ? JSON.stringify(report, null, 2) + "\n"
        : textReport(report),
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `Relay preflight: ${error instanceof InputError ? error.message : "The offline diagnostic could not be completed."}\n`,
    );
    return 2;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
