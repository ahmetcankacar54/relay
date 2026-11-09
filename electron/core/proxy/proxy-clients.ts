import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProxyClientId, ProxyConfig } from "../../../shared/proxy-types";
import type { ProxyClientStatus } from "../../../shared/types";
import { isTailscaleIPv4 } from "../../../shared/proxy-url";

/**
 * Points Claude Code and Codex at the gateway by writing their own settings, and takes it back.
 * Claude Code: `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` in ~/.claude/settings.json;
 * the values there before are kept in Relay's settings and put back on unbind. Codex: a provider
 * table and a top-level `model_provider` in ~/.codex/config.toml, each between Relay's marker
 * lines; an existing top-level `model_provider` is commented out with Relay's prefix and
 * restored on unbind.
 */

export const PROXY_CLIENTS: readonly ProxyClientId[] = ["claude-code", "codex"];

const CLAUDE_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;
const TOP_START = "# >>> relay gateway (written by Relay; remove it from Relay's Proxy page)";
const TOP_END = "# <<< relay gateway";
const TABLE_START = "# >>> relay gateway provider";
const TABLE_END = "# <<< relay gateway provider";
const DISABLED_PREFIX = "# relay-disabled: ";

export interface ClientTarget {
  /** Where the client dials the gateway, without /v1. */
  url: string;
  key: string;
}

const claudeDir = (home: string) => path.join(home, ".claude");
const claudeFile = (home: string) => path.join(claudeDir(home), "settings.json");
const codexDir = (home: string) => path.join(home, ".codex");
const codexFile = (home: string) => path.join(codexDir(home), "config.toml");

export const clientFile = (id: ProxyClientId, home = os.homedir()) =>
  id === "claude-code" ? claudeFile(home) : codexFile(home);

const exists = (file: string) => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};

const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

/** Writes through a temporary file, so a crash never leaves half a settings file. */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.relay-${process.pid}-${Date.now()}.tmp`;
  let mode: number | undefined;
  try {
    mode = (await fs.promises.stat(file)).mode & 0o777;
  } catch {
    // A new file gets the default mode.
  }
  await fs.promises.writeFile(temp, text, { mode: mode ?? 0o600 });
  await fs.promises.rename(temp, file);
}

type Json = Record<string, unknown>;

function readClaudeSettings(home: string): Json {
  const text = readText(claudeFile(home));
  if (text === undefined || !text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings.json is not an object");
  return parsed as Json;
}

const envOf = (settings: Json): Json =>
  settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? (settings.env as Json) : {};

/** Lines outside Relay's own marker blocks, with the blocks removed. */
function withoutRelayBlocks(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === TOP_START || line === TABLE_START) inside = true;
    else if (line === TOP_END || line === TABLE_END) inside = false;
    else if (!inside) out.push(line);
  }
  return out;
}

const tomlString = (value: string) => JSON.stringify(value);

/** The values a Relay table in config.toml holds: base_url and the bearer token. */
function codexRelayValues(text: string): { url?: string; key?: string } {
  const start = text.indexOf(TABLE_START);
  const end = text.indexOf(TABLE_END);
  if (start < 0 || end < start) return {};
  const block = text.slice(start, end);
  const value = (name: string) => {
    const match = new RegExp(`^${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, "m").exec(block);
    return match ? (JSON.parse(`"${match[1]}"`) as string) : undefined;
  };
  return { url: value("base_url")?.replace(/\/v1$/, ""), key: value("experimental_bearer_token") };
}

/** Index of the first table header: top-level keys must come before it. */
const firstTable = (lines: string[]) => {
  const index = lines.findIndex((line) => /^\s*\[/.test(line));
  return index < 0 ? lines.length : index;
};

/** Where each client stands against the gateway now. */
export function clientStatuses(
  target: ClientTarget | undefined,
  config: Pick<ProxyConfig, "clientBindings">,
  home = os.homedir(),
): ProxyClientStatus[] {
  return PROXY_CLIENTS.map((id) => {
    const file = clientFile(id, home);
    const installed = exists(id === "claude-code" ? claudeDir(home) : codexDir(home));
    const relayBound = !!config.clientBindings?.[id];
    try {
      if (id === "claude-code") {
        const env = envOf(readClaudeSettings(home));
        const url = typeof env.ANTHROPIC_BASE_URL === "string" ? env.ANTHROPIC_BASE_URL : undefined;
        const key = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN : undefined;
        const bound = !!target && url === target.url && key === target.key;
        return { id, installed, file, bound, stale: relayBound && !bound };
      }
      const text = readText(file) ?? "";
      const values = codexRelayValues(text);
      const marked = text.includes(TABLE_START);
      const bound = !!target && marked && values.url === target.url && values.key === target.key;
      return { id, installed, file, bound, stale: (relayBound || marked) && !bound };
    } catch {
      return {
        id,
        installed,
        file,
        bound: false,
        stale: false,
        blocked: id === "claude-code" ? "unreadable-settings" : "unreadable-config",
      };
    }
  });
}

/**
 * Points the client at the gateway. Returns what to keep in `clientBindings` for it: the values
 * replaced, so unbinding can restore them. A rebind keeps the first saved values.
 */
export async function bindClient(
  id: ProxyClientId,
  target: ClientTarget,
  previous: Record<string, string | null> | undefined,
  home = os.homedir(),
): Promise<Record<string, string | null>> {
  if (id === "claude-code") {
    const settings = readClaudeSettings(home);
    const env = { ...envOf(settings) };
    const saved: Record<string, string | null> = previous ?? {};
    if (!previous)
      for (const name of CLAUDE_KEYS) saved[name] = typeof env[name] === "string" ? (env[name] as string) : null;
    env.ANTHROPIC_BASE_URL = target.url;
    env.ANTHROPIC_AUTH_TOKEN = target.key;
    await writeAtomic(claudeFile(home), `${JSON.stringify({ ...settings, env }, null, 2)}\n`);
    return saved;
  }
  const lines = withoutRelayBlocks(readText(codexFile(home)) ?? "");
  const top = firstTable(lines);
  // Another provider chosen at the top level would clash with Relay's: it waits, commented out.
  for (let i = 0; i < top; i++)
    if (/^\s*model_provider\s*=/.test(lines[i])) lines[i] = `${DISABLED_PREFIX}${lines[i]}`;
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const head = [TOP_START, `model_provider = "relay"`, TOP_END];
  const table = [
    "",
    TABLE_START,
    "[model_providers.relay]",
    `name = "Relay"`,
    `base_url = ${tomlString(`${target.url}/v1`)}`,
    `wire_api = "responses"`,
    `experimental_bearer_token = ${tomlString(target.key)}`,
    TABLE_END,
    "",
  ];
  await writeAtomic(codexFile(home), [...head, ...lines, ...table].join("\n"));
  return previous ?? {};
}

/** Takes the gateway out of the client's settings and puts back what was there. */
export async function unbindClient(
  id: ProxyClientId,
  previous: Record<string, string | null> | undefined,
  home = os.homedir(),
): Promise<void> {
  if (id === "claude-code") {
    if (!exists(claudeFile(home))) return;
    const settings = readClaudeSettings(home);
    const env = { ...envOf(settings) };
    for (const name of CLAUDE_KEYS) {
      const value = previous?.[name];
      if (typeof value === "string") env[name] = value;
      else delete env[name];
    }
    const next: Json = { ...settings, env };
    if (!Object.keys(env).length) delete next.env;
    await writeAtomic(claudeFile(home), `${JSON.stringify(next, null, 2)}\n`);
    return;
  }
  const text = readText(codexFile(home));
  if (text === undefined) return;
  const lines = withoutRelayBlocks(text).map((line) =>
    line.startsWith(DISABLED_PREFIX) ? line.slice(DISABLED_PREFIX.length) : line,
  );
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  await writeAtomic(codexFile(home), lines.length ? `${lines.join("\n")}\n` : "");
}

/** This Mac's Tailscale IPv4 address, when one of its interfaces is on a tailnet. */
export function tailscaleAddress(
  interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces(),
): string | undefined {
  for (const list of Object.values(interfaces))
    for (const entry of list ?? [])
      if (entry.family === "IPv4" && !entry.internal && isTailscaleIPv4(entry.address)) return entry.address;
}
