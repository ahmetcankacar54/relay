import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CliIO } from "./io";

/**
 * The terminal as a CliIO. A write to a terminal that hung up (EIO) or a closed pipe (EPIPE)
 * is dropped instead of crashing the process: a Desktop operation that is swapping files must
 * be able to finish after its window closed.
 */
export function processIO(streams: {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
}): CliIO & { signalHandler(): ((signal: NodeJS.Signals) => void) | undefined } {
  for (const stream of [streams.stdout, streams.stderr]) stream.on("error", () => {});
  const write = (stream: Writable, line: string) => {
    try {
      stream.write(line + "\n");
    } catch {
      // Nobody is reading any more.
    }
  };
  let handler: ((signal: NodeJS.Signals) => void) | undefined;
  return {
    stdout: (line) => write(streams.stdout, line),
    stderr: (line) => write(streams.stderr, line),
    isTTY: streams.isTTY,
    prompt: (question) =>
      new Promise((resolve) => {
        const rl = readline.createInterface({ input: streams.stdin, output: streams.stdout });
        let done = false;
        const finish = (answer: string | undefined) => {
          if (done) return;
          done = true;
          rl.close();
          resolve(answer);
        };
        rl.on("SIGINT", () => {
          write(streams.stdout, "");
          finish(undefined);
        });
        rl.on("close", () => finish(undefined));
        rl.question(question, (answer) => finish(answer));
      }),
    env: streams.env,
    cwd: streams.cwd,
    now: Date.now,
    pid: process.pid,
    onSignal: (next) => {
      handler = next;
    },
    signalHandler: () => handler,
  };
}
