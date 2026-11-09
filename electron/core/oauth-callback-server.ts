import http from "node:http";

/**
 * Relay's own answer on an OAuth redirect port (Antigravity's Google client returns to
 * localhost:51121/oauth-callback). Listening here instead of CLIProxyAPI keeps the browser out
 * of the helper's "Authentication successful!" page: Relay hands the address on, shows a short
 * page of its own and comes to the front. Loopback only; one sign-in at a time.
 */

export interface CallbackServer {
  readonly port: number;
  close(): void;
}

export interface CallbackPage {
  title: string;
  body: string;
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A plain page in the system font that follows the light or dark appearance. */
export function callbackHtml(page: CallbackPage): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.title)}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:Canvas;color:CanvasText}main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head><body><main><h1>${escape(page.title)}</h1><p>${escape(page.body)}</p></main><script>setTimeout(function(){window.close()},1500)</script></body></html>`;
}

/**
 * Listens on 127.0.0.1:<port> for <path>. Undefined when the port is taken, so the caller can
 * fall back to another way back. `handle` gets the full address; its page answers the browser.
 * The server closes itself after a handled callback and after `timeoutMs`.
 */
export async function listenOAuthCallback(options: {
  port: number;
  path: string;
  handle: (address: string) => Promise<CallbackPage>;
  timeoutMs: number;
}): Promise<CallbackServer | undefined> {
  let handled = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${options.port}`);
    if (req.method !== "GET" || url.pathname !== options.path || handled) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    handled = true;
    void options
      .handle(url.toString())
      .catch((): CallbackPage => ({ title: "Relay", body: "" }))
      .then((page) => {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        res.end(callbackHtml(page));
      })
      .finally(() => setTimeout(close, 500));
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  const timer = setTimeout(close, options.timeoutMs);
  timer.unref?.();
  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(options.port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) {
    clearTimeout(timer);
    return undefined;
  }
  return { port: options.port, close };
}
