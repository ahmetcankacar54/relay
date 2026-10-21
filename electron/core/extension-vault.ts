import fs from "node:fs/promises";
import path from "node:path";
import { readBytes, safeFile, writeBytes } from "./desktop-files";
import {
  SIGN_IN_KEYS,
  isAccountUuid,
  signInAccount,
  type SignIn,
} from "../../shared/extension-auth";

/** Inside the vault, one sealed file per account: `extension/<account uuid>.bin`. */
const DIR = "extension";

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

  /** Keeps `signIn` as the account's, replacing the one saved. */
  async save(signIn: SignIn): Promise<void> {
    const accountUuid = signInAccount(signIn);
    if (!accountUuid) throw new Error("This sign-in names no account.");
    const saved: Saved = {
      accountUuid,
      savedAt: new Date(this.now()).toISOString(),
      signIn: Object.fromEntries(
        SIGN_IN_KEYS.filter((key) => key in signIn).map((key) => [key, signIn[key]]),
      ),
    };
    await writeBytes(this.vault, file(accountUuid), this.seal(JSON.stringify(saved)));
  }

  /**
   * The sign-in saved for the first of `accountUuids` that has one; undefined when none does.
   * Throws when a file is damaged or sealed with another key, or names another account.
   */
  async load(accountUuids: string[]): Promise<SignIn | undefined> {
    for (const accountUuid of accountUuids) {
      const data = await readBytes(this.vault, file(accountUuid));
      if (!data) continue;
      const saved = JSON.parse(this.unseal(data)) as Saved;
      if (
        !saved.signIn ||
        typeof saved.signIn !== "object" ||
        signInAccount(saved.signIn) !== accountUuid.toLowerCase()
      )
        throw new Error("Invalid saved extension sign-in.");
      return saved.signIn;
    }
    return undefined;
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
