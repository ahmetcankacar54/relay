import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeterWindow, MeterWindowName } from "../../../shared/meters";
import {
  MeterError,
  clampPercent,
  isoDate,
  num,
  plainLabel,
  requestJson,
  type Json,
  type MeterRead,
  type MeterReaderOptions,
} from "./common";

/**
 * Gemini CLI's daily quota, from Code Assist's `loadCodeAssist` (the tier and project) and
 * `retrieveUserQuota` (a bucket per model): the calls Gemini CLI's own `/stats` makes (CodexBar's
 * GeminiStatusProbe reads them the same way). It uses the access token Gemini CLI saved in
 * `~/.gemini/oauth_creds.json` while it is valid, and never renews it: renewing would need Gemini
 * CLI's own OAuth client, which Gemini CLI's FAQ forbids other software to use.
 *
 * Google ended Gemini CLI sign-ins for personal Google accounts (individual, AI Pro, Ultra) on
 * 2026-06-18; only Workspace, education and Code Assist Standard/Enterprise accounts still have a
 * quota here. Code Assist says so by listing the account's tiers as ineligible.
 */

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";
/** A token this close to its end is not sent. */
const EXPIRY_MARGIN_MS = 60_000;

const readJson = async (file: string): Promise<Json | undefined> => {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The saved access token, when Gemini CLI signs in with Google: `security.auth.selectedType`
 * (`selectedAuthType` in older settings) is `oauth-personal` or unset. An API key or Vertex AI has
 * no quota to read.
 */
export async function findGeminiToken(
  options: MeterReaderOptions = {},
): Promise<string> {
  const dir = path.join(options.home ?? os.homedir(), ".gemini");
  const settings = await readJson(path.join(dir, "settings.json"));
  const selected =
    settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
  if (typeof selected === "string" && selected !== "oauth-personal")
    throw new MeterError(
      "unsupported-auth",
      undefined,
      "gemini-cli: not a Google sign-in",
    );
  const creds = await readJson(path.join(dir, "oauth_creds.json"));
  const token = creds?.access_token;
  if (typeof token !== "string" || !token)
    throw new MeterError(
      "not-signed-in",
      undefined,
      "gemini-cli: no saved sign-in",
    );
  const expiry = num(creds?.expiry_date);
  if (
    expiry !== undefined &&
    expiry - (options.now ?? Date.now)() <= EXPIRY_MARGIN_MS
  )
    throw new MeterError("expired", undefined, "gemini-cli: token ended");
  return token;
}

/** The plan and project in a `loadCodeAssist` answer; refuses an account with no eligible tier. */
export function parseLoadCodeAssist(value: unknown): {
  label?: string;
  project?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MeterError(
      "unsupported",
      undefined,
      "gemini-cli: tier not an object",
    );
  const root = value as Json;
  const current =
    root.currentTier && typeof root.currentTier === "object"
      ? (root.currentTier as Json)
      : undefined;
  if (!current) {
    const ineligible =
      Array.isArray(root.ineligibleTiers) && root.ineligibleTiers.length > 0;
    throw new MeterError(
      ineligible ? "not-available" : "unsupported",
      undefined,
      "gemini-cli: no current tier",
    );
  }
  const paid =
    root.paidTier && typeof root.paidTier === "object"
      ? (root.paidTier as Json)
      : undefined;
  const label =
    plainLabel(paid?.name) ??
    plainLabel(current.name) ??
    plainLabel(current.id);
  const raw = root.cloudaicompanionProject;
  const project =
    typeof raw === "string"
      ? raw
      : raw && typeof raw === "object" && typeof raw.id === "string"
        ? raw.id
        : undefined;
  return {
    ...(label ? { label } : {}),
    ...(project && /^[\w.:-]{1,128}$/.test(project) ? { project } : {}),
  };
}

/** A model's family by name: flash-lite before flash, flash before pro. */
function family(modelId: string): MeterWindowName | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("flash-lite")) return "flash-lite";
  if (id.includes("flash")) return "flash";
  if (id.includes("pro")) return "pro";
  return undefined;
}

const FAMILY_ORDER: MeterWindowName[] = ["pro", "flash", "flash-lite"];

/**
 * The day's windows in a `retrieveUserQuota` answer: per model family the bucket with the least
 * left (`remainingFraction`, 0–1), as the share used.
 */
export function parseGeminiQuota(value: unknown): MeterWindow[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MeterError(
      "unsupported",
      undefined,
      "gemini-cli: quota not an object",
    );
  const buckets = Array.isArray((value as Json).buckets)
    ? ((value as Json).buckets as unknown[])
    : [];
  const least = new Map<
    MeterWindowName,
    { fraction: number; resetsAt?: string }
  >();
  for (const raw of buckets) {
    if (!raw || typeof raw !== "object") continue;
    const bucket = raw as Json;
    const name =
      typeof bucket.modelId === "string" ? family(bucket.modelId) : undefined;
    const fraction = num(bucket.remainingFraction);
    if (!name || fraction === undefined) continue;
    const known = least.get(name);
    if (!known || fraction < known.fraction) {
      const resetsAt = isoDate(bucket.resetTime);
      least.set(name, { fraction, ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  return FAMILY_ORDER.flatMap((name) => {
    const found = least.get(name);
    if (!found) return [];
    return [
      {
        name,
        kind: "daily" as const,
        unit: "requests" as const,
        usedPercent: clampPercent(100 - found.fraction * 100),
        ...(found.resetsAt ? { resetsAt: found.resetsAt } : {}),
      },
    ];
  });
}

/** A refusal that says the client or the account is not supported (a personal account since 2026-06-18). */
const notSupported = (text: string) =>
  /UNSUPPORTED_CLIENT|INELIGIBLE|not (?:supported|available|eligible)/i.test(
    text,
  );

/** Reads the day's quota of the Gemini CLI sign-in found on this computer. */
export async function readGeminiCli(
  options: MeterReaderOptions = {},
): Promise<MeterRead> {
  const token = await findGeminiToken(options);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const accept = (status: number) => status === 400 || status === 403;
  const tier = await requestJson(
    `${CODE_ASSIST}:loadCodeAssist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
      }),
    },
    "gemini-cli tier",
    { ...options, accept },
  );
  if (tier.status !== 200)
    throw new MeterError(
      notSupported(tier.text)
        ? "not-available"
        : tier.status === 403
          ? "expired"
          : "unsupported",
      undefined,
      `gemini-cli tier ${tier.status}`,
    );
  const { label, project } = parseLoadCodeAssist(tier.body);
  const quota = await requestJson(
    `${CODE_ASSIST}:retrieveUserQuota`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(project ? { project } : {}),
    },
    "gemini-cli quota",
    { ...options, accept },
  );
  if (quota.status !== 200)
    throw new MeterError(
      notSupported(quota.text) || quota.status === 403
        ? "not-available"
        : "unsupported",
      undefined,
      `gemini-cli quota ${quota.status}`,
    );
  return { ...(label ? { label } : {}), windows: parseGeminiQuota(quota.body) };
}
