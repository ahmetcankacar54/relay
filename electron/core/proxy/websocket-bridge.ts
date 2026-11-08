import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { URL } from "node:url";
import { parseRequestUrl } from "./upstream-common";

export interface WebSocketBridgeOptions {
  upstreamUrl: string;
  token?: string;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** Answers an upgrade with a plain HTTP error and closes the socket. */
export function rejectUpgrade(
  socket: net.Socket,
  status: number,
  text: string,
): void {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      () => socket.destroy(),
    );
  } catch {
    socket.destroy();
  }
  // A peer that never reads must not keep the socket forever.
  setTimeout(() => socket.destroy(), 2_000).unref();
}

export class WebSocketBridge {
  private readonly sockets = new Set<net.Socket>();

  /** Open bridges (both sides of each). */
  get openSockets(): number {
    return this.sockets.size;
  }

  /** Drops every bridged connection, e.g. when the gateway stops. */
  closeAll(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  /**
   * Upgrades a client WebSocket connection and pipes it to the upstream endpoint.
   * The upstream path is fixed by `upstreamUrl`; only the client's query string is carried over.
   */
  handleUpgrade(
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    clientHead: Buffer,
    options: WebSocketBridgeOptions,
  ): void {
    if (clientSocket.destroyed) return;

    let search: string;
    try {
      search = parseRequestUrl(clientReq.url).search;
    } catch {
      rejectUpgrade(clientSocket, 400, "Bad Request");
      return;
    }
    const targetUrl = new URL(options.upstreamUrl);
    const isTls =
      targetUrl.protocol === "wss:" || targetUrl.protocol === "https:";
    const port = targetUrl.port
      ? parseInt(targetUrl.port, 10)
      : isTls
        ? 443
        : 80;

    const upstreamHeaders: Record<string, string | string[] | undefined> = {
      ...clientReq.headers,
      host: targetUrl.host,
    };
    delete upstreamHeaders["x-api-key"];
    if (options.token) {
      upstreamHeaders["authorization"] = `Bearer ${options.token}`;
    }

    const hostname = targetUrl.hostname.replace(/^\[|\]$/g, "");
    const connectOptions = { host: hostname, port, servername: hostname };
    const upstreamSocket: net.Socket = isTls
      ? tls.connect(connectOptions)
      : net.connect(connectOptions);

    this.sockets.add(clientSocket);
    this.sockets.add(upstreamSocket);

    let connected = false;
    let closed = false;
    const teardown = (keepClient = false) => {
      if (closed) return;
      closed = true;
      this.sockets.delete(clientSocket);
      this.sockets.delete(upstreamSocket);
      if (!keepClient) clientSocket.destroy();
      upstreamSocket.destroy();
    };

    upstreamSocket.setTimeout(CONNECT_TIMEOUT_MS, () => {
      if (!connected) failBeforeConnect();
    });

    // Before the upstream answers, the client is owed an HTTP error; after, the stream just ends.
    const failBeforeConnect = () => {
      if (closed) return;
      // The 502 is still being written; rejectUpgrade closes the client socket itself.
      rejectUpgrade(clientSocket, 502, "Bad Gateway");
      teardown(true);
    };

    upstreamSocket.on("error", () =>
      connected ? teardown() : failBeforeConnect(),
    );
    clientSocket.on("error", () => teardown());
    clientSocket.on("close", () => teardown());
    upstreamSocket.on("close", () =>
      connected ? teardown() : failBeforeConnect(),
    );

    const IDLE_TIMEOUT_MS = 60_000;

    upstreamSocket.once(isTls ? "secureConnect" : "connect", () => {
      connected = true;
      upstreamSocket.setTimeout(IDLE_TIMEOUT_MS);

      upstreamSocket.on("timeout", () => teardown());
      clientSocket.on("timeout", () => teardown());

      clientSocket.on("data", () => upstreamSocket.setTimeout(IDLE_TIMEOUT_MS));
      upstreamSocket.on("data", () =>
        upstreamSocket.setTimeout(IDLE_TIMEOUT_MS),
      );

      let rawReq = `${clientReq.method ?? "GET"} ${targetUrl.pathname}${search} HTTP/1.1\r\n`;
      for (const [key, value] of Object.entries(upstreamHeaders)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) {
          rawReq += `${key}: ${v}\r\n`;
        }
      }
      rawReq += "\r\n";

      upstreamSocket.write(rawReq);
      if (clientHead.length > 0) {
        upstreamSocket.write(clientHead);
      }

      // Bidirectional pipe
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });
  }
}
