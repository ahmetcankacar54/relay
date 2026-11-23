import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeterUnit, MeterWindow, MeterWindowName } from "../../../shared/meters";
import { MeterError, clampPercent, isoDate, num, plainLabel, requestJson, type Json, type MeterRead, type MeterReaderOptions } from "./common";

/**
 * GitHub Copilot's monthly quotas, from `api.github.com/copilot_internal/user`: the private call
 * Copilot's own editor plugins make (CodexBar's CopilotUsageFetcher reads it the same way). It takes
 * any GitHub OAuth token in the `token` scheme, so the meter uses the one Copilot's plugins or the
 * `gh` CLI already saved, and never signs in itself.
 */

export const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";

/** The headers Copilot Chat sends; the endpoint answers editors only. */
const HEADERS = {
  Accept: "application/json",
  "Editor-Version": "vscode/1.96.2",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "X-Github-Api-Version": "2025-04-01",
};

export interface CopilotToken {
  token: string;
  /** The GitHub login the file names, when it does. */
  login?: string;
}

/** Copilot's plugins keep their sign-in under the config folder: `~/.config/github-copilot` (`%LOCALAPPDATA%` on Windows). */
function copilotDirs(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const dirs = [path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "github-copilot")];
  if (platform === "win32" && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, "github-copilot"));
  return dirs;
}

/**
 * The github.com token in a Copilot `apps.json` or `hosts.json`: an object keyed by host
 * (`github.com`, or `github.com:<app id>` in apps.json) whose value holds `oauth_token` and `user`.
 */
export function copilotTokenFromFile(value: unknown): CopilotToken | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [host, entry] of Object.entries(value as Json)) {
    if (host !== "github.com" && !host.startsWith("github.com:")) continue;
    const token = entry && typeof entry === "object" ? (entry as Json).oauth_token : undefined;
    if (typeof token === "string" && /^[\w.-]{20,255}$/.test(token))
      return { token, ...(plainLabel((entry as Json).user) ? { login: plainLabel((entry as Json).user) } : {}) };
  }
}

/** A plain-text token in `gh`'s `hosts.yml` (saved so when `gh` has no keyring): `oauth_token:` under `github.com:`. */
export function ghTokenFromHosts(text: string): CopilotToken | undefined {
  let inGithub = false;
  let token: string | undefined;
  let login: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      if (inGithub) break;
      inGithub = /^github\.com:\s*$/.test(line);
      continue;
    }
    if (!inGithub) continue;
    const field = /^ {4}(oauth_token|user):\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (field?.[1] === "oauth_token") token = field[2];
    else if (field?.[1] === "user") login = plainLabel(field[2]);
  }
  return token && /^[\w.-]{20,255}$/.test(token) ? { token, ...(login ? { login } : {}) } : undefined;
}

/** `gh auth token`, which prints the token `gh` keeps (in its own keyring item, which it may read without asking). */
function ghAuthToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["auth", "token", "--hostname", "github.com"],
      { timeout: 5_000, env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, windowsHide: true },
      (error, stdout) => {
        const token = String(stdout ?? "").trim();
        resolve(!error && /^[\w.-]{20,255}$/.test(token) ? token : undefined);
      },
    );
  });
}

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The first GitHub token found: Copilot's `apps.json`, then its older `hosts.json`, then `gh`'s
 * plain-text `hosts.yml`, then `gh auth token`.
 */
export async function findCopilotToken(
  options: MeterReaderOptions & { ghToken?: (env: NodeJS.ProcessEnv) => Promise<string | undefined> } = {},
): Promise<CopilotToken | undefined> {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  for (const dir of copilotDirs(home, env, options.platform ?? process.platform))
    for (const name of ["apps.json", "hosts.json"]) {
      const found = copilotTokenFromFile(await readJson(path.join(dir, name)));
      if (found) return found;
    }
  const ghDir = env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "gh");
  const hosts = await fs.readFile(path.join(ghDir, "hosts.yml"), "utf8").catch(() => "");
  const plain = ghTokenFromHosts(hosts);
  if (plain) return plain;
  const token = await (options.ghToken ?? ghAuthToken)(env);
  return token ? { token } : undefined;
}

const SNAPSHOTS: [key: string, name: MeterWindowName, unit: MeterUnit][] = [
  ["premium_interactions", "premium", "premium requests"],
  ["chat", "chat", "requests"],
  ["completions", "completions", "requests"],
];

/** One quota snapshot as a window, or none when it is unlimited or an org seat's empty placeholder. */
function snapshotWindow(raw: unknown, name: MeterWindowName, unit: MeterUnit, resetsAt: string | undefined): MeterWindow | undefined {
  if (!raw || typeof raw !== "object") return;
  const s = raw as Json;
  if (s.unlimited === true) return;
  const limit = num(s.entitlement);
  const remaining = num(s.remaining);
  if (limit === 0 && (remaining ?? 0) === 0) return;
  const left = num(s.percent_remaining);
  const usedPercent =
    left !== undefined ? clampPercent(100 - left) : limit && remaining !== undefined ? clampPercent(((limit - remaining) / limit) * 100) : undefined;
  if (usedPercent === undefined) return;
  return {
    name,
    kind: "monthly",
    unit,
    usedPercent,
    ...(limit !== undefined && remaining !== undefined ? { used: Math.max(0, limit - remaining), limit } : {}),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/** The windows and plan in a `copilot_internal/user` answer. */
export function parseCopilotUser(value: unknown, login?: string): MeterRead {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MeterError("unsupported", undefined, "copilot: not an object");
  const root = value as Json;
  if (root.access_type_sku === "subscription_ended")
    throw new MeterError("not-available", undefined, "copilot: subscription ended");
  const resetsAt = isoDate(root.quota_reset_date) ?? isoDate(root.limited_user_reset_date);
  const windows: MeterWindow[] = [];
  const snapshots = root.quota_snapshots && typeof root.quota_snapshots === "object" ? (root.quota_snapshots as Json) : undefined;
  if (snapshots) {
    for (const [key, name, unit] of SNAPSHOTS) {
      const window = snapshotWindow(snapshots[key], name, unit, resetsAt);
      if (window) windows.push(window);
    }
  } else if (root.monthly_quotas && root.limited_user_quotas) {
    // Copilot Free before quota snapshots: the month's allowance, and what is left of it.
    for (const name of ["chat", "completions"] as const) {
      const limit = num(root.monthly_quotas[name]);
      const remaining = num(root.limited_user_quotas[name]);
      if (!limit || remaining === undefined) continue;
      windows.push({
        name,
        kind: "monthly",
        unit: "requests",
        usedPercent: clampPercent(((limit - remaining) / limit) * 100),
        used: Math.max(0, limit - remaining),
        limit,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  const plan = plainLabel(root.copilot_plan);
  const label = [plan, login].filter(Boolean).join(" · ") || undefined;
  return { ...(label ? { label } : {}), windows };
}

/** Reads the Copilot quotas of the GitHub sign-in found on this computer. */
export async function readCopilot(
  options: MeterReaderOptions & { ghToken?: (env: NodeJS.ProcessEnv) => Promise<string | undefined> } = {},
): Promise<MeterRead> {
  const found = await findCopilotToken(options);
  if (!found) throw new MeterError("not-signed-in", undefined, "copilot: no GitHub token");
  const answer = await requestJson(
    COPILOT_USER_URL,
    { headers: { ...HEADERS, Authorization: `token ${found.token}` } },
    "copilot user",
    // A 403 or 404 is an account without Copilot; a 401 a token GitHub no longer takes.
    { ...options, accept: (status) => status === 403 || status === 404 },
  );
  if (answer.status !== 200) throw new MeterError("not-available", undefined, `copilot user ${answer.status}`);
  return parseCopilotUser(answer.body, found.login);
}
