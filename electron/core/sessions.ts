import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session, TranscriptMessage } from "../../shared/types";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TRANSCRIPT = 128 * 1024 * 1024;
const MAX_LINE = 2 * 1024 * 1024;
export interface IndexedSession extends Session {
  file: string;
  root: string;
  projectFolder: string;
}
type Row = Record<string, any>;
const metadataCache = new Map<
  string,
  { signature: string; session: IndexedSession }
>();

async function* rows(file: string): AsyncGenerator<Row> {
  let buffer = "";
  let skipping = false;
  for await (const chunk of fs.createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  })) {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!skipping && line.length <= MAX_LINE) {
        try {
          const value = JSON.parse(line);
          if (value && typeof value === "object") yield value;
        } catch {
          /* A CLI may be writing the last record. */
        }
      }
      skipping = false;
    }
    if (buffer.length > MAX_LINE) {
      buffer = "";
      skipping = true;
    }
  }
  if (buffer && !skipping) {
    try {
      const value = JSON.parse(buffer);
      if (value && typeof value === "object") yield value;
    } catch {
      /* Partial tail. */
    }
  }
}
function messageText(row: Row): string {
  const content = row.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}
export async function assertContained(root: string, file: string) {
  const realRoot = await fsp.realpath(root);
  const realFile = await fsp.realpath(file);
  const relative = path.relative(realRoot, realFile);
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("Oturum yolu profil klasörünün dışında.");
  // Reject symlinks, including ancestors, even when they resolve inside the root.
  let cursor = root;
  for (const part of path.relative(root, file).split(path.sep)) {
    cursor = path.join(cursor, part);
    if ((await fsp.lstat(cursor)).isSymbolicLink())
      throw new Error("Oturumlarda sembolik bağlantılar desteklenmiyor.");
  }
}
export async function scanSessions(
  root: string,
  accountId: string,
  pinned: string[],
  lineage: Record<string, string>,
) {
  const sessions: IndexedSession[] = [];
  const warnings: string[] = [];
  const projects = path.join(root, "projects");
  let dirs;
  try {
    await assertContained(root, projects);
    dirs = await fsp.readdir(projects, { withFileTypes: true });
  } catch (error: any) {
    if (error.code !== "ENOENT")
      warnings.push(
        "Bir profilin oturum klasörü okunamadı veya bağlantı içeriyor.",
      );
    return { sessions, warnings };
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const project = path.join(projects, dir.name);
    let files;
    try {
      files = await fsp.readdir(project, { withFileTypes: true });
    } catch {
      warnings.push("Bir proje klasörü okunamadı.");
      continue;
    }
    for (const entry of files) {
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".jsonl") ||
        !UUID.test(entry.name.slice(0, -6))
      )
        continue;
      const file = path.join(project, entry.name);
      try {
        await assertContained(root, file);
        const stat = await fsp.stat(file);
        if (stat.size > MAX_TRANSCRIPT) {
          warnings.push("128 MB üzerindeki bir oturum taranmadı.");
          continue;
        }
        const id = entry.name.slice(0, -6);
        const key = `${accountId}:${id}`;
        const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = metadataCache.get(file);
        if (cached?.signature === signature) {
          sessions.push({
            ...cached.session,
            pinned: pinned.includes(key),
            forkedFrom: lineage[key],
          });
          continue;
        }
        let cwd = "";
        let title = "";
        let firstPrompt = "";
        let summary = "";
        let messages = 0;
        for await (const row of rows(file)) {
          if (typeof row.cwd === "string" && path.isAbsolute(row.cwd))
            cwd = row.cwd;
          if (typeof row.customTitle === "string") title = row.customTitle;
          if (typeof row.summary === "string") summary = row.summary;
          if (
            (row.type === "user" || row.type === "assistant") &&
            !row.isMeta &&
            !row.isSidechain
          ) {
            const text = messageText(row);
            if (text) messages++;
            if (
              row.type === "user" &&
              !firstPrompt &&
              text &&
              !text.startsWith("<")
            )
              firstPrompt = text;
          }
        }
        if (!cwd) continue;
        const session: IndexedSession = {
          key,
          id,
          accountId,
          projectDir: cwd,
          projectName: path.basename(cwd) || cwd,
          title: (title || summary || firstPrompt || "Başlıksız oturum")
            .replace(/\s+/g, " ")
            .slice(0, 180),
          updatedAt: stat.mtime.toISOString(),
          messages,
          bytes: stat.size,
          pinned: pinned.includes(key),
          forkedFrom: lineage[key],
          file,
          root,
          projectFolder: dir.name,
        };
        sessions.push(session);
        if (metadataCache.size >= 10_000)
          metadataCache.delete(metadataCache.keys().next().value!);
        metadataCache.set(file, { signature, session });
      } catch {
        warnings.push("Bir oturum dosyası okunamadı; kaynak dosya korundu.");
      }
    }
  }
  return { sessions, warnings: [...new Set(warnings)] };
}
export async function readTranscript(
  session: IndexedSession,
): Promise<TranscriptMessage[]> {
  await assertContained(session.root, session.file);
  if ((await fsp.stat(session.file)).size > MAX_TRANSCRIPT)
    throw new Error("Oturum önizleme sınırını aşıyor.");
  const messages: TranscriptMessage[] = [];
  for await (const row of rows(session.file)) {
    if (
      (row.type === "user" || row.type === "assistant") &&
      !row.isMeta &&
      !row.isSidechain
    ) {
      const text = messageText(row);
      if (text) {
        messages.push({ role: row.type, text: text.slice(0, 12_000) });
        if (messages.length > 60) messages.shift();
      }
    }
  }
  return messages;
}
// Only the selected transcript is transferred. Credentials, hooks, settings and MCP state never are.
// Source is always preserved. Existing target history is never overwritten.
export async function copyTranscript(
  session: IndexedSession,
  targetRoot: string,
) {
  await assertContained(session.root, session.file);
  const before = await fsp.stat(session.file);
  if (before.size > MAX_TRANSCRIPT)
    throw new Error("Bu oturum aktarım sınırını aşıyor.");
  const bytes = await fsp.readFile(session.file);
  const after = await fsp.stat(session.file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("Oturum hâlâ yazılıyor. Önce çalışan oturumu kapat.");
  // Every handoff gets a fresh ID. This permits A → B → A without overwriting an older branch.
  const newId = randomUUID();
  const cloned: string[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(
        "Oturumda eksik veya bozuk bir kayıt var. Kaynak terminali kapatıp tekrar dene.",
      );
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw new Error("Oturum kayıt biçimi desteklenmiyor.");
    if (record.sessionId !== undefined && record.sessionId !== session.id)
      throw new Error(
        "Dosyada farklı bir oturum kimliği bulundu. Aktarım durduruldu.",
      );
    if (record.sessionId === session.id) record.sessionId = newId;
    cloned.push(JSON.stringify(record));
  }
  if (!cloned.length) throw new Error("Boş oturum aktarılamaz.");
  const targetDir = path.join(targetRoot, "projects", session.projectFolder);
  // Validate each ancestor before creating or writing beneath it.
  let cursor = targetRoot;
  for (const part of ["projects", session.projectFolder]) {
    cursor = path.join(cursor, part);
    try {
      const s = await fsp.lstat(cursor);
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new Error("Hedef oturum klasörü geçersiz.");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      await fsp.mkdir(cursor, { mode: 0o700 });
    }
  }
  await assertContained(targetRoot, targetDir);
  const target = path.join(targetDir, `${newId}.jsonl`);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fsp.writeFile(temp, `${cloned.join("\n")}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    // Writable: Windows refuses to flush a file opened for reading only (EPERM).
    const handle = await fsp.open(temp, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link is an atomic no-clobber publish on NTFS and POSIX.
    await fsp.link(temp, target);
  } finally {
    await fsp.rm(temp, { force: true });
  }
  return newId;
}
