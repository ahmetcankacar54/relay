import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { redact } from "./redact";
import type { Account, RelaySettings } from "../../shared/types";

/** One file of a zip: a name inside the archive and its bytes. */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** DOS date and time, the only clock a zip header holds; years before 1980 cannot be written. */
function dosTime(at: Date) {
  const year = Math.max(at.getFullYear(), 1980);
  return {
    time:
      (at.getHours() << 11) |
      (at.getMinutes() << 5) |
      Math.floor(at.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/**
 * A zip archive of `entries`, each deflated, with UTF-8 names. Small and complete enough for a
 * few log files: no zip64, so the archive stays under 4 GB and 65,535 entries.
 */
export function zipArchive(
  entries: readonly ZipEntry[],
  at = new Date(),
): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = zlib.deflateRawSync(entry.data);
    const crc = zlib.crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0x0800, 6); // the name is UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra, comment, disk, internal and external attributes stay 0.
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
/** JSON fields whose value is a secret, whatever it looks like. */
const SECRET_FIELD =
  /("(?:access_?token|refresh_?token|id_?token|session_?key|api_?key|token|secret|password|cookie|authorization)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi;
const SECRET_PARAM = /\b((?:access|refresh|id)_token|code|api_key)=[^&\s"']+/gi;
const BEARER = /\b(Bearer|Basic)\s+[^\s"',;]+/gi;

/**
 * Text that is safe to attach to a public bug report. Email addresses, the given account names
 * (as whole words, any case) and the home folder are masked; secret JSON fields, query
 * parameters and Authorization values are cut; then each line goes through `redact`, which
 * removes Anthropic keys, JWTs and long base64 or hex runs.
 */
export function redactDiagnostics(
  text: string,
  names: readonly string[],
  home?: string,
) {
  let out = text.replace(EMAIL, "[email]");
  if (home && home.length > 1) out = out.split(home).join("~");
  // Longest first, so "Alto Work" is masked whole before "Alto".
  const words = [...new Set(names.map((n) => n.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  for (const word of words)
    out = out.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
        "giu",
      ),
      "[account]",
    );
  out = out
    .replace(SECRET_FIELD, '$1"[redacted]"')
    .replace(SECRET_PARAM, "$1=[redacted]")
    .replace(BEARER, "$1 [redacted]");
  // `redact` trims each line; the indent stays outside it, so summary.json still reads as JSON.
  return out
    .split(/(\r?\n)/)
    .map((part) =>
      part.replace(
        /^([ \t]*)([^\r\n]+)$/,
        (_, indent: string, rest: string) => indent + redact(rest, Infinity),
      ),
    )
    .join("");
}

/**
 * The settings a bug report needs, without names, emails, keys or ids: choices and counts. The
 * planning zone stays, since limits reset by it.
 */
export function settingsSummary(
  settings: RelaySettings,
  accounts: readonly Account[],
) {
  const providers: Record<string, number> = {};
  for (const account of accounts) {
    const provider = account.provider ?? "claude";
    providers[provider] = (providers[provider] ?? 0) + 1;
  }
  return {
    accounts: accounts.length,
    providers,
    desktopConnected: accounts.filter((a) => !!a.desktop).length,
    appearance: settings.appearance,
    usageRefreshMinutes: settings.usageRefreshMinutes,
    usageWarnings: settings.usageWarnings,
    usageWarningPercent: settings.usageWarningPercent,
    suggestAccounts: settings.suggestAccounts,
    desktopHistoryTransfer: settings.desktopHistoryTransfer,
    autoSwitchMode: settings.autoSwitchMode,
    autoSwitchAccounts: settings.autoSwitchAccounts.length,
    draftRetype: settings.draftRetype === true,
    claudeExtension: settings.claudeExtension?.mode ?? "restart",
    terminalCli: settings.terminalCli ?? "follow",
    switchWindow: settings.switchWindow !== false,
    launchAtLogin: settings.launchAtLogin === true,
    gateway: settings.proxy?.enabled === true,
    planning: {
      autoStart: settings.planning.autoStart,
      timeZone: settings.planning.timeZone,
      tempo: settings.planning.tempo ?? "auto",
      adaptive: settings.planning.adaptive !== false,
      accounts: settings.planning.accounts.length,
    },
  };
}

/** How many crash dump names the summary lists, newest first. */
export const CRASH_DUMP_NAMES = 5;

/**
 * The newest minidump names under Electron's crash dump folder (Crashpad keeps them one or two
 * levels down: `completed/` on macOS and Linux, `reports/` on Windows). Names only; a dump holds
 * memory and never goes into the bundle.
 */
export async function newestCrashDumps(
  folder: string,
  count = CRASH_DUMP_NAMES,
) {
  const found: { name: string; at: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth > 0) await walk(file, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(".dmp")) {
        const stat = await fs.stat(file).catch(() => undefined);
        if (stat)
          found.push({
            name: path.relative(folder, file).split(path.sep).join("/"),
            at: stat.mtimeMs,
          });
      }
    }
  };
  await walk(folder, 2);
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, count)
    .map((dump) => dump.name);
}

export interface DiagnosticsBundleInput {
  /** Files to copy in by their base name; one that is missing is left out. */
  files: readonly string[];
  /** What goes into summary.json, before redaction. */
  summary: Record<string, unknown>;
  /** Every saved account's name, masked wherever it appears. */
  names: readonly string[];
  /** The user's home folder, shown as `~`. */
  home?: string;
  at?: Date;
}

/**
 * The diagnostics zip for a bug report: a redacted copy of each log that exists and a
 * `summary.json`, all through `redactDiagnostics`.
 */
export async function buildDiagnosticsBundle(
  input: DiagnosticsBundleInput,
): Promise<Buffer> {
  const clean = (text: string) =>
    Buffer.from(redactDiagnostics(text, input.names, input.home), "utf8");
  const entries: ZipEntry[] = [];
  for (const file of input.files) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined);
    if (text !== undefined)
      entries.push({ name: path.basename(file), data: clean(text) });
  }
  entries.push({
    name: "summary.json",
    data: clean(JSON.stringify(input.summary, null, 2) + "\n"),
  });
  return zipArchive(entries, input.at);
}
