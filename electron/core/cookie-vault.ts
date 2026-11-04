import fs from "node:fs/promises";
import path from "node:path";
import { readBytes, safeFile, writeBytes } from "./desktop-files";
import { decodeSnapshot, encodeSnapshot, loginId, type CookieSnapshot } from "./cookie-store";
import { isAccountUuid } from "../../shared/extension-auth";

/** Inside the vault, one sealed file per account: `extension-cookies/<account uuid>.bin`. */
const DIR = "extension-cookies";
/** The logins the extension could not sign in with, per account; not an account's file. */
const REJECTED = `${DIR}/rejected.bin`;

/** One account's rejected logins (`loginId`s), when the last was rejected, and whether it still waits. */
interface Rejection {
  logins: string[];
  at: string;
  /** No working sign-in of the account was seen since: the user still has to reconnect. */
  open: boolean;
}

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

  /**
   * Forgets the login saved for `accountUuid`: it was put in place and the extension could not
   * sign in to that account with it, so putting it back would only sign the extension out again.
   * Its identity is kept, so the same login is never saved for that account again (`isRejected`),
   * and the account waits for a reconnect (`waiting`).
   */
  async reject(accountUuid: string): Promise<void> {
    const account = accountUuid.toLowerCase();
    const saved = await this.load([account]).catch(() => undefined);
    const id = saved && loginId(saved);
    const all = await this.rejections();
    const before = all[account]?.logins ?? [];
    all[account] = {
      // The newest few are enough: a login is rejected once, and logins come seldom.
      logins: [...new Set([...before, ...(id ? [id] : [])])].slice(-20),
      at: new Date(this.now()).toISOString(),
      open: true,
    };
    await this.writeRejections(all);
    await writeBytes(this.vault, file(account), null);
  }

  /** Whether `snapshot` is a login the extension could not sign in to `accountUuid` with. */
  async isRejected(accountUuid: string, snapshot: CookieSnapshot): Promise<boolean> {
    const id = loginId(snapshot);
    if (!id) return false;
    return !!(await this.rejections())[accountUuid.toLowerCase()]?.logins.includes(id);
  }

  /** The account that still waits for a reconnect after a rejected login, the newest first. */
  async waiting(): Promise<{ accountUuid: string; at: string } | undefined> {
    const open = Object.entries(await this.rejections())
      .filter(([, r]) => r.open)
      .sort(([, a], [, b]) => Date.parse(b.at) - Date.parse(a.at));
    return open.length ? { accountUuid: open[0][0], at: open[0][1].at } : undefined;
  }

  /** The account signed in fine again: it waits no more; its rejected logins stay rejected. */
  async reconnected(accountUuid: string): Promise<void> {
    const all = await this.rejections();
    const entry = all[accountUuid.toLowerCase()];
    if (!entry?.open) return;
    entry.open = false;
    await this.writeRejections(all);
  }

  private async rejections(): Promise<Record<string, Rejection>> {
    const data = await readBytes(this.vault, REJECTED).catch(() => null);
    if (!data) return {};
    try {
      const value = JSON.parse(this.unseal(data))?.accounts;
      if (!value || typeof value !== "object") return {};
      const out: Record<string, Rejection> = {};
      for (const [uuid, r] of Object.entries(value as Record<string, Partial<Rejection>>))
        if (
          isAccountUuid(uuid) &&
          Array.isArray(r?.logins) &&
          r.logins.every((x) => typeof x === "string" && /^\d{1,20}$/.test(x)) &&
          typeof r.at === "string"
        )
          out[uuid.toLowerCase()] = { logins: r.logins, at: r.at, open: r.open === true };
      return out;
    } catch {
      return {};
    }
  }

  private async writeRejections(all: Record<string, Rejection>): Promise<void> {
    await writeBytes(this.vault, REJECTED, this.seal(JSON.stringify({ accounts: all })));
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
