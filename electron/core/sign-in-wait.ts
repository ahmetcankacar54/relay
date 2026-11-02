import type { Account, DesktopState } from "../../shared/types";

/**
 * Where a Claude app sign-in for `accountId` stands, from one Desktop reading:
 * - "ready": an account is signed in that can be saved into `accountId` (a new one, or the same
 *   one again while its own sign-in is pending), and Code has a workspace for it;
 * - "waiting": nobody new is signed in yet, or Code has not been opened;
 * - "saved-elsewhere": the account signed in is already saved in another profile;
 * - "done": `accountId` already holds it and nothing is pending;
 * - "other-pending": a sign-in for another profile is pending.
 * Shared by `relay add` and Relay.app's automatic save.
 */
export type SignInReading =
  | { kind: "ready"; accountUuid: string; orgs: string[] }
  | { kind: "waiting" }
  | { kind: "saved-elsewhere"; account: Account }
  | { kind: "done" }
  | { kind: "other-pending" };

export function readSignIn(
  state: Pick<DesktopState, "currentAccountUuid" | "organizations" | "pendingProfileId">,
  accounts: readonly Account[],
  accountId: string,
): SignInReading {
  const pending = state.pendingProfileId;
  if (pending && pending !== accountId) return { kind: "other-pending" };
  const uuid = state.currentAccountUuid;
  if (!uuid) return { kind: "waiting" };
  const saved = accounts.find((a) => a.desktop?.accountUuid === uuid);
  if (saved && saved.id !== accountId) return { kind: "saved-elsewhere", account: saved };
  // The profile's own account again: done, unless its renewed sign-in waits to be saved.
  if (saved && !pending) return { kind: "done" };
  return state.organizations.length
    ? { kind: "ready", accountUuid: uuid, orgs: state.organizations }
    : { kind: "waiting" };
}
