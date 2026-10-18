import type { Account } from "../../shared/types";
import { CliError, EXIT } from "./io";
import type { Translate } from "./i18n";

/** A name as the CLI compares it: NFC, trimmed, with İ, I and ı all as i, lowercase. */
export function foldName(name: string): string {
  return name.normalize("NFC").trim().replace(/[İIı]/g, "i").toLowerCase();
}

const english: Translate = (_tr, en) => en;

/**
 * The account `query` names: its exact name, else the one name it begins, else the one id it
 * begins. No match, or several, is a usage error that lists the names.
 */
export function resolveAccount(
  accounts: Account[],
  query: string,
  t: Translate = english,
): Account {
  const q = foldName(query);
  const exact = accounts.filter((a) => foldName(a.name) === q);
  if (exact.length === 1) return exact[0];
  const pick = (found: Account[]) => {
    if (found.length === 1) return found[0];
    if (found.length > 1)
      throw new CliError(
        t(
          `“${query}” birden çok hesaba uyuyor: ${found.map((a) => a.name).join(", ")}. Adın devamını ya da kimliğin başını yazın.`,
          `“${query}” matches several accounts: ${found.map((a) => a.name).join(", ")}. Type more of the name, or the start of its id.`,
        ),
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
      ? t(`“${query}” adlı bir hesap yok. Hesaplar: ${names}.`, `No account named “${query}”. Accounts: ${names}.`)
      : t("Henüz kayıtlı hesap yok. İlkini relay add <ad> ile ekleyin.", "No accounts are saved yet. Add the first with relay add <name>."),
    EXIT.usage,
  );
}

/** Refuses a name another account already has, compared folded. */
export function assertFreeName(
  accounts: Account[],
  name: string,
  t: Translate,
  except?: string,
): void {
  if (accounts.some((a) => a.id !== except && foldName(a.name) === foldName(name)))
    throw new CliError(
      t(`“${name}” adlı bir hesap zaten var.`, `An account named “${name}” already exists.`),
      EXIT.usage,
    );
}
