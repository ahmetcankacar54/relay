import { randomUUID } from "node:crypto";
import { BrowserWindow, session } from "electron";
import { localCallback, signInNavigationAllowed } from "./core/auth-page-policy";
import { approvalStep, clickButton, READ_PAGE, type ApprovalPage } from "./core/quiet-approval";
import type { PlainCookie } from "./core/desktop-usage";

export type QuietOutcome = (
  | { result: "approved" }
  | { result: "signed-out" | "no-approval" | "failed"; detail: string }
) & {
  /** Where the window went (host and path only) and what the last page showed, for the log. */
  trail?: string[];
  last?: { at: string; loginForm: boolean; buttons: string[] };
  /** Cookies the window's session refused, by name. */
  refused?: string[];
  /** What the page's own requests to Anthropic got: status and path (ids masked). */
  requests?: string[];
};
/** How long a sign-in form must stay before the window gives up: the page passes /login on its way. */
const SIGNED_OUT_MS = 6_000;
const place = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 120);
  } catch {
    return "?";
  }
};

/**
 * Opens a Claude Code sign-in page in a hidden window that holds an account's claude.ai session
 * (its cookies, in memory only) and approves it, as the user would in their browser. The page
 * then hands the approval to the CLI on localhost, which saves the new sign-in. Nothing leaves
 * Anthropic's sites and the CLI's callback; the session is dropped when the window closes.
 */
export function approveQuietly(
  url: string,
  cookies: PlainCookie[],
  timeoutMs = 60_000,
): Promise<QuietOutcome> {
  const callback = localCallback(url);
  if (!callback) return Promise.resolve({ result: "failed", detail: "page has no local callback" });
  const partition = `relay-renew-${randomUUID()}`;
  const space = session.fromPartition(partition);
  let win: BrowserWindow | undefined;
  let finished = false;
  const trail: string[] = [];
  const refused: string[] = [];
  const requests: string[] = [];
  let last: QuietOutcome["last"];
  let signedOutSince: number | undefined;
  const visit = (url: string) => {
    const where = place(url);
    if (trail.at(-1) !== where && trail.length < 30) trail.push(where);
  };
  return new Promise<QuietOutcome>((resolve) => {
    const finish = (result: QuietOutcome) => {
      if (finished) return;
      finished = true;
      const outcome: QuietOutcome = { ...result, trail, refused, requests, ...(last ? { last } : {}) };
      clearTimeout(deadline);
      clearInterval(poll);
      // A moment for the CLI's page to answer before the window goes.
      setTimeout(() => {
        if (win && !win.isDestroyed()) win.destroy();
        void space.clearStorageData().catch(() => {});
      }, outcome.result === "approved" ? 1_500 : 0);
      resolve(outcome);
    };
    const deadline = setTimeout(
      () => finish({ result: "no-approval", detail: clicked ? "approved, no callback" : "no approve button" }),
      timeoutMs,
    );
    let clicked = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    void (async () => {
      try {
        space.setPermissionRequestHandler((_c, _p, decide) => decide(false));
        // A browser's user agent, without the Relay and Electron tokens, as the limit reads send.
        space.setUserAgent(space.getUserAgent().replace(/\s(?:Relay|relay-workspace|Electron)\/\S+/g, ""));
        space.webRequest.onCompleted(
          { urls: ["https://claude.ai/api/*", "https://claude.ai/v1/*", "https://claude.com/*", "https://*.claude.com/*"] },
          (details) => {
            if (requests.length >= 40) return;
            const where = place(details.url).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<id>");
            requests.push(`${details.statusCode} ${details.method} ${where}`);
          },
        );
        // Each as the Claude app keeps it: a host-only cookie (`__Host-…`) gets no domain.
        for (const cookie of cookies)
          await space.cookies
            .set({
              url: `https://${cookie.host.replace(/^\./, "")}${cookie.path}`,
              ...(cookie.host.startsWith(".") ? { domain: cookie.host } : {}),
              path: cookie.path,
              name: cookie.name,
              value: cookie.value,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite,
              // The window lives a minute; the session goes with it.
              expirationDate: Math.min(cookie.expires ?? Infinity, Date.now() / 1000 + 3_600),
            })
            .catch(() => refused.push(cookie.name));
        win = new BrowserWindow({
          show: false,
          width: 520,
          height: 720,
          webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        win.webContents.setAudioMuted(true);
        const guard = (event: { preventDefault(): void }, target: string) => {
          if (!signInNavigationAllowed(target, callback)) event.preventDefault();
        };
        win.webContents.on("will-navigate", (event, target) => guard(event, target));
        win.webContents.on("will-redirect", (event, target) => guard(event, target));
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("did-navigate", (_event, target) => {
          visit(target);
          if (target.startsWith("http:") && signInNavigationAllowed(target, callback))
            finish({ result: "approved" });
        });
        win.webContents.on("did-navigate-in-page", (_event, target) => visit(target));
        win.webContents.on("will-redirect", (_event, target) => visit(target));
        void win.loadURL(url).catch(() => {});
        poll = setInterval(() => {
          void (async () => {
            if (finished || clicked || !win || win.isDestroyed()) return;
            const page = (await win.webContents
              .executeJavaScript(READ_PAGE, true)
              .catch(() => undefined)) as ApprovalPage | undefined;
            if (!page || finished || clicked) return;
            last = {
              at: `${page.host}${page.path}`.slice(0, 120),
              loginForm: page.loginForm,
              buttons: page.buttons.map((b) => b.text).filter(Boolean).slice(0, 12),
            };
            const step = approvalStep(page);
            if (step.step !== "signed-out") signedOutSince = undefined;
            if (step.step === "signed-out") {
              signedOutSince ??= Date.now();
              if (Date.now() - signedOutSince >= SIGNED_OUT_MS)
                finish({ result: "signed-out", detail: `claude.ai asked to sign in at ${last.at}` });
            } else if (step.step === "click") {
              const done = await win.webContents
                .executeJavaScript(clickButton(step.index, page.buttons[step.index]!.text), true)
                .catch(() => false);
              if (done) clicked = true;
            }
          })();
        }, 1_000);
      } catch (error) {
        finish({ result: "failed", detail: String((error as Error)?.message ?? error).slice(0, 160) });
      }
    })();
  });
}
