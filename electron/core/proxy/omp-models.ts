import fs from "node:fs";
import path from "node:path";

/*
 * omp's models.yml, edited as text: Relay owns the lines between its markers, plus any line it
 * parked with its prefix. omp reads overrides of its own built-in providers from this file:
 * `baseUrl` sends their requests to the gateway and the `x-relay-key` header carries the client
 * key. The `apiKey` values are placeholders the gateway never forwards. The Claude one looks like
 * a Claude sign-in, so omp sends Claude Code-shaped requests (Anthropic refuses a subscription
 * sign-in any other request); the Codex one spares omp a ChatGPT sign-in of its own. The gateway
 * sends a pooled account's sign-in instead (and, for Codex, its ChatGPT account id).
 *
 * The user's own `anthropic` or `openai-codex` entry would be a second key of the same name, which
 * breaks the file: it is parked (each line commented out with Relay's prefix) and put back on
 * unbind, like the `model_provider` line in Codex's config.toml. Binding only inserts lines and
 * prefixes, and unbinding takes exactly those away, so the file comes back byte for byte: line
 * endings, a missing last newline and trailing blank lines included. A layout Relay cannot edit
 * that safely is refused (OmpBlock) instead of guessed at.
 *
 * omp finds the file the same way on macOS and Linux: ~/.omp/agent/models.yml, else models.yaml
 * next to it; a models.json there is moved to models.yml by omp at its next start.
 */

export const OMP_START = "# >>> relay gateway (written by Relay; remove it from Relay's Proxy page)";
export const OMP_END = "# <<< relay gateway";
export const OMP_PARKED = "# relay-disabled: ";
/** Looks like a Claude sign-in to omp; the gateway never forwards it. */
export const OMP_CLAUDE_PLACEHOLDER = "sk-ant-oat01-relay-gateway";
const PROVIDERS = ["anthropic", "openai-codex"] as const;
/** The placeholder key each entry carries. */
const KEYS: Record<(typeof PROVIDERS)[number], string> = {
  anthropic: OMP_CLAUDE_PLACEHOLDER,
  "openai-codex": "relay-gateway",
};

export interface OmpTarget {
  url: string;
  key: string;
}

/**
 * Why Relay will not write the file: `providers` written inline with entries; a layout line-based
 * editing cannot handle safely (several YAML documents, `providers` as a list, one of Relay's
 * providers written as a multi-line flow map); or a models.json omp has not moved yet.
 */
export type OmpBlock = "inline-providers" | "unsupported-layout" | "legacy-json";

export const ompAgentDir = (home: string) => path.join(home, ".omp", "agent");

/** The models file omp reads: models.yml, or models.yaml when only that one is there. */
export function ompModelsFile(home: string): string {
  const dir = ompAgentDir(home);
  const yml = path.join(dir, "models.yml");
  const yaml = path.join(dir, "models.yaml");
  return !fs.existsSync(yml) && fs.existsSync(yaml) ? yaml : yml;
}

/**
 * omp moves a lone models.json to models.yml when it starts, unless a models.yml is there:
 * a file Relay wrote first would hide the user's providers for good.
 */
export function ompLegacyJson(home: string): boolean {
  const dir = ompAgentDir(home);
  return (
    fs.existsSync(path.join(dir, "models.json")) &&
    !fs.existsSync(path.join(dir, "models.yml")) &&
    !fs.existsSync(path.join(dir, "models.yaml"))
  );
}

// Lines are split on "\n" only: a "\r" stays on its line, so CRLF files are written back as read.
const splitLines = (text: string) => text.split("\n");
const isBlank = (line: string) => !line.trim();
const isComment = (line: string) => /^\s*#/.test(line);
const indentOf = (line: string) => /^ */.exec(line)![0].length;
// A byte order mark may open the first line.
const PROVIDERS_KEY = /^\uFEFF?(["']?)providers\1:/;

/** Lines outside Relay's block (parked lines included, still parked). */
function outside(lines: string[]): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of lines) {
    const bare = line.trim();
    if (bare === OMP_START) inside = true;
    else if (bare === OMP_END) inside = false;
    else if (!inside) out.push(line);
  }
  return out;
}

const valueOf = (line: string) => line.replace(PROVIDERS_KEY, "").replace(/\s+#.*$/, "").trim();
const providersAt = (lines: string[]) => lines.findIndex((line) => PROVIDERS_KEY.test(line) && !valueOf(line));
const emptyInline = (line: string) => PROVIDERS_KEY.test(line) && /^\{\s*\}$/.test(valueOf(line));

/** The indent of the entries under `providers:` (two spaces when there are none). */
function entryIndent(lines: string[], at: number): number {
  for (let i = at + 1; i < lines.length; i++) {
    if (isBlank(lines[i]) || isComment(lines[i])) continue;
    return indentOf(lines[i]) || 2;
  }
  return 2;
}

/** One of Relay's provider names, when the line is an entry of `providers` at this indent. */
function relayEntry(line: string, indent: number): string | undefined {
  if (isBlank(line) || isComment(line) || indentOf(line) !== indent) return undefined;
  const name = /^\s*(["']?)([\w-]+)\1\s*:/.exec(line)?.[2];
  return name && (PROVIDERS as readonly string[]).includes(name) ? name : undefined;
}

/** [start, end) of each of the user's own entries named like Relay's under `providers:`. */
function ownEntries(lines: string[], at: number): Array<[number, number]> {
  const indent = entryIndent(lines, at);
  const ranges: Array<[number, number]> = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!isBlank(line) && !isComment(line) && indentOf(line) === 0) break; // The next top-level key.
    if (!relayEntry(line, indent)) continue;
    // The entry holds the lines deeper than it, blank lines between them included; a comment or
    // a key at its own indent or less ends it.
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) break;
      end = j + 1;
    }
    ranges.push([i, end]);
    i = end - 1;
  }
  return ranges;
}

/** Why Relay will not write this text, if it will not. */
export function ompBlocked(text: string): OmpBlock | undefined {
  const lines = outside(splitLines(text));
  const keys = lines.filter((line) => PROVIDERS_KEY.test(line));
  if (keys.some((line) => valueOf(line) && !emptyInline(line))) return "inline-providers";
  if (keys.length > 1) return "unsupported-layout";
  // More than one document: Relay's block could land in the wrong one.
  if (lines.some((line) => /^\.\.\.(\s|$)/.test(line))) return "unsupported-layout";
  // A `---` after content starts a second document.
  const content = lines.findIndex((line) => !isBlank(line) && !isComment(line) && !/^\uFEFF?---(\s|$)/.test(line));
  if (lines.some((line, i) => i > content && content >= 0 && /^---(\s|$)/.test(line))) return "unsupported-layout";
  // Explicit `? key` entries hide which keys there are.
  if (lines.some((line) => /^\s*\?(\s|$)/.test(line))) return "unsupported-layout";
  const at = providersAt(lines);
  if (at < 0) return undefined;
  const first = lines.slice(at + 1).find((line) => !isBlank(line) && !isComment(line));
  if (first && /^\s*-(\s|$)/.test(first)) return "unsupported-layout"; // `providers` is a list.
  for (const [start, end] of ownEntries(lines, at)) {
    // A flow map or list that is not closed on its own line runs past what Relay would park.
    const value = lines[start]
      .replace(/^[^:]*:/, "")
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, "''") // Brackets inside quotes do not count.
      .replace(/\s+#.*$/, "")
      .trim();
    const open = (value.match(/[{[]/g) ?? []).length;
    const close = (value.match(/[}\]]/g) ?? []).length;
    if (open !== close) return "unsupported-layout";
    // An anchor on an entry Relay would park leaves its aliases pointing at nothing.
    if (/^&/.test(value)) return "unsupported-layout";
    if (end < lines.length && /^\s*[}\]]/.test(lines[end])) return "unsupported-layout";
  }
  return undefined;
}

/** The text with Relay's block removed and parked lines put back. */
export function ompUnbound(text: string): string {
  return outside(splitLines(text))
    .map((line) => {
      const at = line.indexOf(OMP_PARKED);
      return at >= 0 && !line.slice(0, at).trim() ? line.slice(0, at) + line.slice(at + OMP_PARKED.length) : line;
    })
    .join("\n");
}

/** Whether the text holds nothing but Relay's block: then Relay wrote all of it. */
export const ompRelayOnly = (text: string) => ompMarked(text) && !ompUnbound(text).trim();

/** The text with Relay's providers pointing at the gateway; the user's own of those names parked. */
export function ompBound(text: string, target: OmpTarget): string {
  const lines = outside(splitLines(text));
  const cr = text.includes("\r\n") ? "\r" : "";
  // An empty inline map (`providers: {}`) is parked; Relay's block brings its own `providers:`.
  const inline = lines.findIndex(emptyInline);
  if (inline >= 0) lines[inline] = OMP_PARKED + lines[inline];
  const at = providersAt(lines);
  const indent = at < 0 ? 2 : entryIndent(lines, at);
  if (at >= 0)
    for (const [start, end] of ownEntries(lines, at))
      for (let j = start; j < end; j++)
        if (!isBlank(lines[j])) lines[j] = `${" ".repeat(indent)}${OMP_PARKED}${lines[j].slice(indent)}`;
  const pad = " ".repeat(indent);
  const block: string[] = [OMP_START];
  if (at < 0) block.push("providers:");
  for (const name of PROVIDERS)
    block.push(
      `${pad}${name}:`,
      `${pad}${pad}baseUrl: ${JSON.stringify(target.url)}`,
      `${pad}${pad}apiKey: ${JSON.stringify(KEYS[name])}`,
      `${pad}${pad}headers:`,
      `${pad}${pad}${pad}x-relay-key: ${JSON.stringify(target.key)}`,
    );
  block.push(OMP_END);
  const added = block.map((line) => line + cr);
  if (at >= 0) lines.splice(at + 1, 0, ...added);
  // At the end: before the last newline when the text ends with one, so it still does.
  else if (lines[lines.length - 1] === "") lines.splice(lines.length - 1, 0, ...added);
  else lines.push(...added);
  return lines.join("\n");
}

/** Whether the text holds Relay's block. */
export const ompMarked = (text: string) => splitLines(text).some((line) => line.trim() === OMP_START);

/** Whether Relay's block sends both providers to this gateway with this key. */
export function ompBoundTo(text: string, target: OmpTarget): boolean {
  const lines = splitLines(text);
  const start = lines.findIndex((line) => line.trim() === OMP_START);
  const end = lines.findIndex((line, i) => i > start && line.trim() === OMP_END);
  if (start < 0 || end < 0) return false;
  const block = lines.slice(start + 1, end);
  const values = (name: string) =>
    block.flatMap((line) => {
      const match = new RegExp(`^\\s*${name}:\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`).exec(line);
      return match ? [JSON.parse(match[1]) as string] : [];
    });
  const names = block.flatMap((line) => /^\s*([\w-]+):\s*$/.exec(line)?.[1] ?? []);
  const urls = values("baseUrl");
  const keys = values("x-relay-key");
  return (
    PROVIDERS.every((name) => names.includes(name)) &&
    urls.length === PROVIDERS.length &&
    urls.every((url) => url === target.url) &&
    keys.length === PROVIDERS.length &&
    keys.every((key) => key === target.key)
  );
}
