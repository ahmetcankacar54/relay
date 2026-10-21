/**
 * The extension keeps its sign-in in `chrome.storage.local`, a LevelDB whose values are JSON
 * text. These are the keys of that sign-in; Relay reads and writes no others. Names as seen in
 * extension 1.0.101; when the extension renames them the step finds no sign-in and writes
 * nothing.
 */
export const ACCOUNT_KEY = "accountUuid";
export const TOKEN_KEYS = ["accessToken", "refreshToken", "tokenExpiry"] as const;
export const SIGN_IN_KEYS: readonly string[] = [ACCOUNT_KEY, ...TOKEN_KEYS];

/** A sign-in: each key's value as the extension stored it (JSON text). */
export type SignIn = Record<string, string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAccountUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** The string a stored value holds, `undefined` for anything else. */
function storedString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The account a sign-in belongs to, lower case; `undefined` when it holds no valid uuid. */
export function signInAccount(signIn: SignIn): string | undefined {
  const value = storedString(signIn[ACCOUNT_KEY]);
  return value && UUID.test(value) ? value.toLowerCase() : undefined;
}

/**
 * The sign-in among stored entries: the sign-in keys, kept only when they name an account and
 * hold a token. `undefined` is "not signed in" (or a layout Relay does not know).
 */
export function pickSignIn(
  entries: Iterable<readonly [string, string | undefined]>,
): SignIn | undefined {
  const signIn: SignIn = {};
  for (const [key, value] of entries)
    if (SIGN_IN_KEYS.includes(key) && value !== undefined) signIn[key] = value;
  if (!signInAccount(signIn)) return undefined;
  if (!TOKEN_KEYS.some((key) => storedString(signIn[key]) !== undefined))
    return undefined;
  return signIn;
}

export function sameSignIn(a: SignIn, b: SignIn): boolean {
  return SIGN_IN_KEYS.every((key) => a[key] === b[key]);
}
