import type { Plugin } from "vite";

/** "serve" is the Vite dev server (`npm run dev`); "build" is the app that ships. */
export type CspMode = "serve" | "build";

/** The dev server's hot-reload socket: vite.config.ts `server`, electron/main.ts's dev URL. */
const DEV_SOCKET = "ws://127.0.0.1:5173";

/** The windows' Content-Security-Policy. Only development may connect to the dev server. */
export function contentSecurityPolicy(mode: CspMode): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    mode === "serve"
      ? `connect-src 'self' ${DEV_SOCKET}`
      : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
  ].join("; ");
}

const CSP_META =
  /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;

/** Writes the mode's policy into an HTML entry's CSP meta tag. An entry without one is an error. */
export function withContentSecurityPolicy(html: string, mode: CspMode): string {
  if (!CSP_META.test(html))
    throw new Error("An HTML entry has no Content-Security-Policy meta tag.");
  return html.replace(
    CSP_META,
    (_, open: string, close: string) =>
      `${open}${contentSecurityPolicy(mode)}${close}`,
  );
}

/** Gives every HTML entry the policy for the running command. */
export function contentSecurityPolicyPlugin(): Plugin {
  let mode: CspMode = "build";
  return {
    name: "relay-content-security-policy",
    configResolved(config) {
      mode = config.command;
    },
    transformIndexHtml: {
      order: "pre",
      handler: (html) => withContentSecurityPolicy(html, mode),
    },
  };
}
