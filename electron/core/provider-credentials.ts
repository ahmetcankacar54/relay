import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A Codex account's sign-in, kept in its Relay profile (mode 0600). An OpenAI API key never
 * expires on its own; a ChatGPT sign-in is an access token copied from the Codex CLI. Its
 * refresh token is never copied: two holders of one rotating refresh token log each other out.
 */
export interface CodexCredential {
  kind: "api-key" | "chatgpt";
  accessToken: string;
  /** ms; only a ChatGPT token has one. */
  expiresAt?: number;
  /** The ChatGPT account the token belongs to (`chatgpt_account_id`). */
  accountId?: string;
}

const FILE = "provider-credential.json";

export function decodeJwtPayload(token: string | undefined): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** The ms expiry an access token states about itself (`exp`), if it is a JWT. */
export function tokenExpiry(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

/** The ChatGPT account and plan an OpenAI token's claims name. */
export function chatgptClaims(token: string | undefined): {
  accountId?: string;
  plan?: string;
  email?: string;
} {
  const payload = decodeJwtPayload(token);
  const auth = payload?.["https://api.openai.com/auth"];
  const profile = payload?.["https://api.openai.com/profile"];
  const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return {
    accountId: str(auth?.chatgpt_account_id),
    plan: str(auth?.chatgpt_plan_type),
    email: str(payload?.email) ?? str(profile?.email),
  };
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCodexCredential(
  profileDir: string,
  credential: CodexCredential,
): Promise<void> {
  await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
  const target = path.join(profileDir, FILE);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify({ provider: "codex", ...credential }, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await fsp.rename(tmp, target);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Where the Codex CLI keeps its sign-in. */
export const codexAuthFiles = (home = os.homedir()) => [
  path.join(home, ".codex", "auth.json"),
  path.join(home, ".config", "codex", "auth.json"),
];

/** The Codex CLI's current ChatGPT access token and the account it belongs to, if signed in. */
export async function readCodexCliSession(
  files = codexAuthFiles(),
): Promise<{ accessToken: string; accountId?: string; email?: string; plan?: string } | undefined> {
  for (const file of files) {
    const auth = await readJson(file);
    if (!auth) continue;
    const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : undefined;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token : undefined;
    if (!accessToken) continue;
    const fromAccess = chatgptClaims(accessToken);
    const fromId = chatgptClaims(typeof tokens?.id_token === "string" ? tokens.id_token : undefined);
    const accountId =
      (typeof tokens?.account_id === "string" && tokens.account_id) ||
      fromAccess.accountId ||
      fromId.accountId;
    return {
      accessToken,
      ...(accountId ? { accountId } : {}),
      ...((fromId.email ?? fromAccess.email) ? { email: fromId.email ?? fromAccess.email } : {}),
      ...((fromId.plan ?? fromAccess.plan) ? { plan: fromId.plan ?? fromAccess.plan } : {}),
    };
  }
  return undefined;
}

/** An OpenAI API key the Codex CLI or the environment holds. */
export async function readOpenAiApiKey(
  files = codexAuthFiles(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const file of files) {
    const key = (await readJson(file))?.OPENAI_API_KEY;
    if (typeof key === "string" && key.trim()) return key.trim();
  }
  const key = env.OPENAI_API_KEY?.trim();
  return key || undefined;
}

/**
 * A Codex account's usable sign-in. For a ChatGPT sign-in, the Codex CLI's own token is used
 * while it is signed in to the same ChatGPT account (it keeps that token fresh); otherwise the
 * copy saved when the account was connected, until it expires. 0.18 builds saved the token in
 * `.credentials.json` under `claudeAiOauth`; that is still read.
 */
export async function readCodexCredential(
  profileDir: string,
  options: { now?: number; cliFiles?: string[] } = {},
): Promise<CodexCredential | undefined> {
  const now = options.now ?? Date.now();
  let saved: CodexCredential | undefined;
  const file = await readJson(path.join(profileDir, FILE));
  if (file && typeof file.accessToken === "string" && file.accessToken) {
    saved = {
      kind: file.kind === "api-key" ? "api-key" : "chatgpt",
      accessToken: file.accessToken,
      ...(typeof file.expiresAt === "number" ? { expiresAt: file.expiresAt } : {}),
      ...(typeof file.accountId === "string" ? { accountId: file.accountId } : {}),
    };
  } else {
    const legacy = (await readJson(path.join(profileDir, ".credentials.json")))?.claudeAiOauth;
    const token = typeof legacy?.accessToken === "string" ? legacy.accessToken : undefined;
    if (token) {
      const apiKey = token.startsWith("sk-");
      const expiresAt = apiKey ? undefined : tokenExpiry(token);
      const accountId = apiKey ? undefined : chatgptClaims(token).accountId;
      saved = {
        kind: apiKey ? "api-key" : "chatgpt",
        accessToken: token,
        ...(expiresAt ? { expiresAt } : {}),
        ...(accountId ? { accountId } : {}),
      };
    }
  }
  if (!saved) return undefined;
  if (saved.kind === "api-key") return saved;
  if (saved.accountId) {
    const live = await readCodexCliSession(options.cliFiles);
    if (live && live.accountId === saved.accountId) {
      const expiresAt = tokenExpiry(live.accessToken);
      if (expiresAt === undefined || expiresAt > now)
        return { ...saved, accessToken: live.accessToken, ...(expiresAt ? { expiresAt } : {}) };
    }
  }
  return saved.expiresAt !== undefined && saved.expiresAt <= now ? undefined : saved;
}
