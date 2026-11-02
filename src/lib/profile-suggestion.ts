import type { Account, CreateAccount } from "../../shared/types";

type T = (tr: string, en: string) => string;

/** The name a new profile gets before Relay knows whose it is: "Hesap 3". */
export function provisionalName(accounts: readonly Account[], t: T): string {
  const taken = new Set(accounts.map((a) => fold(a.name)));
  for (let n = accounts.length + 1; ; n++) {
    const name = t(`Hesap ${n}`, `Account ${n}`);
    if (!taken.has(fold(name))) return name;
  }
}

/** Whether a name is still the provisional one, in either language. */
export const isProvisionalName = (name: string) => /^(?:Hesap|Account) \d+$/.test(name.trim());

const fold = (name: string) => name.normalize("NFC").trim().replace(/[İIı]/g, "i").toLowerCase();

/** The group part of a work account's group ("work:<name>"), or "" for its own group. */
export function groupName(account: Pick<Account, "id" | "kind" | "group">): string {
  if (account.kind !== "work" || !account.group.startsWith("work:")) return "";
  const name = account.group.slice(5);
  return name === account.id ? "" : name;
}

/**
 * What to call a profile once its usage sign-in says whose it is: a Team or Enterprise seat is a
 * work account named and grouped after its organization; anything else is personal, named after
 * the email's local part. A name another profile has gets " 2", " 3"… Undefined until the
 * sign-in has an email.
 */
export function suggestProfile(account: Account, accounts: readonly Account[]): CreateAccount | undefined {
  const email = account.auth?.email ?? account.desktop?.email;
  if (!email) return undefined;
  const org = account.auth?.orgName?.trim().slice(0, 64);
  const seat = account.auth?.subscription?.toLowerCase() ?? "";
  const work = /team|enterprise/.test(seat);
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  const personalName = local ? local.replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase("tr")) : email;
  const base = (work && org ? org : personalName).slice(0, 60);
  const taken = new Set(accounts.filter((a) => a.id !== account.id).map((a) => fold(a.name)));
  let name = base;
  for (let n = 2; taken.has(fold(name)); n++) name = `${base} ${n}`;
  return work ? { name, kind: "work", ...(org ? { group: org } : {}) } : { name, kind: "personal" };
}
