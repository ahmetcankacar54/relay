import type { CliIO } from "./io";
import type { T } from "../../shared/i18n/translate";

/**
 * Runs an operation that must not stop half-way (Claude is closed and files are being
 * swapped): Ctrl+C, SIGTERM and SIGHUP are held off until it ends, with one line saying so.
 */
export async function shielded<R>(
  io: CliIO,
  t: T,
  fn: () => Promise<R>,
): Promise<R> {
  let told = false;
  io.onSignal(() => {
    if (told) return;
    told = true;
    io.stderr(
      t("shield.aClaudeAppOperationIsRunning"),
    );
  });
  try {
    return await fn();
  } finally {
    io.onSignal(undefined);
  }
}
