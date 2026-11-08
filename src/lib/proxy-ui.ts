// Kept free of browser-only imports so it can be unit tested under Node.

type T = (tr: string, en: string) => string;

const bracketed = (host: string) => (host.includes(":") && !host.startsWith("[") ? `[${host}]` : host);

/** The address a client dials: a wildcard bind address is reached through loopback. */
export function clientHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  return bracketed(host);
}

/** `http://127.0.0.1:8317`: where the gateway answers. */
export const gatewayUrl = (host: string, port: number) => `http://${clientHost(host)}:${port}`;

export const isLoopbackHost = (host: string) =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** The key with all but its prefix and last four characters hidden. */
export function maskKey(key: string): string {
  const prefix = /^relay-sec-/.exec(key)?.[0] ?? "";
  const rest = key.slice(prefix.length);
  return rest.length <= 4 ? `${prefix}${"•".repeat(rest.length)}` : `${prefix}${"•".repeat(12)}${rest.slice(-4)}`;
}

/** Claude Code CLI: point the SDK at the gateway. The key stays hidden unless `reveal` is set. */
export function claudeCodeSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return `export ANTHROPIC_BASE_URL=${gatewayUrl(host, port)} && export ANTHROPIC_API_KEY=${shown}`;
}

/** Cursor, VS Code and other OpenAI-compatible clients: base URL (with /v1) and key. */
export function openAiSnippet(host: string, port: number, key: string | undefined, mask = false): string {
  const shown = key ? (mask ? maskKey(key) : key) : "<relay-key>";
  return [`Base URL: ${gatewayUrl(host, port)}/v1`, `API key:  ${shown}`].join("\n");
}

/** What a port field holds: a whole number from 1 to 65535. */
export function parsePort(value: string): number | undefined {
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** What a host field holds: an address, with no spaces or URL punctuation. */
export const validHost = (value: string) => {
  const host = value.trim();
  return host.length > 0 && host.length <= 255 && !/[\s/@?#]/.test(host);
};

/** "2 sa 10 dk" / "2 h 10 min" until a reset; "şimdi" at zero. */
export function resetLabel(minutes: number | undefined, t: T): string {
  if (minutes === undefined) return "—";
  if (minutes <= 0) return t("şimdi", "now");
  const days = Math.floor(minutes / 1_440);
  if (days >= 1) return t(`${days} gün ${Math.floor((minutes % 1_440) / 60)} sa`, `${days} d ${Math.floor((minutes % 1_440) / 60)} h`);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours
    ? t(`${hours} sa${rest ? ` ${rest} dk` : ""}`, `${hours} h${rest ? ` ${rest} min` : ""}`)
    : t(`${rest} dk`, `${rest} min`);
}
