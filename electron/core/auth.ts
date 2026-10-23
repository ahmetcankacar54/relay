import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import type { AuthFlow } from "../../shared/types";
import { ProfileLockBusyError } from "./profile-lock";

export const authPending = (flow?: AuthFlow) =>
  !!flow && ["starting", "waiting", "verifying"].includes(flow.status);

// OAuth URLs and CLI output stay in this process and are never persisted or sent over IPC.
export function authorizationURL(text: string): string | undefined {
  for (const match of stripVTControlCharacters(text).matchAll(
    /https:\/\/[^\s<>"']+/g,
  )) {
    try {
      const url = new URL(match[0]);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        (([
          "claude.ai",
          "console.anthropic.com",
          "platform.claude.com",
        ].includes(url.hostname) &&
          ["/oauth/authorize", "/oauth/authorize/"].includes(url.pathname)) ||
          (url.hostname === "claude.com" &&
            ["/cai/oauth/authorize", "/cai/oauth/authorize/"].includes(
              url.pathname,
            ))) &&
        url.searchParams.has("client_id") &&
        url.searchParams.has("state") &&
        url.searchParams.has("redirect_uri")
      )
        return url.href;
    } catch {
      /* Incomplete stream chunk. */
    }
  }
}
interface Entry {
  flow: AuthFlow;
  child: ChildProcessWithoutNullStreams;
  output: string;
  url?: string;
  timer?: ReturnType<typeof setTimeout>;
  closed: Promise<void>;
  stopping: boolean;
  continued: boolean;
}
export class AuthManager {
  private entries = new Map<string, Entry>();
  constructor(
    private verify: (id: string) => Promise<boolean>,
    private emit: (flow: AuthFlow) => void,
    private open: (url: string) => Promise<void>,
    private timeoutMs = 10 * 60_000,
    /** Takes the account's exclusive profile lock, shared with Relay's other processes. */
    private profileLock?: (accountId: string) => () => void,
  ) {}
  list() {
    return [...this.entries.values()].map((e) => ({ ...e.flow }));
  }
  active(id: string) {
    const e = this.entries.get(id);
    return !!e && (authPending(e.flow) || e.stopping);
  }
  start(
    accountId: string,
    executable: string,
    cwd: string,
    env: Record<string, string>,
  ): AuthFlow {
    const previous = this.entries.get(accountId);
    if (previous && this.active(accountId)) return { ...previous.flow };
    if (this.list().filter(authPending).length >= 4)
      throw new Error("Önce yarım kalan limit okuma girişlerinden birini tamamla.");
    let releaseProfile: (() => void) | undefined;
    try {
      releaseProfile = this.profileLock?.(accountId);
    } catch (error) {
      if (error instanceof ProfileLockBusyError)
        throw new Error(
          "Bu hesap şu an başka bir Relay işleminde (terminalde) kullanılıyor; o bitince yeniden dene.",
        );
      throw error;
    }
    const child = spawn(executable, ["auth", "login", "--claudeai"], {
      cwd,
      env,
      windowsHide: true,
      stdio: "pipe",
      shell: false,
    });
    let resolveClose!: () => void;
    const e: Entry = {
      flow: {
        id: randomUUID(),
        accountId,
        status: "starting",
        browserReady: false,
        codeRequested: false,
        startedAt: new Date().toISOString(),
      },
      child,
      output: "",
      stopping: false,
      continued: false,
      closed: new Promise((resolve) => {
        resolveClose = resolve;
      }),
    };
    this.entries.set(accountId, e);
    const receive = (chunk: string) => {
      if (e.stopping || !authPending(e.flow)) return;
      e.output = (e.output + chunk).slice(-32768);
      // Require a delimiter to avoid accepting a truncated OAuth query at a chunk boundary.
      const complete = e.output.slice(
        0,
        Math.max(e.output.lastIndexOf("\n"), e.output.lastIndexOf("\r")) + 1,
      );
      const url = authorizationURL(complete);
      if (url && !e.url) {
        e.url = url;
        this.update(e, { status: "waiting", browserReady: true });
      }
      if (
        /paste (?:the )?(?:authorization )?code|enter (?:the )?(?:authorization )?code/i.test(
          stripVTControlCharacters(e.output),
        ) &&
        !e.flow.codeRequested
      )
        this.update(e, { codeRequested: true });
      // Some CLI versions ask for Enter after saving credentials.
      if (/login successful/i.test(e.output) && !e.continued) {
        e.continued = true;
        child.stdin.write("\n");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.stdin.on("error", () => {
      /* Exit can race with a final newline/code submission. */
    });
    child.once("error", () => {
      if (!e.stopping)
        this.finish(
          e,
          "failed",
          "Limit okuma girişi başlatılamadı. Ayarlar’daki Claude Code CLI bölümünü kontrol et.",
        );
    });
    child.once("error", () => releaseProfile?.());
    child.once("close", (code) => {
      releaseProfile?.();
      resolveClose();
      if (e.stopping || !authPending(e.flow)) return;
      e.output = "";
      e.url = undefined;
      if (code !== 0) {
        this.finish(
          e,
          "failed",
          "Limit okuma girişi tamamlanmadı. Yeniden dene ve tarayıcıda onayla.",
        );
        return;
      }
      this.update(e, {
        status: "verifying",
        browserReady: false,
        codeRequested: false,
      });
      void this.complete(e);
    });
    e.timer = setTimeout(() => {
      void this.cancel(accountId, e.flow.id, true);
    }, this.timeoutMs);
    this.emit({ ...e.flow });
    return { ...e.flow };
  }
  async reopen(accountId: string, attemptId: string) {
    const e = this.get(accountId, attemptId);
    if (e.stopping || e.flow.status !== "waiting" || !e.url)
      throw new Error(
        "Giriş sayfası henüz hazır değil ya da süresi doldu. Girişi yeniden başlat.",
      );
    await this.open(e.url);
  }
  submitCode(accountId: string, attemptId: string, code: string) {
    const e = this.get(accountId, attemptId);
    if (!authPending(e.flow) || e.stopping || !e.flow.codeRequested)
      throw new Error("Bu giriş işlemi kod beklemiyor.");
    if (!code.trim() || code.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(code))
      throw new Error("Tarayıcının verdiği tek satırlık kodu yapıştır.");
    e.child.stdin.write(code.trim() + "\n");
    this.update(e, { codeRequested: false });
  }
  async cancel(accountId: string, attemptId: string, timedOut = false) {
    const e = this.get(accountId, attemptId);
    if (!authPending(e.flow)) return;
    e.stopping = true;
    clearTimeout(e.timer);
    e.child.kill();
    const force = setTimeout(() => e.child.kill("SIGKILL"), 1500);
    try {
      await e.closed;
    } finally {
      clearTimeout(force);
    }
    this.finish(
      e,
      timedOut ? "failed" : "cancelled",
      timedOut ? "Giriş süresi doldu. Girişi yeniden başlat." : undefined,
    );
    e.stopping = false;
  }
  async dispose() {
    await Promise.all(
      this.list()
        .filter(authPending)
        .map((f) => this.cancel(f.accountId, f.id)),
    );
  }
  private async complete(e: Entry) {
    try {
      const connected = await this.verify(e.flow.accountId);
      if (
        e.stopping ||
        !authPending(e.flow) ||
        this.entries.get(e.flow.accountId) !== e
      )
        return;
      this.finish(
        e,
        connected ? "connected" : "failed",
        connected
          ? undefined
          : "Tarayıcı onayı alındı ama hesap doğrulanamadı. Limitleri yenile; sorun sürerse limit okuma girişini yenile.",
      );
    } catch {
      if (!e.stopping && authPending(e.flow))
        this.finish(
          e,
          "failed",
          "Hesap doğrulanamadı. Limitleri yenile; sorun sürerse limit okuma girişini yenile.",
        );
    }
  }
  private get(accountId: string, attemptId: string) {
    const e = this.entries.get(accountId);
    if (!e || e.flow.id !== attemptId)
      throw new Error("Bu giriş denemesi artık geçerli değil.");
    return e;
  }
  private update(e: Entry, patch: Partial<AuthFlow>) {
    Object.assign(e.flow, patch);
    this.emit({ ...e.flow });
  }
  private finish(e: Entry, status: AuthFlow["status"], error?: string) {
    clearTimeout(e.timer);
    e.output = "";
    e.url = undefined;
    this.update(e, {
      status,
      error,
      browserReady: false,
      codeRequested: false,
    });
  }
}
