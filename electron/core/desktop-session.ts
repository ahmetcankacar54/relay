import { readCookieRows } from "./desktop-usage";

/**
 * Whether a copy of the Claude app's cookie files holds a claude.ai session.
 *
 * Claude's sign-in is two things: the account its `config.json` names, and the `sessionKey`
 * cookies in its cookie database. They part ways in two cases Relay must tell apart from a good
 * sign-in before it saves or restores one:
 *
 * - Chromium writes cookies to the file every 30 seconds. A Claude quit sooner after a sign-in
 *   leaves `config.json` naming the account and a cookie file without its session; saved like
 *   that, the account opens signed out at the next switch.
 * - claude.ai refuses a session (403) that was signed out elsewhere or ended. Claude then goes
 *   to /logout and drops the cookies, while `config.json` keeps naming the account.
 *
 * `unknown` when the database cannot be read here (no SQLite, a file caught mid-write, no
 * database at all): callers then do what they did before this check existed.
 */
export type SessionPresence = "present" | "absent" | "unknown";

const SESSION = /^sessionKey/;

export async function sessionPresence(
  files: Record<string, Buffer | null>,
): Promise<SessionPresence> {
  if (!files["Network/Cookies"] && !files.Cookies) return "unknown";
  try {
    const { rows } = await readCookieRows(files);
    return rows.some((row) => SESSION.test(row.name) && (row.encrypted.length > 0 || row.value))
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  }
}

/**
 * When a copy of the Claude app's cookie files stops holding a session (ms since the epoch): the
 * latest end of its `sessionKey` cookies. claude.ai renews them each time the login is used, so
 * a sign-in saved and left unused that long opens signed out when it is put back. Undefined when
 * that cannot be told (no session, cookies that last the app's run, an unreadable database).
 */
export async function sessionEndsMs(
  files: Record<string, Buffer | null>,
): Promise<number | undefined> {
  if (!files["Network/Cookies"] && !files.Cookies) return undefined;
  try {
    const { rows } = await readCookieRows(files);
    const sessions = rows.filter((row) => SESSION.test(row.name));
    if (!sessions.length || sessions.some((row) => row.expiresMs === undefined)) return undefined;
    return Math.max(...sessions.map((row) => row.expiresMs!));
  } catch {
    return undefined;
  }
}

/** Thrown before Claude is quit: its sign-in is not in the cookie file yet, so nothing was touched. */
export class SignInNotSettled extends Error {
  constructor() {
    super("Claude has not finished saving this sign-in yet. Relay tries again in a moment.");
    this.name = "SignInNotSettled";
  }
}

export const SIGN_IN_WITHOUT_SESSION =
  "This Claude sign-in holds no session, so it was not saved. Sign in to the Claude app again, wait half a minute, then save.";
export const CLAUDE_SIGNED_OUT =
  "The Claude app is signed out. Sign in to it first, then save.";
