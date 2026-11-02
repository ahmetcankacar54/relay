import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/** Runs a fixture script in its own Node process and resolves once it prints "ready". */
export function childReady(
  script: string,
  args: string[],
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join(__dirname, "fixtures", script), ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout!.on("data", (d) => {
      out += d;
      if (out.includes("ready")) resolve(child);
    });
    child.stderr!.on("data", (d) => (err += d));
    child.once("exit", (code) => reject(new Error(`child exited ${code}: ${err}`)));
  });
}

export function holdInChild(file: string, kind: string, by = "cli", releaseMs = 0) {
  return childReady("process-lock-child.ts", [file, kind, by, String(releaseMs)]);
}

export const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
