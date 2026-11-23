import type { MeterIssue, MeterReading } from "../../../shared/meters";
import { retryTime } from "../usage";

/**
 * A meter read that failed, as the issue the Overview row says. `detail` is for the private log
 * only: a step and an HTTP status, never a token or a response body.
 */
export class MeterError extends Error {
  constructor(
    readonly issue: MeterIssue,
    readonly retryAt?: number,
    readonly detail?: string,
  ) {
    super(issue);
    this.name = "MeterError";
  }
}

/** What a reader gives back: everything of the reading but when and where it was read. */
export type MeterRead = Pick<MeterReading, "label" | "windows">;

export interface MeterReaderOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** The home folder the tools' files are found under; tests point it at a temporary folder. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type Json = Record<string, any>;

const MAX_BODY = 512 * 1024;

/**
 * One refused answer, as the issue it means: a 401 or 403 is a sign-in the provider no longer
 * takes, unless the reader tells a 403 apart itself (`accept`).
 */
function refusal(
  status: number,
  retryAfter: string | null,
  label: string,
  now: number,
): MeterError {
  const detail = `${label} ${status}`;
  if (status === 401 || status === 403)
    return new MeterError("expired", undefined, detail);
  if (status === 429)
    return new MeterError("rate-limited", retryTime(retryAfter, now), detail);
  return new MeterError("unavailable", undefined, detail);
}

export interface JsonAnswer {
  status: number;
  body: unknown;
  /** The raw text of a refused answer, for readers that tell refusals apart by what they say. */
  text: string;
}

/**
 * One request with a 15 s timeout and no redirects (a redirect would carry the token elsewhere).
 * Answers anything but 200 as `refusal` says unless `accept` takes that status, and refuses a body
 * that is too large or not JSON.
 */
export async function requestJson(
  url: string,
  init: {
    method?: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
  },
  label: string,
  options: MeterReaderOptions & { accept?: (status: number) => boolean } = {},
): Promise<JsonAnswer> {
  const now = (options.now ?? Date.now)();
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: init.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  } catch {
    throw new MeterError("unavailable", undefined, `${label}: no answer`);
  }
  const text = await response.text().catch(() => "");
  if (response.status !== 200 && !options.accept?.(response.status))
    throw refusal(
      response.status,
      response.headers.get("retry-after"),
      label,
      now,
    );
  if (text.length > MAX_BODY)
    throw new MeterError("unsupported", undefined, `${label} too large`);
  if (response.status !== 200)
    return { status: response.status, body: undefined, text };
  try {
    return { status: 200, body: JSON.parse(text), text: "" };
  } catch {
    throw new MeterError("unsupported", undefined, `${label} not JSON`);
  }
}

/** A finite number, or undefined. */
export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A share in 0–100. */
export const clampPercent = (value: number) =>
  Math.min(100, Math.max(0, value));

/** A date as ISO text, from ISO text or a bare `YYYY-MM-DD` (read as UTC midnight). */
export function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return;
  const ms = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
  );
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** A plan or login name fit to show: short and printable, else nothing. */
export function plainLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const text = value.trim();
  return text && text.length <= 40 && /^[\p{L}\p{N} ._@+-]+$/u.test(text)
    ? text
    : undefined;
}
