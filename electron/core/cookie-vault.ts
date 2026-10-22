import fs from "node:fs/promises";
import path from "node:path";
import { readBytes, safeFile, writeBytes } from "./desktop-files";
import { decodeSnapshot, encodeSnapshot, type CookieSnapshot } from "./cookie-store";
import { isAccountUuid } from "../../shared/extension-auth";

/** Inside the vault, one sealed file per account: `extension-cookies/<account uuid>.bin`. */
const DIR = "extension-cookies";

const file = (accountUuid: string) => {
  if (!isAccountUuid(accountUuid)) throw new Error("Invalid account uuid.");
  return `${DIR}/${accountUuid.toLowerCase()}.bin`;
};

/**
 * The browser profile's claude.ai logins, one per account, sealed like the rest of the vault.
 * Each is kept under the account uuid the extension said it belonged to when it was saved, so a
 * login can never be put in place for another account. The cookie values stay encrypted by the
 * browser (its Keychain key): Relay never decrypts them.
 */
export class CookieVault {
  constructor(
    private readonly vault: string,
    private readonly seal: (text: string) => Buffer,
    private readonly unseal: (data: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps `snapshot` as the account's login, replacing the one saved. */
  async save(accountUuid: string, snapshot: CookieSnapshot): Promise<void> {
    if (!isAccountUuid(accountUuid)) throw new Error("This login names no account.");
    const record = {
      accountUuid: accountUuid.toLowerCase(),
      savedAt: new Date(this.now()).toISOString(),
      snapshot: encodeSnapshot(snapshot),
    };
    // Refuses rows that are not part of a login before anything is sealed.
    decodeSnapshot(record.snapshot);
    await writeBytes(this.vault, file(accountUuid), this.seal(JSON.stringify(record)));
  }

  /**
   * The login saved for the first of `accountUuids` that has one; undefined when none does.
   * Throws when a file is damaged, sealed with another key, names another account or holds rows
   * that are not a login.
   */
  async load(accountUuids: string[]): Promise<CookieSnapshot | undefined> {
    for (const accountUuid of accountUuids) {
      const data = await readBytes(this.vault, file(accountUuid));
      if (!data) continue;
      const record = JSON.parse(this.unseal(data)) as {
        accountUuid?: unknown;
        snapshot?: unknown;
      };
      if (record.accountUuid !== accountUuid.toLowerCase())
        throw new Error("Invalid saved claude.ai login.");
      return decodeSnapshot(record.snapshot);
    }
    return undefined;
  }

  /** When each account's login was saved, from the files; nothing is opened. */
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
