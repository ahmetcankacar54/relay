import type { Account } from "../../shared/types";
import { CliError, EXIT } from "./io";
import { translator } from "./i18n";
import type { T } from "../../shared/i18n/translate";

/** A name as the CLI compares it: NFC, trimmed, with İ, I and ı all as i, lowercase. */
export function foldName(name: string): string {
  return name.normalize("NFC").trim().replace(/[İIı]/g, "i").toLowerCase();
}

const english: T = translator("en");

/**
 * The account `query` names: its exact name, else the one name it begins, else the one id it
 * begins. No match, or several, is a usage error that lists the names.
 */
export function resolveAccount(
  accounts: Account[],
  query: string,
  t: T = english,
): Account {
  const q = foldName(query);
  const exact = accounts.filter((a) => foldName(a.name) === q);
  if (exact.length === 1) return exact[0];
  const pick = (found: Account[]) => {
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new CliError(
        t("accounts.matchesSeveralAccountsTypeMoreOf", { query, join: found.map((a) => a.name).join(", ") }),
        EXIT.usage,
      );
  };
  if (q) {
    const named = pick(
      exact.length ? exact : accounts.filter((a) => foldName(a.name).startsWith(q)),
    );
    if (named) return named;
    const byId = pick(accounts.filter((a) => a.id.toLowerCase().startsWith(q)));
    if (byId) return byId;
  }
  const names = accounts.map((a) => a.name).join(", ");
  throw new CliError(
    names
      ? t("accounts.noAccountNamedAccounts", { query, names })
      : t("accounts.noAccountsAreSavedYetAdd"),
    EXIT.usage,
  );
}

/** Refuses a name another account already has, compared folded. */
export function assertFreeName(
  accounts: Account[],
  name: string,
  t: T,
  except?: string,
): void {
  if (accounts.some((a) => a.id !== except && foldName(a.name) === foldName(name)))
    throw new CliError(
      t("accounts.anAccountNamedAlreadyExists", { name }),
      EXIT.usage,
    );
}
