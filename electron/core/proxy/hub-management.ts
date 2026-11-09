import type { Account } from "../../../shared/types";

/**
 * The CLIProxyAPI management calls that usage dashboards make of a "hub" (T3 Code's Usage
 * providers → CLI Proxy): list the accounts, read an account's usage through its own sign-in,
 * and clear a cooldown. Relay answers them for the gateway's pool.
 *
 * `api-call` asks the hub to send a request with the account's token put in place of `$TOKEN$`.
 * Answered as asked, that would hand a token to any address; Relay sends only the provider's own
 * usage and reset-credit requests, with only the headers those need.
 */

export const HUB_PREFIX = "/v0/management/";

/** What each provider's token may be sent to, by method. */
const ALLOWED: Record<"claude" | "codex", { method: "GET" | "POST"; url: string }[]> = {
  claude: [{ method: "GET", url: "https://api.anthropic.com/api/oauth/usage" }],
  codex: [
    { method: "GET", url: "https://chatgpt.com/backend-api/wham/usage" },
    { method: "GET", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits" },
    { method: "POST", url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume" },
  ],
};

/** Headers passed on, by lower-case name; anything else is dropped. */
const PASSED_HEADERS = new Set([
  "authorization",
  "content-type",
  "openai-beta",
  "originator",
  "chatgpt-account-id",
  "anthropic-beta",
  "user-agent",
]);

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const TIMEOUT_MS = 15_000;

export interface HubDeps {
  /** The accounts the gateway may route to. */
  accounts: () => readonly Account[];
  /** The account's token, as the gateway would send it; undefined when it has none. */
  credential: (account: Account) => Promise<string | undefined>;
  /** Clears the gateway's own cooldown for the account. */
  clearCooldown: (accountId: string) => void;
  fetch?: typeof fetch;
}

export interface HubAnswer {
  status: number;
  body: unknown;
}

type HubProvider = "claude" | "codex";
const hubProvider = (account: Account): HubProvider | undefined => {
  const provider = account.provider ?? "claude";
  if (provider === "claude") return account.auth?.loggedIn ? "claude" : undefined;
  // Only a ChatGPT sign-in has the usage endpoints; an OpenAI API key has none.
  if (provider === "codex") return account.auth?.loggedIn && account.auth.accountUuid ? "codex" : undefined;
  return undefined;
};

/** `auth-files`: the pool's Claude and Codex accounts in CLIProxyAPI's shape. */
export function authFiles(accounts: readonly Account[]) {
  return {
    files: accounts.flatMap((account) => {
      const provider = hubProvider(account);
      if (!provider) return [];
      return [
        {
          id: account.id,
          auth_index: account.id,
          provider,
          label: account.name,
          ...(account.auth?.email ? { email: account.auth.email } : {}),
          disabled: false,
          ...(provider === "codex"
            ? {
                id_token: {
                  chatgpt_account_id: account.auth!.accountUuid,
                  ...(account.auth?.subscription ? { plan_type: account.auth.subscription.toLowerCase() } : {}),
                },
              }
            : {}),
        },
      ];
    }),
  };
}

const error = (status: number, message: string): HubAnswer => ({ status, body: { error: message } });

/** `api-call`: one allowed request with the account's own token, answered as `{status_code, body}`. */
export async function apiCall(input: unknown, deps: HubDeps): Promise<HubAnswer> {
  if (!input || typeof input !== "object") return error(400, "invalid body");
  const { auth_index, method, url, header, data } = input as Record<string, unknown>;
  if (typeof auth_index !== "string" || typeof url !== "string") return error(400, "missing auth_index or url");
  const verb = method === undefined ? "GET" : method;
  if (verb !== "GET" && verb !== "POST") return error(400, "unsupported method");
  const account = deps.accounts().find((a) => a.id === auth_index);
  const provider = account && hubProvider(account);
  if (!account || !provider) return error(404, "unknown account");
  if (!ALLOWED[provider].some((allowed) => allowed.method === verb && allowed.url === url))
    return error(403, "Relay only sends an account's token to its provider's usage requests");
  if (data !== undefined && (typeof data !== "string" || data.length > MAX_DATA_BYTES))
    return error(400, "invalid data");
  const token = await deps.credential(account).catch(() => undefined);
  // A ChatGPT usage request needs the sign-in's token; an API key would only be refused.
  if (!token || (provider === "codex" && token.startsWith("sk-")))
    return { status: 200, body: { status_code: 401, body: "" } };
  const headers: Record<string, string> = {};
  if (header && typeof header === "object")
    for (const [name, value] of Object.entries(header as Record<string, unknown>))
      if (typeof value === "string" && PASSED_HEADERS.has(name.toLowerCase()))
        headers[name] = value.replaceAll("$TOKEN$", token);
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization"))
    headers.Authorization = `Bearer ${token}`;
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: verb,
      headers,
      ...(verb === "POST" && typeof data === "string" ? { body: data } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    return {
      status: 200,
      body: { status_code: response.status, body: text.length > MAX_RESPONSE_BYTES ? "" : text },
    };
  } catch {
    return { status: 200, body: { status_code: 502, body: "" } };
  }
}

/** `reset-quota`: the account may be picked again at once. */
export function resetQuota(input: unknown, deps: HubDeps): HubAnswer {
  const index = input && typeof input === "object" ? (input as Record<string, unknown>).auth_index : undefined;
  if (typeof index !== "string" || !deps.accounts().some((a) => a.id === index)) return error(404, "unknown account");
  deps.clearCooldown(index);
  return { status: 200, body: { status: "ok" } };
}

/** Routes one management call; undefined when the path is not one Relay answers. */
export async function hubManagement(
  method: string,
  path: string,
  body: unknown,
  deps: HubDeps,
): Promise<HubAnswer | undefined> {
  const call = path.slice(HUB_PREFIX.length);
  if (method === "GET" && call === "auth-files") return { status: 200, body: authFiles(deps.accounts()) };
  if (method === "POST" && call === "api-call") return apiCall(body, deps);
  if (method === "POST" && call === "reset-quota") return resetQuota(body, deps);
  return undefined;
}
