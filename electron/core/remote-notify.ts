import { setTimeout as delay } from "node:timers/promises";
import {
  remoteNotifySettings,
  remoteNotifyUrl,
} from "../../shared/remote-notify";
import type {
  RelaySettings,
  RemoteNotifyEvents,
  RemoteNotifyKind,
  RemoteNotifyResult,
} from "../../shared/types";
import type { LimitWindowKind } from "./limit-notice";
import { redact } from "./redact";

/** What Relay posts; every name but "test" follows one of the event choices in RemoteNotifyEvents. */
export type RemoteEventName =
  | "limit-near"
  | "limit-ready"
  | "auto-switch"
  | "sign-in-ending"
  | "sign-in-ended"
  | "test";

const EVENT_CHOICE: Record<
  Exclude<RemoteEventName, "test">,
  keyof RemoteNotifyEvents
> = {
  "limit-near": "limit",
  "limit-ready": "reset",
  "auto-switch": "autoSwitch",
  "sign-in-ending": "signIn",
  "sign-in-ended": "signIn",
};

/** ntfy shows these tags as emoji before the title (https://docs.ntfy.sh/emojis/); "relay" stays a word. */
const NTFY_TAGS: Record<RemoteEventName, string> = {
  "limit-near": "warning,relay",
  "limit-ready": "white_check_mark,relay",
  "auto-switch": "twisted_rightwards_arrows,relay",
  "sign-in-ending": "key,relay",
  "sign-in-ended": "key,relay",
  test: "bell,relay",
};

/**
 * One event as the local notification says it: the account's name and figures, the title and the
 * text. It is built from those alone, never from an Account, so a token, an email in the sign-in,
 * an account id or an org id has no way into a post.
 */
export interface RemoteNotice {
  event: RemoteEventName;
  accountName?: string;
  window?: LimitWindowKind;
  usedPercent?: number;
  resetsAt?: string;
  title: string;
  message: string;
}

/** The webhook body; a field an event lacks is null, so every post has the same shape. */
export interface WebhookPayload {
  event: RemoteEventName;
  account: { name: string } | null;
  window: LimitWindowKind | null;
  usedPercent: number | null;
  resetsAt: string | null;
  at: string;
  relayVersion: string;
}

export const REMOTE_NOTIFY_TIMEOUT_MS = 5_000;
/** The one retry's wait, after a network failure, a timeout, a 429 or a 5xx; a 4xx is final. */
export const REMOTE_NOTIFY_RETRY_MS = 3_000;
/** Posts waiting at once; beyond it an event is dropped, so a dead endpoint never piles requests up. */
const MAX_IN_FLIGHT = 4;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Text that may leave the computer: an account named after its email reads "[email]", an id
 * "[id]", and `redact` cuts keys, JWTs and long base64 or hex runs. One line, at most `max`.
 */
export function scrubRemoteText(text: string, max = 200): string {
  return redact(text.replace(EMAIL, "[email]").replace(UUID, "[id]"), max);
}

/** The JSON a webhook receives. */
export function webhookPayload(
  notice: RemoteNotice,
  at: Date,
  relayVersion: string,
): WebhookPayload {
  const reset = Date.parse(notice.resetsAt ?? "");
  const used = notice.usedPercent;
  return {
    event: notice.event,
    account: notice.accountName
      ? { name: scrubRemoteText(notice.accountName, 64) }
      : null,
    window: notice.window ?? null,
    // Rounded down, as every bar shows it: 99.6 reads 99, never 100.
    usedPercent:
      typeof used === "number" && Number.isFinite(used)
        ? Math.floor(Math.min(100, Math.max(0, used)))
        : null,
    resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null,
    at: at.toISOString(),
    relayVersion: scrubRemoteText(relayVersion, 40),
  };
}

/**
 * A header value fetch accepts: printable ASCII as it is, anything else (a Turkish or Japanese
 * title) RFC 2047 encoded, which ntfy decodes.
 */
function headerValue(text: string) {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

/** ntfy's publish request (https://docs.ntfy.sh/publish/): the text as the body, Title and Tags as headers. */
export function ntfyRequest(notice: RemoteNotice): {
  body: string;
  headers: Record<string, string>;
} {
  const title = scrubRemoteText(notice.title);
  const message = scrubRemoteText(notice.message, 1_000);
  return {
    body: message || title,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Title: headerValue(title),
      Tags: NTFY_TAGS[notice.event],
      ...(notice.event === "limit-near" ? { Priority: "high" } : {}),
    },
  };
}

export interface RemoteDeps {
  version: () => string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A failure, already redacted: never the URL, which may carry a private topic or a key. */
  log?: (line: string) => void;
  timeoutMs?: number;
  retryMs?: number;
}

/** Why a post failed, in words that never hold the URL or a secret from the answer. */
function failure(error: unknown, url: URL): string {
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "timeout";
  const cause =
    error instanceof Error
      ? (error.cause as { code?: unknown } | undefined)
      : undefined;
  const text =
    typeof cause?.code === "string"
      ? cause.code
      : error instanceof Error
        ? error.message
        : String(error);
  return scrubRemoteText(
    text.split(url.href).join("[url]").split(url.host).join("[host]"),
    120,
  );
}

/**
 * Posts one event to `target`, at most twice: a network failure, a timeout, a 429 or a 5xx is
 * tried once more after `retryMs`. Each try ends after `timeoutMs`; redirects are refused, so an
 * https URL never lands on plain http. Never throws: the outcome says what happened.
 */
export async function postRemoteNotice(
  target: { url?: string; kind: RemoteNotifyKind },
  notice: RemoteNotice,
  deps: RemoteDeps,
): Promise<RemoteNotifyResult> {
  if (!target.url?.trim()) return { ok: false, reason: "off" };
  const url = remoteNotifyUrl(target.url);
  if (!url) return { ok: false, reason: "invalid-url" };
  const request =
    target.kind === "ntfy"
      ? ntfyRequest(notice)
      : {
          body: JSON.stringify(
            webhookPayload(
              notice,
              new Date((deps.now ?? Date.now)()),
              deps.version(),
            ),
          ),
          headers: { "Content-Type": "application/json" },
        };
  const send = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? delay;
  let result: Extract<RemoteNotifyResult, { ok: false }> = {
    ok: false,
    reason: "failed",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await sleep(deps.retryMs ?? REMOTE_NOTIFY_RETRY_MS);
    try {
      const response = await send(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? REMOTE_NOTIFY_TIMEOUT_MS),
      });
      // The answer is never read: it may echo the topic or the body back.
      await response.body?.cancel().catch(() => {});
      if (response.ok) return { ok: true, status: response.status };
      result = {
        ok: false,
        reason: "failed",
        status: response.status,
        error: `HTTP ${response.status}`,
      };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      result = { ok: false, reason: "failed", error: failure(error, url) };
    }
  }
  // Only a failure is recorded: a post that arrived leaves no trace on disk.
  deps.log?.(`${target.kind} ${notice.event}: ${result.error ?? "failed"}`);
  return result;
}

/**
 * Relay's remote notifications: each event the local notifications tell is also posted when a
 * URL is saved and its event is on. A post runs in the background and never throws.
 */
export class RemoteNotifier {
  private inFlight = 0;
  constructor(
    private deps: RemoteDeps & {
      settings: () => Pick<RelaySettings, "remoteNotify">;
    },
  ) {}
  notify(notice: RemoteNotice): void {
    if (notice.event === "test") return;
    const settings = remoteNotifySettings(this.deps.settings());
    if (!settings.url || !settings.events[EVENT_CHOICE[notice.event]]) return;
    if (this.inFlight >= MAX_IN_FLIGHT) {
      this.deps.log?.(
        `${settings.kind} ${notice.event}: dropped, ${MAX_IN_FLIGHT} posts still waiting`,
      );
      return;
    }
    this.inFlight++;
    void postRemoteNotice(settings, notice, this.deps)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight--;
      });
  }
  /** Posts a sample "test" event to a URL that may not be saved yet, and says how it went. */
  test(
    target: { url: string; kind: RemoteNotifyKind },
    notice: Omit<RemoteNotice, "event">,
  ) {
    return postRemoteNotice(target, { ...notice, event: "test" }, this.deps);
  }
}
