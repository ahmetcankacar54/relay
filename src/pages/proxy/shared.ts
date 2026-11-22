import type { useRelay } from "@/data/relay-context";
import type { ProxyAccountStatus, ProxyClientId } from "../../../shared/types";

export type Patch = Parameters<ReturnType<typeof useRelay>["api"]["proxyConfigure"]>[0];

export const CLIENT_NAMES: Record<ProxyClientId, string> = { "claude-code": "Claude Code", codex: "Codex CLI", omp: "omp" };
/** The provider whose accounts answer a client's requests. */
const CLIENT_PROVIDERS: Record<ProxyClientId, readonly ("claude" | "codex")[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  omp: ["claude", "codex"],
};
export const PROVIDER_NAMES: Record<"claude" | "codex", string> = { claude: "Claude", codex: "Codex" };
/** The provider an "add an account" link opens for a client: its first. */
export const CLIENT_PROVIDER = (id: ProxyClientId) => CLIENT_PROVIDERS[id][0];
/** "Claude" or "Claude / Codex": whose accounts answer the client. */
export const providerName = (id: ProxyClientId) => CLIENT_PROVIDERS[id].map((p) => PROVIDER_NAMES[p]).join(" / ");

/**
 * How many accounts could answer this client now: in the pool, signed in, of its provider.
 * A client bound with none would only get "no account" errors.
 */
export const usableFor = (accounts: readonly ProxyAccountStatus[], id: ProxyClientId) =>
  accounts.filter((a) => a.inPool && a.signedIn && CLIENT_PROVIDERS[id].includes((a.provider ?? "claude") as "claude" | "codex")).length;

/** The providers of a client with no usable account: its requests to them fail (omp has two). */
export const missingFor = (accounts: readonly ProxyAccountStatus[], id: ProxyClientId) =>
  CLIENT_PROVIDERS[id].filter((p) => !accounts.some((a) => a.inPool && a.signedIn && (a.provider ?? "claude") === p));
