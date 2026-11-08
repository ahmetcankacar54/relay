import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import crypto from "node:crypto";
import type stream from "node:stream";
import type net from "node:net";
import {
  readDevToolsActivePort,
  probeDevToolsHttp,
  setCookiesViaCdp,
  reloadClaudeTabsViaCdp,
  getChromiumSupportDir,
} from "../electron/core/cdp-cookie-switch";

function createMockCdpServer(onCommand: (method: string, params: any) => any) {
  const activeSockets = new Set<stream.Duplex>();
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "Chrome/130.0.0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/devtools/browser/mock`,
        }),
      );
      return;
    }
    if (req.url === "/json") {
      const port = (server.address() as net.AddressInfo).port;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify([
          {
            type: "page",
            url: "https://claude.ai/chat/123",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab1`,
          },
          {
            type: "page",
            url: "https://github.com",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/tab2`,
          },
        ]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));
  });

  server.on("upgrade", (req, socket, head) => {
    activeSockets.add(socket);
    socket.on("close", () => activeSockets.delete(socket));

    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    socket.on("data", (buffer) => {
      let offset = 2;
      const maskBit = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      if (len === 126) {
        len = buffer.readUInt16BE(2);
        offset += 2;
      }
      let maskKey: Buffer | undefined;
      if (maskBit) {
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      const payload = buffer.subarray(offset, offset + len);
      const decoded = Buffer.alloc(len);
      for (let i = 0; i < len; i++) {
        decoded[i] = maskBit ? payload[i] ^ maskKey![i % 4] : payload[i];
      }

      try {
        const parsed = JSON.parse(decoded.toString("utf8"));
        const result = onCommand(parsed.method, parsed.params) ?? {};
        const responseJson = Buffer.from(
          JSON.stringify({ id: parsed.id, result }),
        );

        const responseFrame = Buffer.alloc(2 + responseJson.length);
        responseFrame[0] = 0x81;
        responseFrame[1] = responseJson.length;
        responseJson.copy(responseFrame, 2);
        socket.write(responseFrame);
      } catch {
        // ignore
      }
    });
  });

  return {
    server,
    close: () => {
      for (const s of activeSockets) {
        try {
          s.destroy();
        } catch {}
      }
      activeSockets.clear();
      server.close();
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
    },
  };
}

test("getChromiumSupportDir returns OS-specific path", () => {
  assert.match(
    getChromiumSupportDir("darwin", "/Users/tester"),
    /Library\/Application Support/,
  );
  assert.match(
    getChromiumSupportDir("win32", "C:\\Users\\tester"),
    /AppData[\\/]Local/,
  );
  assert.match(getChromiumSupportDir("linux", "/home/tester"), /\.config/);
});

test("readDevToolsActivePort parses port and ws path correctly", async () => {
  const tmp = path.join(os.tmpdir(), `cdp-test-${Date.now()}`);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    assert.equal(readDevToolsActivePort(tmp), undefined);

    await fsp.writeFile(
      path.join(tmp, "DevToolsActivePort"),
      "9222\n/devtools/browser/12345678-abcd-ef01-2345-6789abcdef01\n",
    );
    const endpoint = readDevToolsActivePort(tmp);
    assert.ok(endpoint);
    assert.equal(endpoint.port, 9222);
    assert.equal(
      endpoint.browserWsUrl,
      "ws://127.0.0.1:9222/devtools/browser/12345678-abcd-ef01-2345-6789abcdef01",
    );

    await fsp.writeFile(
      path.join(tmp, "DevToolsActivePort"),
      "not-a-port\n/bad\n",
    );
    assert.equal(readDevToolsActivePort(tmp), undefined);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("probeDevToolsHttp checks /json/version endpoint", async () => {
  const mock = createMockCdpServer(() => ({}));
  await new Promise<void>((resolve) =>
    mock.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (mock.server.address() as net.AddressInfo).port;

  try {
    const endpoint = await probeDevToolsHttp(port, 1000);
    assert.ok(endpoint);
    assert.equal(endpoint.port, port);
    assert.equal(
      endpoint.browserWsUrl,
      `ws://127.0.0.1:${port}/devtools/browser/mock`,
    );
  } finally {
    mock.close();
  }
});

test("setCookiesViaCdp connects via WebSocket and sets cookies", async () => {
  let receivedMethod = "";
  let receivedCookies: any[] = [];

  const mock = createMockCdpServer((method, params) => {
    receivedMethod = method;
    if (params?.cookies) receivedCookies = params.cookies;
    return {};
  });

  await new Promise<void>((resolve) =>
    mock.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (mock.server.address() as net.AddressInfo).port;

  try {
    const res = await setCookiesViaCdp(
      `ws://127.0.0.1:${port}/devtools/browser/test`,
      [
        {
          name: "sessionKey",
          value: "sk-ant-sid-test-secret-12345",
          domain: ".claude.ai",
        },
      ],
      2000,
    );

    assert.equal(res.success, true);
    assert.equal(res.count, 1);
    assert.equal(receivedMethod, "Network.setCookies");
    assert.equal(receivedCookies.length, 1);
    assert.equal(receivedCookies[0].name, "sessionKey");
    assert.equal(receivedCookies[0].value, "sk-ant-sid-test-secret-12345");
  } finally {
    mock.close();
  }
});

test("reloadClaudeTabsViaCdp reloads open claude tabs", async () => {
  let reloaded = false;
  const mock = createMockCdpServer((method) => {
    if (method === "Page.reload") reloaded = true;
    return {};
  });

  await new Promise<void>((resolve) =>
    mock.server.listen(0, "127.0.0.1", resolve),
  );
  const port = (mock.server.address() as net.AddressInfo).port;

  try {
    const count = await reloadClaudeTabsViaCdp(port, 2000);
    assert.equal(count, 1);
    assert.equal(reloaded, true);
  } finally {
    mock.close();
  }
});
