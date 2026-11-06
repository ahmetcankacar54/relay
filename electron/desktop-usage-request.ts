import { net, session } from "electron";
import type { WebResponse } from "./core/desktop-usage";

const MAX_BODY = 262_144;

/**
 * A GET to claude.ai through Chromium's network stack, which claude.ai's gateway accepts like a
 * browser's. The partition lives in memory only and its own cookies are never used: each read
 * carries exactly the `Cookie` header it is given, so one account's sign-in never reaches another
 * account's read.
 */
export function claudeWebRequest(url: string, cookie: string): Promise<WebResponse> {
  const ses = session.fromPartition("relay-usage");
  // A browser's user agent, without the Relay and Electron tokens.
  const userAgent = ses
    .getUserAgent()
    .replace(/\s(?:Relay|relay-workspace|Electron)\/\S+/g, "");
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: "GET",
      url,
      session: ses,
      useSessionCookies: false,
      redirect: "error",
      credentials: "omit",
    });
    request.setHeader("Cookie", cookie);
    request.setHeader("Accept", "application/json");
    request.setHeader("User-Agent", userAgent);
    request.setHeader("anthropic-client-platform", "web_claude_ai");
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("timeout"));
    }, 15_000);
    request.on("response", (response) => {
      const header = (name: string) => {
        const value = response.headers[name];
        return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
      };
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          clearTimeout(timer);
          request.abort();
          resolve({
            status: response.statusCode,
            contentType: String(header("content-type") ?? ""),
            retryAfter: header("retry-after"),
            body: " ".repeat(MAX_BODY + 1),
          });
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode,
          contentType: String(header("content-type") ?? ""),
          retryAfter: header("retry-after"),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      response.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}
