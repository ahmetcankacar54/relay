import type { Account, AccountUsage, AntigravityAppState, ProxyStatus } from "../../shared/types";
import { limitHeadline, type LimitHeadline } from "../../shared/quota-windows";
import { freshUsage } from "../../shared/usage";
import { toolRows } from "./tools";

export type ProviderId = "claude" | "codex" | "antigravity";
export const PROVIDERS: ProviderId[] = ["claude", "codex", "antigravity"];

/**
 * One provider as the tray's tab and the pages' provider cards show it (variant A): its accounts,
 * the one in use now and how it is reached, and the limit that binds that one first.
 */
export interface ProviderView {
  id: ProviderId;
  accounts: Account[];
  /** The account in use: the Claude app's, the gateway's for Codex, the Antigravity app's. */
  current?: Account;
  via?: "app" | "gateway" | "own";
  head?: LimitHeadline;
  /** How the current account stands, for the tab's bar. */
  tone: "ok" | "warn" | "crit" | "none";
  /** The Antigravity app is signed in with a Google account Relay does not have. */
  foreign?: boolean;
}

/** The providers with at least one account, Claude first. */
export function providerViews(input: {
  accounts: Account[];
  usage: Record<string, AccountUsage | undefined>;
  active?: Account;
  proxy?: ProxyStatus;
  antigravity?: AntigravityAppState;
  now: number;
}): ProviderView[] {
  const { accounts, usage, active, proxy, antigravity, now } = input;
  const tools = toolRows({ accounts, usage, active, proxy, antigravity, now });
  return PROVIDERS.flatMap((id): ProviderView[] => {
    const own = accounts.filter((a) => (a.provider ?? "claude") === id);
    if (!own.length) return [];
    const tool = id === "claude" ? undefined : tools.find((r) => r.id === id);
    const currentId = id === "claude" ? active?.id : tool?.accountId;
    const current = own.find((a) => a.id === currentId);
    const u = current ? usage[current.id] : undefined;
    const head = current ? limitHeadline(u, now) : undefined;
    const tone: ProviderView["tone"] =
      !head || !freshUsage(u, now) ? "none" : head.usedPercent >= 90 ? "crit" : head.usedPercent >= 75 ? "warn" : "ok";
    return [
      {
        id,
        accounts: own,
        ...(current ? { current } : {}),
        // The Claude app and the Antigravity app run on their own sign-in; Codex through the gateway or its own.
        ...(id === "codex" ? (tool ? { via: tool.via } : {}) : current ? { via: "app" as const } : {}),
        ...(head ? { head } : {}),
        tone,
        ...(tool?.foreign ? { foreign: true } : {}),
      },
    ];
  });
}

/** The accounts in use now, one per provider at most: the Claude app's, the gateway's, the Antigravity app's. */
export const inUseIds = (views: ProviderView[]) => new Set(views.flatMap((v) => (v.current ? [v.current.id] : [])));
