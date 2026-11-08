import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BrowserApp } from "../../shared/browser-extension";

export interface CdpCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

export interface CdpEndpoint {
  port: number;
  browserWsUrl: string;
}

export interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Returns cross-platform base path for Chromium user data directories.
 */
export function getChromiumSupportDir(
  platform = process.platform,
  home = os.homedir(),
): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  if (platform === "win32") {
    return process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  }
  // Linux / BSD
  return process.env.XDG_CONFIG_HOME || path.join(home, ".config");
}

/**
 * Strictly verifies that a DevTools WebSocket URL is loopback only and points to a valid DevTools path.
 */
export function isSafeLoopbackWsUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const isWs = url.protocol === "ws:" || url.protocol === "wss:";
    const isLoopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1";
    const isDevToolsPath =
      url.pathname.startsWith("/devtools/browser/") ||
      url.pathname.startsWith("/devtools/page/");
    return isWs && isLoopback && isDevToolsPath;
  } catch {
    return false;
  }
}

/**
 * Reads DevToolsActivePort from the browser's data directory.
 * Chromium writes this file when started with `--remote-debugging-port`.
 * Line 1: Port number
 * Line 2: Browser WebSocket path (e.g., /devtools/browser/uuid)
 */
export function readDevToolsActivePort(
  userDataDir: string,
): CdpEndpoint | undefined {
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");
  try {
    if (!fs.existsSync(activePortFile)) return undefined;
    const content = fs.readFileSync(activePortFile, "utf8").trim().split("\n");
    if (content.length < 2) return undefined;
    const port = parseInt(content[0].trim(), 10);
    const wsPath = content[1].trim();
    if (isNaN(port) || port <= 0 || !wsPath) return undefined;
    const browserWsUrl = `ws://127.0.0.1:${port}${wsPath.startsWith("/") ? "" : "/"}${wsPath}`;
    if (!isSafeLoopbackWsUrl(browserWsUrl)) return undefined;
    return { port, browserWsUrl };
  } catch {
    return undefined;
  }
}

/**
 * Probes local HTTP DevTools endpoints to find an active browser instance.
 */
export async function probeDevToolsHttp(
  port = 9222,
  timeoutMs = 800,
): Promise<CdpEndpoint | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (
      data &&
      data.webSocketDebuggerUrl &&
      isSafeLoopbackWsUrl(data.webSocketDebuggerUrl)
    ) {
      return { port, browserWsUrl: data.webSocketDebuggerUrl };
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Discovers an active Chrome DevTools endpoint by inspecting DevToolsActivePort
 * across profile directories, or probing standard debugging ports (9222, 9223, 9224).
 */
export async function discoverDevToolsEndpoint(
  userDataDir: string,
  portsToProbe = [9222, 9223, 9224],
): Promise<CdpEndpoint | undefined> {
  // 1. Check DevToolsActivePort in user data directory
  const fromFile = readDevToolsActivePort(userDataDir);
  if (fromFile) return fromFile;

  // 2. Check DevToolsActivePort inside "Default" profile folder
  const fromDefaultProfile = readDevToolsActivePort(
    path.join(userDataDir, "Default"),
  );
  if (fromDefaultProfile) return fromDefaultProfile;

  // 3. Probe common ports with loopback verification
  for (const port of portsToProbe) {
    const fromHttp = await probeDevToolsHttp(port);
    if (fromHttp) return fromHttp;
  }

  return undefined;
}

/**
 * Sends a single CDP command over WebSocket and waits for response.
 */
function sendCdpCommand<T = any>(
  ws: WebSocket,
  method: string,
  params: Record<string, any> = {},
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`CDP command '${method}' timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(
          typeof event.data === "string" ? event.data : event.data.toString(),
        );
        if (data.id === id) {
          cleanup();
          if (data.error) {
            reject(
              new Error(
                `CDP error in '${method}': ${data.error.message || JSON.stringify(data.error)}`,
              ),
            );
          } else {
            resolve(data.result as T);
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    const onError = (err: Event) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(
        new Error(`CDP connection closed before command '${method}' completed`),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);

    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Sets cookies directly into the running browser using Chrome DevTools Protocol.
 * Browser stays completely open; zero tabs are closed or lost.
 */
export async function setCookiesViaCdp(
  browserWsUrl: string,
  cookies: CdpCookie[],
  timeoutMs = 4000,
): Promise<{ success: boolean; count: number; error?: string }> {
  if (!isSafeLoopbackWsUrl(browserWsUrl)) {
    return {
      success: false,
      count: 0,
      error: "Unsafe or non-loopback DevTools WebSocket URL",
    };
  }

  return new Promise((resolve) => {
    let ws: WebSocket | undefined;
    let settled = false;

    const finish = (result: {
      success: boolean;
      count: number;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ success: false, count: 0, error: "CDP connection timed out" });
    }, timeoutMs);

    try {
      ws = new WebSocket(browserWsUrl);

      ws.onopen = async () => {
        if (settled) {
          try {
            ws!.close();
          } catch {}
          return;
        }
        try {
          // Normalize cookies with sensible defaults for claude.ai
          const formatted = cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain || ".claude.ai",
            path: c.path || "/",
            secure: c.secure !== undefined ? c.secure : true,
            httpOnly: c.httpOnly !== undefined ? c.httpOnly : true,
            sameSite: c.sameSite || "Lax",
            expires:
              c.expires || Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
          }));

          // Try bulk Network.setCookies first (supported in modern Chromium)
          try {
            await sendCdpCommand(ws!, "Network.setCookies", {
              cookies: formatted,
            });
          } catch {
            // Fallback: set one by one via Network.setCookie
            for (const cookie of formatted) {
              await sendCdpCommand(ws!, "Network.setCookie", cookie);
            }
          }

          finish({ success: true, count: formatted.length });
        } catch (err: any) {
          finish({
            success: false,
            count: 0,
            error: err.message || String(err),
          });
        }
      };

      ws.onerror = () => {
        finish({
          success: false,
          count: 0,
          error: "WebSocket connection error",
        });
      };
    } catch (err: any) {
      finish({ success: false, count: 0, error: err.message || String(err) });
    }
  });
}

/**
 * Finds all active tabs matching claude.ai and reloads them so the new session
 * takes effect immediately without manual user interaction.
 */
export async function reloadClaudeTabsViaCdp(
  port: number,
  timeoutMs = 3000,
): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reloadedCount = 0;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
    });
    if (!res.ok) return 0;
    const targets = (await res.json()) as CdpTarget[];
    const claudeTabs = targets.filter(
      (t) =>
        t.type === "page" &&
        t.url &&
        t.url.includes("claude.ai") &&
        t.webSocketDebuggerUrl,
    );

    for (const tab of claudeTabs) {
      if (!tab.webSocketDebuggerUrl) continue;
      await new Promise<void>((resolveTab) => {
        try {
          const tabWs = new WebSocket(tab.webSocketDebuggerUrl!);
          const tabTimer = setTimeout(() => {
            try {
              tabWs.close();
            } catch {}
            resolveTab();
          }, 1500);

          tabWs.onopen = async () => {
            try {
              await sendCdpCommand(
                tabWs,
                "Page.reload",
                { ignoreCache: true },
                1000,
              );
              reloadedCount++;
            } catch {
              // ignore reload error
            } finally {
              clearTimeout(tabTimer);
              try {
                tabWs.close();
              } catch {}
              resolveTab();
            }
          };

          tabWs.onerror = () => {
            clearTimeout(tabTimer);
            resolveTab();
          };
        } catch {
          resolveTab();
        }
      });
    }
  } catch {
    // ignore fetch or network errors
  } finally {
    clearTimeout(timer);
  }

  return reloadedCount;
}
