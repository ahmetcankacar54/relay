import type { ParsedCommand } from "./args";
import type { CliDeps } from "./deps";
import type { Locale } from "../../shared/i18n/locales";
import type { T } from "../../shared/i18n/translate";
import type { CliIO } from "./io";

/** What a command is called with; it opens its own context with the needs it has. */
export interface CommandRun {
  io: CliIO;
  deps: Partial<CliDeps>;
  parsed: ParsedCommand;
  t: T;
  lang: Locale;
  /** The arguments as given, for a command handed to a worker. */
  argv: string[];
}
export type Command = (run: CommandRun) => Promise<number>;
