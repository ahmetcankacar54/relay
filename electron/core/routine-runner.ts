import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Account } from "../../shared/types";
import { planningIdentity } from "../../shared/planning";
import { profileEnvironment, resolveExecutable } from "./environment";
import { readProfileIdentity } from "./profile-identity";
import type { Store } from "./store";
import type { UsageCredential } from "./usage-credentials";

const execute = promisify(execFile);
export const QUOTA_STARTER_PROMPT =
  "Reply with exactly OK. This is a scheduled usage-window check. Do not use tools, read files, or continue any previous task.";
export function quotaStarterArgs() {
  return [
    "--print",
    QUOTA_STARTER_PROMPT,
    "--safe-mode",
    "--tools",
    "",
    "--disallowedTools",
    "*",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({
      disableAllHooks: true,
      enabledPlugins: {},
      disableClaudeAiConnectors: true,
      syncClaudeAiPlugins: false,
      syncClaudeAiSkills: false,
      autoMemoryEnabled: false,
    }),
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--max-turns",
    "1",
    "--model",
    "haiku",
    "--effort",
    "low",
    "--output-format",
    "json",
  ];
}
export function routineEnvironment(
  profile: string,
  token: string,
  source: NodeJS.ProcessEnv = process.env,
) {
  const env = profileEnvironment(profile, source);
  // The silently acquired credential takes precedence over keychain access.
  // No token is included in command arguments, logs, or persisted state.
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = "1";
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE = "1";
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  env.DISABLE_AUTOUPDATER = "1";
  // An inherited exporter could expose OAuth credentials or the routine text.
  for (const key of Object.keys(env))
    if (/^(OTEL_|BETA_TRACING_|ENABLE_BETA_TRACING|DEBUG$)/i.test(key))
      delete env[key];
  return env;
}
export function routinePolicyPaths(
  profile: string,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
) {
  const paths = [path.join(profile, "remote-settings.json")];
  const directory =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : platform === "linux"
        ? "/etc/claude-code"
        : "C:\\Program Files\\ClaudeCode";
  paths.push(
    ...["managed-settings.json", "managed-settings.d", "managed-mcp.json"].map(
      (name) => path.join(directory, name),
    ),
  );
  if (platform === "darwin") {
    // Presence alone is enough to refuse; no policy contents or commands are
    // executed. The prefs domain is documented as com.anthropic.claudecode.
    paths.push(
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      path.join(
        "/Library/Managed Preferences",
        path.basename(home),
        "com.anthropic.claudecode.plist",
      ),
      "/Library/Preferences/com.anthropic.claudecode.plist",
      path.join(home, "Library/Preferences/com.anthropic.claudecode.plist"),
    );
  }
  return paths;
}
/**
 * Any account whose usage identity matches its Desktop binding may start a
 * window, including company seats. Local administrator policy is still refused
 * in runQuotaStarter; server-delivered policy cannot be detected locally.
 */
export function windowStartEligible(account: Account) {
  return !!planningIdentity(account);
}
export interface QuotaStarterOptions {
  execute?: typeof execute;
  policyPaths?: string[];
  now?: () => number;
  guard?: () => Promise<boolean>;
  signal?: AbortSignal;
}
export async function runQuotaStarter(
  store: Store,
  account: Account,
  credentials: (
    profile: string,
    allowPrompt: boolean,
  ) => Promise<UsageCredential>,
  options: QuotaStarterOptions = {},
) {
  if (options.signal?.aborted || !options.guard || !(await options.guard()))
    throw new Error("routine-settings-changed");
  if (!windowStartEligible(account))
    throw new Error("routine-policy-unverified");
  // Windows registry and WSL host policy aren't safely checked by this beta.
  // No attempt to circumvent or disable any administrator policy is made.
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    process.env.WSL_DISTRO_NAME ||
    process.env.WSL_INTEROP
  )
    throw new Error("routine-platform-unsupported");
  const profile = store.profile(account.id);
  const profileStat = await fs.lstat(profile);
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink())
    throw new Error("identity-mismatch");
  const identity = await readProfileIdentity(profile);
  if (
    !identity ||
    identity.accountUuid !== account.auth!.accountUuid ||
    identity.orgId !== account.auth!.orgId
  )
    throw new Error("identity-mismatch");
  for (const file of options.policyPaths ?? routinePolicyPaths(profile)) {
    try {
      await fs.lstat(file);
      throw new Error("routine-policy-unverified");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("routine-policy-unverified");
    }
  }
  const executable = resolveExecutable(store.state.executable);
  if (!executable) throw new Error("routine-cli-unavailable");
  const invoke = options.execute ?? execute;
  if (process.platform === "darwin") {
    try {
      await invoke("/usr/bin/defaults", ["read", "com.anthropic.claudecode"], {
        timeout: 10_000,
        maxBuffer: 262_144,
        windowsHide: true,
        encoding: "utf8",
        shell: false,
        signal: options.signal,
      });
      throw new Error("routine-policy-unverified");
    } catch (e) {
      const failure = e as { code?: number; stderr?: string };
      if (failure.code !== 1 || !/does not exist/i.test(failure.stderr ?? ""))
        throw new Error("routine-policy-unverified");
    }
  }
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "relay-quota-starter-"));
  try {
    // Help is a local capability check, never a model request. Unknown flags
    // fail before sending a prompt and never trigger a less isolated fallback.
    const { stdout: help } = await invoke(executable, ["--help"], {
      cwd,
      env: profileEnvironment(profile),
      timeout: 15_000,
      maxBuffer: 262_144,
      windowsHide: true,
      encoding: "utf8",
      shell: false,
      signal: options.signal,
    });
    if (
      ![
        "--safe-mode",
        "--tools",
        "--strict-mcp-config",
        "--setting-sources",
        "--no-session-persistence",
        "--permission-prompts",
      ].every((flag) => String(help).includes(flag))
    )
      throw new Error("routine-cli-unsupported");
    if (options.signal?.aborted || !(await options.guard()))
      throw new Error("routine-settings-changed");
    const credential = await credentials(profile, false);
    if (
      !credential.scopes.includes("user:inference") ||
      !credential.expiresAt ||
      credential.expiresAt <= (options.now ?? Date.now)()
    )
      throw new Error("routine-credentials-unavailable");
    if (options.signal?.aborted || !(await options.guard()))
      throw new Error("routine-settings-changed");
    const { stdout } = await invoke(executable, quotaStarterArgs(), {
      cwd,
      env: routineEnvironment(profile, credential.accessToken),
      timeout: 90_000,
      maxBuffer: 262_144,
      windowsHide: true,
      encoding: "utf8",
      shell: false,
      signal: options.signal,
    });
    const result: unknown = JSON.parse(String(stdout));
    if (
      !result ||
      typeof result !== "object" ||
      (result as { is_error?: boolean }).is_error ||
      (result as { subtype?: string }).subtype !== "success" ||
      (result as { result?: string }).result?.trim() !== "OK"
    )
      throw new Error("routine-request-failed");
  } catch (e) {
    // Never propagate execFile errors: they can include command/env/outputs.
    const allowed = new Set([
      "routine-cli-unsupported",
      "routine-credentials-unavailable",
      "routine-request-failed",
      "routine-settings-changed",
    ]);
    throw new Error(
      e instanceof Error && allowed.has(e.message)
        ? e.message
        : "routine-request-failed",
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
