import { fileURLToPath } from "node:url";
import os from "node:os";
import { runCli } from "./main";
import { processIO } from "./process-io";

const io = processIO({
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    const handler = io.signalHandler();
    if (handler) return handler(signal);
    process.exit(128 + (os.constants.signals[signal] ?? 1));
  });

runCli(process.argv.slice(2), io, { selfPath: fileURLToPath(import.meta.url) }).then((code) => {
  process.exitCode = code;
});
