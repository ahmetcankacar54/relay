import type { ParsedCommand } from "./args";
import type { CliDeps } from "./deps";
import type { Lang, Translate } from "./i18n";
import type { CliIO } from "./io";

/** What a command is called with; it opens its own context with the needs it has. */
export interface CommandRun {
  io: CliIO;
  deps: Partial<CliDeps>;
  parsed: ParsedCommand;
  t: Translate;
  lang: Lang;
  /** The arguments as given, for a command handed to a worker. */
  argv: string[];
}
export type Command = (run: CommandRun) => Promise<number>;
