import type { AccountProvider } from "./types";

/** The extension of an account backup file. */
export const BACKUP_EXTENSION = "relaybackup";

/** The shortest passphrase an export accepts: the file may hold sign-ins, and only the passphrase guards it. */
export const MIN_BACKUP_PASSPHRASE = 10;

/** How an import treats what is already here. */
export type BackupImportMode = "merge" | "replace";

/** What an export wrote; undefined from the call when the save dialog was cancelled. */
export interface BackupExportResult {
  accounts: number;
  /** Saved sign-ins written into the file; 0 when they were left out. */
  signIns: number;
}

/** A backup file picked for import, before its passphrase was given. */
export interface BackupFileChoice {
  /** The file's name, without its folder. */
  name: string;
}

/** One account the opened backup holds. */
export interface BackupSummaryAccount {
  name: string;
  provider: AccountProvider;
  /** Its sign-ins are in the file. */
  signIn: boolean;
  /** An account with this id, or this Claude app account, is already here: a merge skips it. */
  present: boolean;
}

/** What an opened backup holds, shown before the user picks merge or replace. */
export interface BackupSummary {
  createdAt: string;
  relayVersion: string;
  /** The `process.platform` it was made on. */
  platform: string;
  accounts: BackupSummaryAccount[];
  signIns: boolean;
  /** Accounts here now: what a replace takes out of the list. */
  currentAccounts: number;
}

/** What an import did. */
export interface BackupImportResult {
  mode: BackupImportMode;
  added: number;
  /** Accounts a merge left out: already here, or over the 50-account limit. */
  skipped: number;
  /** Sign-ins put back and sealed with this computer's key. */
  signIns: number;
  /** Sign-ins in the file that could not be put back. */
  signInsFailed: number;
  /** A replace first saves what was here, with the same passphrase: that file's name. */
  before?: string;
}
