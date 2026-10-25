import test from "node:test";
import assert from "node:assert/strict";
import { formatNetLogSummary, summarizeNetLog } from "../electron/core/netlog-summary";

/** Chromium's net log layout, with only the names the summary reads. */
const constants = {
  timeTickOffset: "1792957700000",
  logEventPhase: { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 },
  logSourceType: { URL_REQUEST: 1, QUIC_SESSION: 2, HTTP2_SESSION: 3 },
  logEventTypes: {
    REQUEST_ALIVE: 1,
    URL_REQUEST_START_JOB: 2,
    HTTP_TRANSACTION_QUIC_SEND_REQUEST_HEADERS: 3,
    HTTP_TRANSACTION_HTTP2_SEND_REQUEST_HEADERS: 4,
    HTTP_TRANSACTION_SEND_REQUEST_HEADERS: 5,
    HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 6,
    HTTP_CACHE_READ_INFO: 7,
    QUIC_SESSION: 8,
    QUIC_SESSION_CLOSED: 9,
    HTTP2_SESSION: 10,
    HTTP2_SESSION_CLOSE: 11,
  },
  netError: { ERR_QUIC_PROTOCOL_ERROR: -356, ERR_ABORTED: -3 },
};
const ev = (time: number, type: number, source: [number, number], phase = 0, params?: object) => ({
  time: String(time),
  type,
  source: { id: source[0], type: source[1] },
  phase,
  ...(params ? { params } : {}),
});
const ASSET = "https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/shared-3-T6zD6.js?x=1";
const events = [
  // A QUIC request that got headers but never ended.
  ev(1000, 1, [1, 1], 1),
  ev(1001, 2, [1, 1], 0, { url: ASSET, method: "GET" }),
  ev(1002, 3, [1, 1]),
  ev(2000, 6, [1, 1]),
  // An HTTP/2 request that took 6 s and failed.
  ev(1000, 1, [2, 1], 1),
  ev(1001, 2, [2, 1], 0, { url: "https://claude.ai/api/bootstrap", method: "GET" }),
  ev(1002, 4, [2, 1]),
  ev(7000, 1, [2, 1], 2, { net_error: -356 }),
  // A cache hit that ended at once.
  ev(1100, 1, [3, 1], 1),
  ev(1101, 2, [3, 1], 0, { url: "https://assets-proxy.anthropic.com/a.css" }),
  ev(1102, 7, [3, 1]),
  ev(1150, 1, [3, 1], 2),
  // A QUIC session that closed with an error, and an HTTP/2 one that closed cleanly.
  ev(900, 8, [4, 2], 1, { host: "assets-proxy.anthropic.com" }),
  ev(8000, 9, [4, 2], 0, { quic_error: "QUIC_NETWORK_IDLE_TIMEOUT", details: "No recent network activity" }),
  ev(950, 10, [5, 3], 1, { host: "claude.ai:443" }),
  ev(8100, 11, [5, 3], 0, { net_error: 0 }),
];
const whole = JSON.stringify({ constants, events });

test("each request has its protocol, its headers and its end, and the broken sessions are named", () => {
  const s = summarizeNetLog(whole);
  assert.equal(s.truncated, false);
  assert.equal(s.from, 1792957700000 + 900);
  assert.equal(s.to, 1792957700000 + 8100);
  const byUrl = new Map(s.requests.map((r) => [r.url, r]));
  const quic = byUrl.get(ASSET)!;
  assert.equal(quic.protocol, "h3");
  assert.equal(quic.endedAt, undefined);
  assert.equal(quic.headersAt! - quic.startedAt, 1000);
  const h2 = byUrl.get("https://claude.ai/api/bootstrap")!;
  assert.equal(h2.protocol, "h2");
  assert.equal(h2.error, "ERR_QUIC_PROTOCOL_ERROR");
  assert.equal(h2.endedAt! - h2.startedAt, 6000);
  assert.equal(byUrl.get("https://assets-proxy.anthropic.com/a.css")!.protocol, "cache");
  assert.deepEqual(
    s.sessions.map((x) => [x.kind, x.host, x.error ?? null]),
    [
      ["quic", "assets-proxy.anthropic.com", "QUIC_NETWORK_IDLE_TIMEOUT"],
      ["h2", "claude.ai:443", null],
    ],
  );
});

test("a log cut off while Claude still runs is read up to its last whole event", () => {
  const lines = [`{"constants":${JSON.stringify(constants)},`, `"events": [`];
  for (const e of events.slice(0, 6)) lines.push(`${JSON.stringify(e)},`);
  // Half an event, as Chromium was writing it.
  const cut = `${lines.join("\n")}\n{"time":"70`;
  const s = summarizeNetLog(cut);
  assert.equal(s.truncated, true);
  assert.equal(s.events, 6);
  assert.deepEqual(
    s.requests.map((r) => r.url),
    [ASSET, "https://claude.ai/api/bootstrap"],
  );
});

test("the text names what never ended, what was slow or failed, by host and session", () => {
  const text = formatNetLogSummary(summarizeNetLog(whole));
  assert.match(text, /Never ended \(1\):\n.*h3 +headers \+1\.0 s +assets-proxy\.anthropic\.com\/claude-ai\/v2\/assets\/v1\/shared-3-T6zD6\.js/);
  assert.doesNotMatch(text, /\?x=1/, "no query string");
  assert.match(text, /Took 5\.0 s or longer \(1\):\n.*6\.0 s +h2 .*ERR_QUIC_PROTOCOL_ERROR +claude\.ai\/api\/bootstrap/);
  assert.match(text, /Ended with an error \(1\):\n +1 +ERR_QUIC_PROTOCOL_ERROR/);
  assert.match(text, /assets-proxy\.anthropic\.com +h3 1, cache 1/);
  assert.match(text, /Sessions closed with an error \(1\):\n.*quic +assets-proxy\.anthropic\.com +QUIC_NETWORK_IDLE_TIMEOUT · No recent network activity/);
});
