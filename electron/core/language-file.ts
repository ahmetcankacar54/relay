import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parsePref, type LanguagePref } from "../../shared/i18n/locales";

/**
 * The app's language choice, in its own file beside state.json (`language.json`, `{ "pref": … }`),
 * so a language never changes the registry's schema that older builds and the CLI read.
 */
export const LANGUAGE_FILE = "language.json";

/** The saved choice; undefined when the file is missing or holds no valid choice. */
export function readLanguagePref(dir: string): LanguagePref | undefined {
  try {
    return parsePref(JSON.parse(fs.readFileSync(path.join(dir, LANGUAGE_FILE), "utf8"))?.pref);
  } catch {
    return undefined;
  }
}

/** Saves the choice atomically, readable only by the user. */
export function writeLanguagePref(dir: string, pref: LanguagePref) {
  const file = path.join(dir, LANGUAGE_FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ pref })}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The saved choice, or on first start the migration's: installs from before the setting saw
 * Turkish, so they keep it; new ones follow the system. The migration's choice is saved.
 */
export function loadLanguagePref(dir: string, hasAccounts: boolean): LanguagePref {
  const saved = readLanguagePref(dir);
  if (saved) return saved;
  const pref: LanguagePref = hasAccounts ? "tr" : "system";
  try {
    writeLanguagePref(dir, pref);
  } catch {
    // An unwritable folder still gets the language for this run; the next start tries again.
  }
  return pref;
}
