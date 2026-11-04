import fs from "node:fs/promises";
import path from "node:path";
import { readBytes, safeFile, writeBytes } from "./desktop-files";
import { isAccountUuid, withoutFailure, type SignIn } from "../../shared/extension-auth";

/** Inside the vault, one sealed file per account: `extension/<account uuid>.bin`. */
const DIR = "extension";
/** Which account the extension was last on; not an account's file, so `list` skips it. */
const OWNER = `${DIR}/owner.bin`;
/** Present while a swap writes the profile's pair; left behind when Relay stopped in the middle. */
const SWAPPING = `${DIR}/swapping.bin`;

interface Saved {
  accountUuid: string;
  savedAt: string;
  signIn: SignIn;
}

const file = (accountUuid: string) => {
  if (!isAccountUuid(accountUuid)) throw new Error("Invalid account uuid.");
  return `${DIR}/${accountUuid.toLowerCase()}.bin`;
};

/**
 * The extension's sign-ins, sealed like the rest of the vault. Each is kept under the account
 * uuid the extension itself says it belongs to, so a copy can never be put in place for
 * another account.
 */
export class ExtensionVault {
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Keeps `signIn` as the account's (the account the extension named), replacing the one saved.
   * The extension's record of a failed sign-in is never kept (see `FAILURE_KEYS`).
   */
  async save(accountUuid: string, signIn: SignIn): Promise<void> {
    if (!isAccountUuid(accountUuid)) throw new Error("This sign-in names no account.");
    const saved: Saved = {
      accountUuid: accountUuid.toLowerCase(),
      savedAt: new Date(this.now()).toISOString(),
      signIn: withoutFailure(
        Object.fromEntries(Object.entries(signIn).filter(([, value]) => typeof value === "string")),
      ),
    };
    await writeBytes(this.vault, file(accountUuid), this.seal(JSON.stringify(saved)));
  }

  /**
   * The sign-in saved for the first of `accountUuids` that has one; undefined when none does.
   * Without the record of a failed sign-in, which Relay 0.14.1 and earlier kept too: put back, it made
   * the extension refuse browser tools on that account at every switch to it. Throws when a file
   * is damaged or sealed with another key, or names another account.
   */
  async load(accountUuids: string[]): Promise<SignIn | undefined> {
    for (const accountUuid of accountUuids) {
      const data = await readBytes(this.vault, file(accountUuid));
      if (!data) continue;
      const saved = JSON.parse(this.unseal(data)) as Saved;
      if (
        !saved.signIn ||
        typeof saved.signIn !== "object" ||
        saved.accountUuid !== accountUuid.toLowerCase()
      )
        throw new Error("Invalid saved extension sign-in.");
      return withoutFailure(saved.signIn);
    }
    return undefined;
  }

  /**
   * The account Relay last knew the extension to be on: the one it named, the one Relay put in
   * place, or the one the user said it was. Used when the extension's own data names no account.
   */
  async owner(): Promise<string | undefined> {
    const data = await readBytes(this.vault, OWNER);
    if (!data) return undefined;
    try {
      const value = JSON.parse(this.unseal(data))?.accountUuid;
      return isAccountUuid(value) ? value.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  }

  /** Written before a swap changes the profile's hints and cookies, and cleared once both are in place. */
  async markSwap(): Promise<void> {
    await writeBytes(this.vault, SWAPPING, Buffer.from(new Date().toISOString()));
  }
  async clearSwap(): Promise<void> {
    await writeBytes(this.vault, SWAPPING, null);
  }
  /** A swap stopped between its two writes: the profile's hints and cookies may name different accounts. */
  async swapInterrupted(): Promise<boolean> {
    return (await readBytes(this.vault, SWAPPING).catch(() => null)) !== null;
  }
  async setOwner(accountUuid: string): Promise<void> {
    if (!isAccountUuid(accountUuid)) return;
    await writeBytes(
      this.vault,
      OWNER,
      this.seal(JSON.stringify({ accountUuid: accountUuid.toLowerCase() })),
    );
  }

  /** When each account's sign-in was saved, from the files; nothing is opened. */
  async list(): Promise<{ accountUuid: string; savedAt: string }[]> {
    let dir: string;
    try {
      dir = await safeFile(this.vault, DIR);
    } catch {
      return [];
    }
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: { accountUuid: string; savedAt: string }[] = [];
    for (const name of names) {
      const id = name.replace(/\.bin$/, "");
      if (name === `${id}.bin` && isAccountUuid(id))
        try {
          const st = await fs.stat(path.join(dir, name));
          out.push({ accountUuid: id.toLowerCase(), savedAt: st.mtime.toISOString() });
        } catch {
          // Gone since the listing.
        }
    }
    return out;
  }
}
