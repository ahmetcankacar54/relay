import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { redact } from "../core/redact";
/** The error log is started over once it passes this size. */
const MAIN_ERROR_LOG_BYTES = 1024 * 1024;
/**
 * An error no code in the main process caught, appended to `<logs>/main-errors.log` with the
 * time, each line redacted, for a bug report. Relay keeps running.
 */
export function recordMainError(kind: string, error: unknown) {
  try {
    const file = path.join(app.getPath("logs"), "main-errors.log");
    const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const lines = text.split(/\r?\n/).map((line) => redact(line, 500));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAIN_ERROR_LOG_BYTES)
      fs.truncateSync(file, 0);
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind} ${lines.join("\n  ")}\n`, {
      mode: 0o600,
    });
  } catch {
    // Nowhere to write it: the error is dropped, never thrown again.
  }
}
/** Records every error no code caught, from now until Relay quits. */
export function installProcessErrorHandlers() {
  process.on("unhandledRejection", (reason) => recordMainError("unhandledRejection", reason));
  process.on("uncaughtException", (error) => recordMainError("uncaughtException", error));
}
