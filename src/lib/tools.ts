import type { Account, AccountUsage, AntigravityAppState, ProxyStatus } from "../../shared/types";
import { limitHeadline, type LimitHeadline } from "../../shared/quota-windows";
import { freshUsage } from "../../shared/usage";

/** The tools Relay keeps working: the Claude app, the two terminal tools, and Google's Antigravity. */
export type ToolId = "claude-app" | "claude-code" | "codex" | "antigravity";

/**
 * How a tool stands now. `blocked`: the limit it uses is spent. `near`: 90 % or more. `off`: it
 * cannot run as set up (bound to a gateway that is off). `unknown`: Relay cannot tell which account
 * it uses or has no reading of it.
 */
export type ToolState = "ok" | "near" | "blocked" | "off" | "unknown";

export interface ToolRow {
  id: ToolId;
  /** The account the tool runs on now, when Relay knows it. */
  accountId?: string;
  /** How it reaches its account: the Claude app's own sign-in, the gateway, or its own sign-in. */
  via: "app" | "gateway" | "own";
  /** The limit that stops it first on that account (an Antigravity account's fullest model). */
  headline?: LimitHeadline;
  state: ToolState;
  /** The account to move to when this one is spent or nearly so: another of the same provider with room. */
  alternative?: { accountId: string; headline?: LimitHeadline };
  /** Antigravity is signed in with a Google account that Relay does not have. */
  foreign?: boolean;
}

const NEAR = 90;

const provider = (a: Account) => a.provider ?? "claude";

function stateOf(usage: AccountUsage | undefined, head: LimitHeadline | undefined, now: number): ToolState {
  if (!head || !freshUsage(usage, now)) return "unknown";
  return head.usedPercent >= 100 ? "blocked" : head.usedPercent >= NEAR ? "near" : "ok";
}

/**
 * The roomiest other account of a provider, for a tool whose account is spent or nearly: the one with
 * the most room on the limit that binds it. An Antigravity account is judged on the same model as the
 * spent one, since the other models were never the problem. None when no account has room.
 */
function alternativeFor(
  current: string | undefined,
  head: LimitHeadline | undefined,
  candidates: Account[],
  usage: Record<string, AccountUsage | undefined>,
  now: number,
): ToolRow["alternative"] {
  const ranked = candidates
    .filter((a) => a.id !== current && a.auth?.loggedIn !== false && freshUsage(usage[a.id], now))
    .map((a) => {
      const u = usage[a.id];
      const same = head?.model ? u?.modelWindows?.find((w) => w.key === head.key) : undefined;
      // A model whose reset has passed is empty again, whatever the reading says.
      const reset = Date.parse(same?.resetsAt ?? "");
      const used = same && Number.isFinite(reset) && reset <= now ? 0 : same?.usedPercent;
      const binding = same ? { key: same.key, label: same.label, usedPercent: used!, resetsAt: same.resetsAt, model: true } : limitHeadline(u, now);
      return { accountId: a.id, headline: binding };
    })
    .filter((x) => x.headline && x.headline.usedPercent < NEAR)
    .sort((a, b) => a.headline!.usedPercent - b.headline!.usedPercent);
  return ranked[0];
}

/** How long a request keeps telling which account a tool runs on; past it, the gateway's next pick does. */
const RECENT_MS = 30 * 60_000;

/**
 * The account a gateway tool runs on now: the one its latest request went to, while that request is
 * recent, else the one the gateway would pick next. The request log outlives restarts, so an old
 * entry must not name an account the gateway has left.
 */
function gatewayAccount(status: ProxyStatus, kind: "claude" | "codex", now: number): string | undefined {
  const last = status.recent?.find((r) => r.accountId && (r.provider ?? "claude") === kind);
  if (last && now - last.at <= RECENT_MS) return last.accountId;
  return status.nextPick?.[kind]?.accountId ?? last?.accountId;
}

/**
 * The Overview's and the panel's tool rows: each tool, the account it runs on, the limit that stops it
 * first, and the account to move to when that one is spent.
 *
 * - The Claude app runs on the account Relay switched it to (`active`).
 * - Claude Code and the Codex CLI run through the gateway when they are pointed at it: their account is
 *   the one the gateway sent their latest request to, else the one it would pick next. A Codex CLI on its
 *   own sign-in, with one Codex account, runs on that account.
 * - Antigravity talks to Google itself, on the Google account it signed in with (`antigravity`). It never
 *   passes through the gateway, so its alternative is a sign-in the user makes.
 */
export function toolRows(input: {
  accounts: Account[];
  usage: Record<string, AccountUsage | undefined>;
  active?: Account;
  /** The Claude app's suggestion, which the switch rules picked. */
  suggestion?: Account;
  proxy?: ProxyStatus;
  antigravity?: AntigravityAppState;
  now: number;
}): ToolRow[] {
  const { accounts, usage, active, suggestion, proxy, antigravity, now } = input;
  const rows: ToolRow[] = [];
  const of = (kind: string) => accounts.filter((a) => provider(a) === kind);
  const row = (
    id: ToolId,
    via: ToolRow["via"],
    accountId: string | undefined,
    alternatives: Account[],
    extra: Partial<ToolRow> = {},
    /** For a gateway tool: the account the gateway picks next, which is where it goes by itself. */
    next?: string,
  ) => {
    const u = accountId ? usage[accountId] : undefined;
    const headline = accountId ? limitHeadline(u, now) : undefined;
    const state = extra.state ?? (accountId ? stateOf(u, headline, now) : "unknown");
    const stuck = state === "blocked" || state === "near";
    const alternative = !stuck
      ? undefined
      : next !== undefined
        ? next !== accountId
          ? { accountId: next, headline: limitHeadline(usage[next], now) }
          : undefined
        : alternativeFor(accountId, headline, alternatives, usage, now);
    rows.push({ id, via, ...(accountId ? { accountId } : {}), ...(headline ? { headline } : {}), state, ...(alternative ? { alternative } : {}), ...extra });
  };
  const client = (id: string) => proxy?.clients?.find((c) => c.id === id);
  const bound = (id: string) => client(id)?.bound === true;

  if (active) {
    const u = usage[active.id];
    const headline = limitHeadline(u, now);
    const state = stateOf(u, headline, now);
    rows.push({
      id: "claude-app",
      via: "app",
      accountId: active.id,
      ...(headline ? { headline } : {}),
      state,
      // The switch rules already chose where the Claude app goes next.
      ...(suggestion ? { alternative: { accountId: suggestion.id, headline: limitHeadline(usage[suggestion.id], now) } } : {}),
    });
  }
  if (bound("claude-code")) {
    if (!proxy?.running) row("claude-code", "gateway", undefined, [], { state: "off" });
    else row("claude-code", "gateway", gatewayAccount(proxy, "claude", now), [], {}, proxy.nextPick?.claude?.accountId);
  }
  const codex = of("codex");
  // A Codex CLI the gateway saw is not installed has no row.
  if (codex.length && client("codex")?.installed !== false) {
    if (bound("codex")) {
      if (!proxy?.running) row("codex", "gateway", undefined, [], { state: "off" });
      else row("codex", "gateway", gatewayAccount(proxy, "codex", now), [], {}, proxy.nextPick?.codex?.accountId);
    } else row("codex", "own", codex.length === 1 ? codex[0].id : undefined, codex);
  }
  const google = of("antigravity");
  if (google.length && antigravity?.installed) {
    row("antigravity", "own", antigravity.accountId, google, antigravity.otherSignIn ? { foreign: true } : {});
  }
  return rows;
}

/** The first tool that is stopped and has somewhere to go, for the Overview's banner. */
export const blockedTool = (rows: ToolRow[]) => rows.find((r) => r.state === "blocked" && r.alternative);
