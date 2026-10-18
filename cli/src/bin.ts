import readline from "node:readline";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { runCli } from "./main";
import type { CliIO } from "./io";

let handler: ((signal: NodeJS.Signals) => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (handler) return handler(signal);
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });

const io: CliIO = {
  stdout: (line) => void process.stdout.write(line + "\n"),
  stderr: (line) => void process.stderr.write(line + "\n"),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  prompt: (question) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let done = false;
      const finish = (answer: string | undefined) => {
        if (done) return;
        done = true;
        rl.close();
        resolve(answer);
      };
      rl.on("SIGINT", () => {
        process.stdout.write("\n");
        finish(undefined);
      });
      rl.on("close", () => finish(undefined));
      rl.question(question, (answer) => finish(answer));
    }),
  env: process.env,
  cwd: process.cwd(),
  now: Date.now,
  pid: process.pid,
  onSignal: (next) => {
    handler = next;
  },
};

runCli(process.argv.slice(2), io, { selfPath: fileURLToPath(import.meta.url) }).then((code) => {
  process.exitCode = code;
});
