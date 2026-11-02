// Holds a ProcessLock in its own process for tests: prints "ready", then releases after
// `releaseMs` (or when killed) and exits.
import { ProcessLock } from "../../electron/core/process-lock";

const [file, kind, by, releaseMs] = process.argv.slice(2);
const lock = new ProcessLock(file, by as "app" | "cli");
lock.tryAcquire(kind);
process.stdout.write("ready\n");
const ms = Number(releaseMs);
if (Number.isFinite(ms) && ms > 0)
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, ms);
else setInterval(() => {}, 1000);
