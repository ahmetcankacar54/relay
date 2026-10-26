import fs from "node:fs";
import path from "node:path";
import type { AccountRemoved, DesktopState } from "../../shared/types";
import { writeBytes } from "./desktop-files";
import { acquireProfileLock } from "./profile-lock";
import type { Store } from "./store";

/** Why an account cannot be removed now: it is open in the Claude app, or its sign-in there is pending. */
export type RemovalBlock = "active" | "pending";

/** The Desktop facts the refusals read. */
type DesktopFacts = Pick<DesktopState, "activeProfileId" | "pendingProfileId">;

/** A removal refused by `removalBlock`; the CLI and the app each say it in their own words. */
export class AccountRemovalRefused extends Error {
  constructor(readonly reason: RemovalBlock) {
    super(
      reason === "active"
        ? "Switch the Claude app to another account before removing this one."
        : "Finish or cancel this account’s Claude app sign-in before removing it.",
    );
  }
}

/** What stops removing `accountId` while Desktop is as `state` says; undefined when nothing does. */
export function removalBlock(accountId: string, state: DesktopFacts): RemovalBlock | undefined {
  if (state.activeProfileId === accountId) return "active";
  if (state.pendingProfileId === accountId) return "pending";
  return undefined;
}

export interface AccountRemoval {
  store: Store;
  /** The sealed sign-ins (`desktop-vault`). */
  vault: string;
  /** The per-account profile locks, shared with Relay's other processes. */
  locks: string;
  /** Desktop read fresh: the refusals are checked again right before anything is deleted. */
  desktop: () => Promise<DesktopFacts>;
  /**
   * Signs the usage sign-in out in the profile (`claude auth logout`), resolving whether it did.
   * Missing when no Claude Code CLI was found.
   */
  signOut?: (profile: string) => Promise<boolean>;
}

/**
 * Forgets an account, for `relay remove` and the app alike. Refused (AccountRemovalRefused) for
 * the account open in the Claude app and one whose Claude app sign-in is pending, and while
 * anything holds its profile lock (ProfileLockBusyError). Under that lock it signs the usage
 * sign-in out, deletes the profile folder, the sealed Claude app sign-in, the Claude extension's
 * sign-in and the browser's claude.ai login kept for it (under either uuid the account has), and
 * drops it from the registry and the lists that name it. The Claude app's own data, the usage
 * history and the token ledger are left alone.
 */
export async function removeAccount(accountId: string, options: AccountRemoval): Promise<AccountRemoved> {
  const { store } = options;
  const account = store.account(accountId);
  const blocked = removalBlock(account.id, await options.desktop());
  if (blocked) throw new AccountRemovalRefused(blocked);
  const release = acquireProfileLock(options.locks, account.id, "exclusive");
  const result: AccountRemoved = {};
  try {
    const profile = store.profile(account.id);
    if (account.auth?.loggedIn) {
      result.signedOut = false;
      if (options.signOut)
        try {
          result.signedOut = await options.signOut(profile);
        } catch {
          // Said as not signed out: its Keychain item may remain.
        }
    }
    fs.rmSync(profile, { recursive: true, force: true });
    if (account.desktop)
      await writeBytes(options.vault, `accounts/${account.desktop.accountUuid.toLowerCase()}.bin`, null);
    // The Claude extension's saved sign-in and the browser's login go with the account.
    for (const uuid of new Set([account.desktop?.accountUuid, account.auth?.accountUuid]))
      if (uuid)
        for (const dir of ["extension", "extension-cookies"])
          await writeBytes(options.vault, `${dir}/${uuid.toLowerCase()}.bin`, null);
    store.update((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== account.id);
      s.settings.desktopHistoryAccounts = s.settings.desktopHistoryAccounts.filter((id) => id !== account.id);
      s.settings.autoSwitchAccounts = s.settings.autoSwitchAccounts.filter((id) => id !== account.id);
      s.settings.planning.accounts = s.settings.planning.accounts.filter((a) => a.id !== account.id);
    });
  } finally {
    release();
    fs.rmSync(path.join(options.locks, account.id), { recursive: true, force: true });
  }
  return result;
}
