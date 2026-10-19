import { spawn } from "node:child_process";

/** What execFile's failure carries: the exit code, a timeout kill, and the output. */
export interface DetachedExecError extends Error {
  code?: number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command like `execFile`, but in its own process group. A terminal's Ctrl+C or
 * hang-up goes to its foreground group, so commands Relay runs while Claude is closed and
 * files are swapped (osascript, open, ps) must not be in it: killed half-way, they would
 * leave Claude closed. Resolves with the output on exit 0; otherwise rejects with an error
 * whose message reads like execFile's ("Command failed: …" and the stderr).
 */
export function runDetached(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> {
  const limit = options.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "",
      killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.timeout);
    // Decoded per stream, so a character split across two reads comes back whole.
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    const collect = (append: (text: string) => void) => (chunk: string) => {
      append(chunk);
      if (stdout.length + stderr.length > limit) {
        killed = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout!.on("data", collect((text) => (stdout += text)));
    child.stderr!.on("data", collect((text) => (stderr += text)));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !killed) return resolve({ stdout, stderr });
      const error = new Error(
        `Command failed: ${[file, ...args].join(" ")}${stderr ? `\n${stderr}` : ""}`,
      ) as DetachedExecError;
      error.code = code ?? undefined;
      error.killed = killed;
      error.signal = signal;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
