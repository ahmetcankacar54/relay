// relay:// links, which the macOS widget opens. A link only ever opens Relay or
// its switch review; nothing reached through one switches by itself.

export const RELAY_SCHEME = "relay";

export type RelayLink =
  { kind: "open" } | { kind: "switch"; accountId: string };

const ACCOUNT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The widget's Geç button: Relay's switch review for this account. */
export function relaySwitchLink(accountId: string) {
  return `${RELAY_SCHEME}://switch?account=${encodeURIComponent(accountId)}`;
}

/**
 * Reads a relay:// link: `relay://switch?account=<id>` or `relay://open`.
 * Anything else, a malformed id, or a link carrying more than that is ignored
 * (undefined). With `accounts`, a switch link must also name one of them.
 */
export function parseRelayLink(
  url: unknown,
  accounts?: readonly { id: string }[],
): RelayLink | undefined {
  if (typeof url !== "string" || url.length > 512) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== `${RELAY_SCHEME}:` ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.hash
  )
    return undefined;
  const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
  if (path) return undefined;
  const params = [...parsed.searchParams.keys()];
  if (parsed.hostname === "open")
    return params.length ? undefined : { kind: "open" };
  if (parsed.hostname !== "switch") return undefined;
  const ids = parsed.searchParams.getAll("account");
  if (params.length !== 1 || ids.length !== 1) return undefined;
  const accountId = ids[0];
  if (!ACCOUNT_ID.test(accountId)) return undefined;
  if (accounts && !accounts.some((a) => a.id === accountId)) return undefined;
  return { kind: "switch", accountId };
}

/** A relay:// link among command-line arguments (Windows and Linux pass it there). */
export function relayLinkArgument(argv: readonly string[]) {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${RELAY_SCHEME}://`));
}

/**
 * The account a widget's switch request opens the review for: one of Relay's
 * accounts that is not already open in Claude; undefined otherwise.
 */
export function linkedSwitchAccount<A extends { id: string }>(
  accountId: string | undefined,
  accounts: readonly A[],
  activeId: string | undefined,
): A | undefined {
  if (!accountId || accountId === activeId) return undefined;
  return accounts.find((a) => a.id === accountId);
}
