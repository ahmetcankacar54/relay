import fs from "node:fs/promises";
import path from "node:path";
import {
  duplicateSessions,
  readObject,
  safeFile,
  scopePath,
  uuid,
  type Scope,
  type JsonObject,
} from "./desktop-files";
import type { DesktopHistorySummary } from "../../shared/types";

async function transcriptStatus(
  root: string | undefined,
  record: JsonObject,
): Promise<"found" | "missing" | "unknown"> {
  if (!root || !uuid.safeParse(record.cliSessionId).success) return "unknown";
  const workingDirectories = [
    ...new Set(
      [record.originCwd, record.cwd].filter(
        (cwd): cwd is string => typeof cwd === "string" && path.isAbsolute(cwd),
      ),
    ),
  ];
  if (!workingDirectories.length) return "unknown";
  try {
    const projects = await fs.lstat(await safeFile(root, "projects"));
    if (!projects.isDirectory() || projects.isSymbolicLink()) return "unknown";
  } catch {
    return "unknown";
  }
  // These encodings have been used by the CLI. Probe exact candidate filenames
  // without reading messages or scanning unrelated project histories.
  const slugs = new Set(
    workingDirectories.flatMap((cwd) => [
      cwd.replace(/[/_.]/g, "-"),
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    ]),
  );
  // Other CLI versions may encode Unicode directories differently. A failed
  // exact-path probe is insufficient evidence that their transcript is absent.
  let unknown = workingDirectories.some((cwd) => /[^\x00-\x7f]/.test(cwd));
  for (const slug of slugs) {
    try {
      const file = await safeFile(
        root,
        `projects/${slug}/${record.cliSessionId}.jsonl`,
      );
      const stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0)
        return "found";
      unknown = true;
    } catch (error: any) {
      if (error.code !== "ENOENT") unknown = true;
    }
  }
  return unknown ? "unknown" : "missing";
}

// Presence of a transcript is useful evidence, not a promise of native resume or
// acceptance by another organization's server. This function never writes files.
export async function summarizeHistory(
  desktopRoot: string,
  scope: Scope,
  profileId: string,
  sourceProfiles: number,
  transcriptRoot?: string,
): Promise<DesktopHistorySummary> {
  const summary: DesktopHistorySummary = {
    profileId,
    indexed: 0,
    archived: 0,
    projects: 0,
    transcriptsFound: 0,
    missingTranscripts: 0,
    unknownTranscripts: 0,
    duplicates: 0,
    sourceProfiles,
    checkedAt: new Date().toISOString(),
  };
  const relative = scopePath("claude-code-sessions", scope);
  let names: string[] = [];
  try {
    names = await fs.readdir(await safeFile(desktopRoot, relative));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
  const deleted = new Set(
    names.flatMap((name) => {
      const match = /^deleted_([a-f0-9-]{36})(?:\.json)?$/i.exec(name);
      return match ? [match[1].toLowerCase()] : [];
    }),
  );
  for (const name of names) {
    const match = /^local_([a-f0-9-]{36})\.json$/i.exec(name);
    if (!match || deleted.has(match[1].toLowerCase())) continue;
    summary.indexed++;
    try {
      const record = await readObject(desktopRoot, `${relative}/${name}`);
      if (!record) throw new Error("Missing Code record.");
      if (record.archived === true || record.isArchived === true)
        summary.archived++;
      const status = await transcriptStatus(transcriptRoot, record);
      if (status === "found") summary.transcriptsFound++;
      else if (status === "missing") summary.missingTranscripts++;
      else summary.unknownTranscripts++;
    } catch {
      summary.unknownTranscripts++;
    }
  }
  const spaces = await readObject(
    desktopRoot,
    `${scopePath("local-agent-mode-sessions", scope)}/spaces.json`,
  );
  if (spaces && !Array.isArray(spaces.spaces))
    throw new Error("Unrecognized project format.");
  summary.projects = spaces?.spaces.length ?? 0;
  summary.duplicates = (await duplicateSessions(desktopRoot, scope)).reduce(
    (count, group) => count + group.length - 1,
    0,
  );
  return summary;
}
