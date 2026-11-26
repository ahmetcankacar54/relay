/**
 * Local stand-ins for the provider APIs behind the gateway, for its parity recording
 * (rust/README.md): every answer is fixed, so the gateway's own behavior is what gets recorded.
 * - 18401, Anthropic: `/v1/messages` as JSON, or as an SSE stream when the body asks for one, with
 *   usage and the unified rate-limit headers;
 * - 18402, Codex and OpenAI: `/responses` and `/chat/completions`, as JSON or SSE;
 * - 18403, a WebSocket server that echoes every text and binary message.
 * Point the gateway at them with RELAY_PROXY_UPSTREAMS (FAKE_UPSTREAMS). Run as a script, it
 * serves until stopped.
 */
import crypto from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const FAKE_PORTS = { anthropic: 18401, openai: 18402, websocket: 18403 };
export const FAKE_UPSTREAMS = {
  anthropicUrl: `http://127.0.0.1:${FAKE_PORTS.anthropic}`,
  codexUrl: `http://127.0.0.1:${FAKE_PORTS.openai}`,
  openaiUrl: `http://127.0.0.1:${FAKE_PORTS.openai}`,
  codexWebSocketUrl: `ws://127.0.0.1:${FAKE_PORTS.websocket}`,
};
/** When the limits the fake Anthropic reports renew, in epoch seconds: fixed, never the clock. */
const FIVE_HOUR_RESET = 1_795_695_000;
const WEEK_RESET = 1_796_000_400;

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

function parse(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

/** Writes Server-Sent Events, one `event:`/`data:` pair each. */
function sse(
  res: http.ServerResponse,
  headers: Record<string, string>,
  events: [string | undefined, unknown][],
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    ...headers,
  });
  for (const [event, data] of events)
    res.write(
      `${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
    );
  res.end();
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const ANTHROPIC_HEADERS = {
  "request-id": "req_fixture_anthropic",
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.42",
  "anthropic-ratelimit-unified-5h-reset": String(FIVE_HOUR_RESET),
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.17",
  "anthropic-ratelimit-unified-7d-reset": String(WEEK_RESET),
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};

async function anthropic(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = parse(await readBody(req));
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages"))
    return json(res, 404, {
      type: "error",
      error: { type: "not_found_error", message: "Not found" },
    });
  const model =
    typeof body.model === "string" ? body.model : "claude-sonnet-4-5";
  const usage = {
    input_tokens: 12,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 7,
  };
  const message = {
    id: "msg_fixture_0001",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "Hello from the fixture." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
  if (body.stream !== true) return json(res, 200, message, ANTHROPIC_HEADERS);
  sse(res, ANTHROPIC_HEADERS, [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello from the fixture." },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

async function openai(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = parse(await readBody(req));
  const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
  const model = typeof body.model === "string" ? body.model : "gpt-5-codex";
  const headers = { "x-request-id": "req_fixture_openai" };
  if (req.method === "POST" && /\/responses$/.test(pathname)) {
    const response = {
      id: "resp_fixture_0001",
      object: "response",
      created_at: 1_795_686_075,
      status: "completed",
      model,
      output: [
        {
          id: "msg_fixture_0001",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from the fixture." }],
        },
      ],
      usage: {
        input_tokens: 21,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 9,
        total_tokens: 30,
      },
    };
    if (body.stream !== true) return json(res, 200, response, headers);
    return sse(res, headers, [
      [
        "response.created",
        {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        },
      ],
      [
        "response.output_text.delta",
        {
          type: "response.output_text.delta",
          delta: "Hello from the fixture.",
        },
      ],
      ["response.completed", { type: "response.completed", response }],
    ]);
  }
  if (req.method === "POST" && /\/chat\/completions$/.test(pathname)) {
    const completion = {
      id: "chatcmpl_fixture_0001",
      object: "chat.completion",
      created: 1_795_686_075,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from the fixture." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 },
    };
    if (body.stream !== true) return json(res, 200, completion, headers);
    return sse(res, headers, [
      [
        undefined,
        {
          ...completion,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "Hello from the fixture." },
            },
          ],
        },
      ],
      [undefined, "[DONE]"],
    ]);
  }
  json(res, 404, {
    error: {
      message: `No fixture for ${pathname}`,
      type: "invalid_request_error",
    },
  });
}

/** Unmasks one client frame at the start of `data`; undefined until it has all arrived. */
function readFrame(data: Buffer) {
  if (data.length < 2) return undefined;
  const opcode = data[0] & 0x0f;
  let length = data[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (data.length < 4) return undefined;
    length = data.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (data.length < 10) return undefined;
    length = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (data[1] & 0x80) !== 0;
  const mask = masked ? data.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  if (data.length < offset + length) return undefined;
  const payload = Buffer.from(data.subarray(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: offset + length };
}

function frame(opcode: number, payload: Buffer) {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([
          0x80 | opcode,
          126,
          payload.length >> 8,
          payload.length & 0xff,
        ]);
  return Buffer.concat([head, payload]);
}

/** An echo WebSocket: text and binary come back as they were sent; a close is answered and ends it. */
function echoUpgrade(req: http.IncomingMessage, socket: net.Socket) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") return socket.destroy();
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC525B9`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (let next = readFrame(pending); next; next = readFrame(pending)) {
      pending = pending.subarray(next.size);
      if (next.opcode === 0x8) {
        socket.end(frame(0x8, next.payload));
        return;
      }
      if (next.opcode === 0x9) socket.write(frame(0xa, next.payload));
      else if (next.opcode === 0x1 || next.opcode === 0x2)
        socket.write(frame(next.opcode, next.payload));
    }
  });
  socket.on("error", () => socket.destroy());
}

function listen(server: http.Server, port: number) {
  return new Promise<http.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Starts the three stand-ins; `close` stops them. */
export async function startFakeUpstreams() {
  const sockets = new Set<net.Socket>();
  const track = (server: http.Server) =>
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
  const servers = await Promise.all([
    listen(
      track(http.createServer((req, res) => void anthropic(req, res))),
      FAKE_PORTS.anthropic,
    ),
    listen(
      track(http.createServer((req, res) => void openai(req, res))),
      FAKE_PORTS.openai,
    ),
    listen(
      track(
        http
          .createServer((_req, res) =>
            json(res, 426, { error: "Upgrade Required" }),
          )
          .on("upgrade", (req, socket: net.Socket) => echoUpgrade(req, socket)),
      ),
      FAKE_PORTS.websocket,
    ),
  ]);
  return {
    close: () => {
      for (const socket of sockets) socket.destroy();
      return Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
)
  void startFakeUpstreams().then((upstreams) => {
    process.stdout.write(
      `RELAY_PROXY_UPSTREAMS='${JSON.stringify(FAKE_UPSTREAMS)}'\n`,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(
        signal,
        () => void upstreams.close().then(() => process.exit(0)),
      );
  });
