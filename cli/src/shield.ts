import type { CliIO } from "./io";
import type { Translate } from "./i18n";

/**
 * Runs an operation that must not stop half-way (Claude is closed and files are being
 * swapped): Ctrl+C, SIGTERM and SIGHUP are held off until it ends, with one line saying so.
 */
export async function shielded<T>(
  io: CliIO,
  t: Translate,
  fn: () => Promise<T>,
): Promise<T> {
  let told = false;
  io.onSignal(() => {
    if (told) return;
    told = true;
    io.stderr(
      t(
        "Claude Desktop işlemi sürüyor; yarıda kesilmemesi için bitmesini bekleyin…",
        "A Claude Desktop operation is running; wait for it to finish so it is not cut short…",
      ),
    );
  });
  try {
    return await fn();
  } finally {
    io.onSignal(undefined);
  }
}
