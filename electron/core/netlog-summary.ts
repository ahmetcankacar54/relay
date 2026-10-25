/**
 * Reads a Chromium net log (the JSON `--log-net-log` writes) into what a stuck page needs:
 * every URL request with its protocol, timing and end, the ones that never ended, and the
 * HTTP/2 and QUIC sessions that closed with an error. A log of a Claude that still runs, or
 * was killed, has no closing brackets; it is read up to its last whole event.
 */

export type Protocol = "h3" | "h2" | "h1" | "cache" | "unknown";

export interface NetRequest {
  id: number;
  url: string;
  method?: string;
  /** Wall clock, ms since the epoch. */
  startedAt: number;
  endedAt?: number;
  /** When the response headers arrived. */
  headersAt?: number;
  protocol: Protocol;
  /** Chromium's error name when it ended with one, e.g. ERR_QUIC_PROTOCOL_ERROR. */
  error?: string;
}

export interface NetSession {
  id: number;
  kind: "quic" | "h2";
  host: string;
  startedAt: number;
  closedAt?: number;
  /** The QUIC or net error it closed with, and Chromium's words for it. */
  error?: string;
  details?: string;
}

export interface NetLogSummary {
  /** The first and the last event, wall clock. */
  from: number;
  to: number;
  events: number;
  /** Whether the log was cut off: Claude still ran or was killed while writing it. */
  truncated: boolean;
  requests: NetRequest[];
  sessions: NetSession[];
}

type Json = Record<string, any>;

/** The log as JSON, closing a log that was cut off after its last whole event. */
function parseLog(text: string): { log: Json; truncated: boolean } {
  try {
    return { log: JSON.parse(text), truncated: false };
  } catch {
    // Cut after the last event that closed its line, then close the array and the object.
    const end = text.lastIndexOf("},\n");
    const body = end >= 0 ? text.slice(0, end + 1) : text.replace(/[,\s]+$/, "");
    return { log: JSON.parse(`${body}]}`), truncated: true };
  }
}

const invert = (map: Json | undefined) =>
  new Map<number, string>(Object.entries(map ?? {}).map(([name, id]) => [Number(id), name]));

export function summarizeNetLog(text: string): NetLogSummary {
  const { log, truncated } = parseLog(text);
  const constants: Json = log.constants ?? {};
  const types = invert(constants.logEventTypes);
  const sources = invert(constants.logSourceType);
  const errors = invert(constants.netError);
  const quicErrors = invert(constants.quicError);
  const phase = constants.logEventPhase ?? { PHASE_BEGIN: 1, PHASE_END: 2 };
  const offset = Number(constants.timeTickOffset ?? 0);
  const events: Json[] = Array.isArray(log.events) ? log.events : [];
  const requests = new Map<number, NetRequest & { sent?: Protocol; cacheRead?: boolean }>();
  const sessions = new Map<number, NetSession>();
  let from = Infinity;
  let to = -Infinity;
  const errorName = (code: unknown) =>
    typeof code === "number" && code !== 0 ? (errors.get(code) ?? `net error ${code}`) : undefined;

  for (const event of events) {
    const at = offset + Number(event.time);
    if (!Number.isFinite(at)) continue;
    from = Math.min(from, at);
    to = Math.max(to, at);
    const type = types.get(event.type) ?? "";
    const source = sources.get(event.source?.type) ?? "";
    const id = Number(event.source?.id);
    const params: Json = event.params ?? {};
    if (source === "URL_REQUEST") {
      let request = requests.get(id);
      if (!request) {
        request = { id, url: "", startedAt: at, protocol: "unknown" };
        requests.set(id, request);
      }
      if (!request.url && typeof params.url === "string") request.url = params.url;
      if (!request.method && typeof params.method === "string") request.method = params.method;
      if (type === "HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS") request.sent = "h3";
      else if (type === "HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS") request.sent = "h2";
      else if (type === "HTTP_TRANSACTION_SEND_REQUEST_HEADERS") request.sent ??= "h1";
      else if (type === "HTTP_CACHE_READ_INFO" || type === "HTTP_CACHE_READ_DATA") request.cacheRead = true;
      if (type === "HTTP_TRANSACTION_READ_RESPONSE_HEADERS" && request.headersAt === undefined)
        request.headersAt = at;
      if (type === "REQUEST_ALIVE" && event.phase === phase.PHASE_END) {
        request.endedAt = at;
        request.error = errorName(params.net_error);
      }
    } else if (source === "QUIC_SESSION" || source === "HTTP2_SESSION") {
      let session = sessions.get(id);
      if (!session) {
        session = {
          id,
          kind: source === "QUIC_SESSION" ? "quic" : "h2",
          host: "",
          startedAt: at,
        };
        sessions.set(id, session);
      }
      if (!session.host && typeof params.host === "string") session.host = params.host;
      if (type === "QUIC_SESSION_CLOSED" || type === "HTTP2_SESSION_CLOSE") {
        session.closedAt = at;
        const quicError = params.quic_error;
        const code = errorName(params.net_error);
        session.error =
          (typeof quicError === "string" && quicError !== "QUIC_NO_ERROR" ? quicError : undefined) ??
          (typeof quicError === "number" && quicError !== 0
            ? (quicErrors.get(quicError) ?? `QUIC error ${quicError}`)
            : undefined) ??
          code;
        if (typeof params.details === "string") session.details = params.details;
        else if (typeof params.description === "string") session.details = params.description;
      }
    }
  }
  return {
    from: Number.isFinite(from) ? from : 0,
    to: Number.isFinite(to) ? to : 0,
    events: events.length,
    truncated,
    requests: [...requests.values()]
      .filter((r) => r.url)
      .map(({ sent, cacheRead, ...r }) => ({
        ...r,
        protocol: sent ?? (cacheRead ? "cache" : "unknown"),
      })),
    sessions: [...sessions.values()],
  };
}

const clock = (ms: number) => {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** A URL short enough for a line: host and path, no query. */
const shortUrl = (url: string) => {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 70 ? `${u.pathname.slice(0, 67)}...` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 90);
  }
};

/** The summary as text: what never ended, what was slow or failed, and the sessions that broke. */
export function formatNetLogSummary(summary: NetLogSummary, slowMs = 5_000): string {
  const lines: string[] = [];
  const { requests, sessions } = summary;
  const line = (r: NetRequest, end: number) =>
    `  ${clock(r.startedAt)}  ${seconds(end - r.startedAt).padStart(8)}  ${r.protocol.padEnd(7)} ` +
    `${r.headersAt !== undefined ? `headers +${seconds(r.headersAt - r.startedAt)}` : "no headers"}  ` +
    `${r.error ? `${r.error}  ` : ""}${shortUrl(r.url)}`;
  lines.push(
    `Net log ${clock(summary.from)} → ${clock(summary.to)} (${seconds(summary.to - summary.from)}), ` +
      `${summary.events} events, ${requests.length} requests${summary.truncated ? ", cut off (Claude was still running)" : ""}`,
  );
  const open = requests.filter((r) => r.endedAt === undefined);
  lines.push("", `Never ended (${open.length}):`);
  for (const r of open.sort((a, b) => a.startedAt - b.startedAt)) lines.push(line(r, summary.to));
  const slow = requests
    .filter((r) => r.endedAt !== undefined && r.endedAt - r.startedAt >= slowMs)
    .sort((a, b) => b.endedAt! - b.startedAt - (a.endedAt! - a.startedAt));
  lines.push("", `Took ${seconds(slowMs)} or longer (${slow.length}):`);
  for (const r of slow) lines.push(line(r, r.endedAt!));
  const failed = requests.filter((r) => r.error);
  lines.push("", `Ended with an error (${failed.length}):`);
  const byError = new Map<string, number>();
  for (const r of failed) byError.set(r.error!, (byError.get(r.error!) ?? 0) + 1);
  for (const [error, count] of [...byError].sort((a, b) => b[1] - a[1]))
    lines.push(`  ${String(count).padStart(4)}  ${error}`);
  lines.push("", "Protocol by host:");
  const hosts = new Map<string, Map<Protocol, number>>();
  for (const r of requests) {
    let host = "?";
    try {
      host = new URL(r.url).host;
    } catch {}
    const counts = hosts.get(host) ?? new Map<Protocol, number>();
    counts.set(r.protocol, (counts.get(r.protocol) ?? 0) + 1);
    hosts.set(host, counts);
  }
  for (const [host, counts] of [...hosts].sort((a, b) => sum(b[1]) - sum(a[1])).slice(0, 15))
    lines.push(`  ${host.padEnd(40)} ${[...counts].map(([p, n]) => `${p} ${n}`).join(", ")}`);
  const broken = sessions.filter((s) => s.error);
  lines.push("", `Sessions closed with an error (${broken.length}):`);
  for (const s of broken.sort((a, b) => a.startedAt - b.startedAt))
    lines.push(
      `  ${clock(s.startedAt)} → ${s.closedAt !== undefined ? clock(s.closedAt) : "open"}  ${s.kind.padEnd(4)} ` +
        `${s.host.padEnd(32)} ${s.error}${s.details ? ` · ${s.details.slice(0, 120)}` : ""}`,
    );
  return lines.join("\n");
}

const sum = (counts: Map<Protocol, number>) => [...counts.values()].reduce((a, b) => a + b, 0);
