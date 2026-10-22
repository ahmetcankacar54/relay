/**
 * The extension keeps its sign-in in `chrome.storage.local`, a LevelDB whose values are JSON
 * text. Its key names are not known for certain (the first guess, accountUuid / accessToken /
 * refreshToken / tokenExpiry, matched nothing in extension 1.0.101 on 2026-10-22), so the
 * sign-in is found without them:
 *
 * - it is signed in when some value holds a token (a key named like one, or a value holding
 *   one, nested or not);
 * - the account is the one of Relay's account uuids a value names;
 * - the sign-in is every key that looks like part of it (by name or by holding a token) and
 *   every key naming that account. Nothing else is read into the vault or written back.
 */

/** A sign-in: each key's value as the extension stored it (JSON text). */
export type SignIn = Record<string, string>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAccountUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/** A key that names part of a sign-in. */
const SIGN_IN_NAME =
  /token|auth|account|user|session|oauth|credential|login|expir|refresh|identity|organi[sz]ation|\borg/i;
/** A key whose name says it holds a token. */
const TOKEN_NAME = /token|credential|oauth/i;
/** A value holding a token, nested or not: a token field, or a Claude OAuth token itself. */
const TOKEN_VALUE =
  /"(?:access|refresh|id)_?token"\s*:\s*"[^"]{8,}|sk-ant-[a-z]{2,4}\d{0,2}-[A-Za-z0-9_-]{8,}/i;
/** Values that hold nothing. */
const EMPTY = new Set(["", "null", "undefined", "false", "true", "0", '""', "{}", "[]"]);

const filled = (value: string) => !EMPTY.has(value.trim()) && value.trim().length >= 12;

/** Whether this entry is part of a sign-in, by its name or by holding a token. */
export function isSignInEntry(key: string, value: string): boolean {
  return SIGN_IN_NAME.test(key) || TOKEN_VALUE.test(value);
}

/** Whether the stored entries hold a token: someone is signed in. */
export function holdsToken(entries: Iterable<readonly [string, string]>): boolean {
  for (const [key, value] of entries)
    if (TOKEN_VALUE.test(value) || (TOKEN_NAME.test(key) && filled(value))) return true;
  return false;
}

/**
 * Which of `known` (account uuids) the entries name. When several are named, the one in a key
 * named like an account or a user wins; still several, none (it cannot be told).
 */
export function namedAccount(
  entries: Iterable<readonly [string, string]>,
  known: string[],
): string | undefined {
  const wanted = [...new Set(known.map((k) => k.toLowerCase()).filter(isAccountUuid))];
  const anywhere = new Set<string>();
  const named = new Set<string>();
  for (const [key, value] of entries) {
    const text = value.toLowerCase();
    for (const uuid of wanted)
      if (text.includes(uuid)) {
        anywhere.add(uuid);
        if (/account|user|identity|profile|\bme\b/i.test(key)) named.add(uuid);
      }
  }
  if (anywhere.size === 1) return [...anywhere][0];
  if (named.size === 1) return [...named][0];
  return undefined;
}

const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ACCOUNT_FIELD =
  /"(?:account|user)[_-]?(?:uuid|id)"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/**
 * Whether the entries name, as an account, a uuid that is none of `known`: a key named like an
 * account or a user holding one, or an account / user id field. Such a sign-in is someone
 * else's and is never taken for the account Relay last put in place.
 */
export function namesOtherAccount(
  entries: Iterable<readonly [string, string]>,
  known: string[],
): boolean {
  const mine = new Set(known.map((k) => k.toLowerCase()));
  for (const [key, value] of entries) {
    const found = /account|user/i.test(key)
      ? [...value.matchAll(UUID_IN)].map((m) => m[0])
      : [...value.matchAll(ACCOUNT_FIELD)].map((m) => m[1]);
    if (found.some((uuid) => !mine.has(uuid.toLowerCase()))) return true;
  }
  return false;
}

/**
 * The sign-in among stored entries, and the account it belongs to when it is one of `known`.
 * `undefined` is "not signed in". A sign-in without `account` belongs to an account Relay does
 * not have (`other`, when the data names one) or one it cannot tell.
 */
export function pickSignIn(
  entries: Iterable<readonly [string, string | undefined]>,
  known: string[],
): { signIn: SignIn; account?: string; other?: true } | undefined {
  const all = [...entries].filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  if (!holdsToken(all)) return undefined;
  const account = namedAccount(all, known);
  const signIn: SignIn = {};
  for (const [key, value] of all)
    if (isSignInEntry(key, value) || (account && value.toLowerCase().includes(account)))
      signIn[key] = value;
  return {
    signIn,
    ...(account ? { account } : namesOtherAccount(all, known) ? { other: true as const } : {}),
  };
}

export function sameSignIn(a: SignIn, b: SignIn): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => key in b && a[key] === b[key])
  );
}
