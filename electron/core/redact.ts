const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Error text that is safe to print or record: its first line, at most `max` characters, with
 * anything that looks like a credential replaced by "[redacted]". That covers Anthropic keys
 * and tokens, JWTs, and base64 or hex runs of 32 characters or more. Uuids and absolute paths
 * stay readable.
 */
export function redact(message: unknown, max = 300): string {
  const text =
    message instanceof Error
      ? message.message
      : typeof message === "string"
        ? message
        : undefined;
  if (text === undefined) return "Unknown error";
  const line = (text.split(/\r?\n/)[0] ?? "")
    .replace(/sk-ant-[\w-]+/g, "[redacted]")
    .replace(/[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) =>
      UUID.test(run) || run.startsWith("/") ? run : "[redacted]",
    )
    .trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
