import os from "node:os";
import { profileEnvironment } from "../../electron/core/environment";
import type { CliDeps } from "./deps";

/**
 * Runs the official Claude Code CLI in an account's isolated profile and resolves with its
 * exit code (or 128 + the signal number). `inherit` gives it this terminal; otherwise its
 * output is discarded, so nothing it prints (a token included) reaches Relay's output.
 */
export function runClaude(
  deps: Pick<CliDeps, "spawn">,
  executable: string,
  args: string[],
  profile: string,
  options: { inherit?: boolean; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = deps.spawn(executable, args, {
      cwd: options.cwd ?? profile,
      env: profileEnvironment(profile, options.env ?? process.env),
      stdio: options.inherit ? "inherit" : "ignore",
    });
    const timer =
      options.timeoutMs !== undefined ? setTimeout(() => child.kill("SIGKILL"), options.timeoutMs) : undefined;
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 1) : 1));
    });
  });
}
