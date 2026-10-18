import type { Account } from "../../shared/types";
import { authStatus, readProfileIdentity } from "./profile-identity";
import { command, profileEnvironment } from "./environment";

type Auth = NonNullable<Account["auth"]>;

/** What an account's auth becomes when its status cannot be read. */
export function signedOut(previous: Account["auth"], checkedAt = new Date().toISOString()): Auth {
  return {
    ...previous,
    loggedIn: false,
    checkedAt,
    error: "Giriş durumu doğrulanamadı. Hesabı yeniden bağla.",
  };
}

/**
 * Asks the official CLI, in the account's isolated profile, who is signed in there
 * (`claude auth status --json`), corroborated by the profile's own identity metadata. A
 * status that cannot be read means signed out, with the error the app shows.
 */
export async function readProfileAuth(
  executable: string,
  profile: string,
  previous: Account["auth"],
  now: () => string = () => new Date().toISOString(),
): Promise<Auth> {
  try {
    let stdout: string;
    try {
      stdout = (
        await command(
          executable,
          ["auth", "status", "--json"],
          profileEnvironment(profile),
          profile,
        )
      ).stdout;
    } catch (e: any) {
      if (typeof e.stdout !== "string" || !e.stdout.trim()) throw e;
      stdout = e.stdout;
    }
    return authStatus(
      JSON.parse(stdout),
      previous,
      await readProfileIdentity(profile),
      now(),
    );
  } catch {
    return signedOut(previous, now());
  }
}
