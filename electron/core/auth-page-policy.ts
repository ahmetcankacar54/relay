/** Sites the Claude sign-in passes through: Anthropic's, and the identity providers claude.ai offers. */
const SIGN_IN_HOSTS = ["claude.ai", "claude.com", "anthropic.com"];
const PROVIDER_HOSTS = ["accounts.google.com", "appleid.apple.com"];

/** The CLI's localhost callback named by a sign-in page's `redirect_uri`; undefined when it is not one. */
export function localCallback(pageUrl: string): URL | undefined {
  try {
    const redirect = new URL(new URL(pageUrl).searchParams.get("redirect_uri") ?? "");
    return redirect.protocol === "http:" &&
      (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1")
      ? redirect
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether Relay's sign-in window may go to `url`: https on Anthropic's sites (and their
 * subdomains) or a sign-in provider's, or the exact localhost callback the CLI listens on.
 * Anything else opens in the system browser instead.
 */
export function signInNavigationAllowed(url: string, callback?: URL): boolean {
  try {
    const target = new URL(url);
    if (target.username || target.password) return false;
    if (target.protocol === "https:")
      return (
        SIGN_IN_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`)) ||
        PROVIDER_HOSTS.includes(target.hostname)
      );
    return (
      !!callback &&
      target.protocol === "http:" &&
      target.host === callback.host &&
      target.pathname === callback.pathname
    );
  } catch {
    return false;
  }
}

/** The session partition of an account's sign-in window; kept so a renewal needs one click. */
export const signInPartition = (accountId: string) => `persist:relay-auth-${accountId}`;
