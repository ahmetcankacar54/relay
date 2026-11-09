import { parseArgs } from "node:util";
import { CliError, EXIT } from "./io";

export type Flags = Record<string, string | boolean | undefined>;
export interface ParsedCommand {
  command: string | undefined;
  positionals: string[];
  flags: Flags;
  /** What followed `--`, for `relay run`. */
  rest: string[];
}

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  lang: { type: "string" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  work: { type: "boolean" },
  group: { type: "string" },
  org: { type: "string" },
  new: { type: "boolean" },
  resume: { type: "boolean" },
  cancel: { type: "boolean" },
  "poll-ms": { type: "string" },
  accounts: { type: "string" },
  days: { type: "string" },
  account: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  provider: { type: "string" },
} as const;

const GLOBAL = ["yes", "lang", "no-color", "help", "version"];
/** The flags each command takes, beside the global ones. */
export const COMMAND_FLAGS: Record<string, string[]> = {
  status: ["json"],
  list: ["json"],
  ls: ["json"],
  add: ["work", "group", "org", "new", "resume", "cancel", "poll-ms", "provider"],
  switch: [],
  remove: [],
  rename: [],
  recover: [],
  history: ["json", "accounts"],
  connect: [],
  usage: ["json"],
  run: [],
  tokens: ["json", "days", "account"],
  doctor: ["json"],
  proxy: ["json", "port", "host"],
  "reset-vault": [],
  help: [],
  __worker: [],
};

export function parseCommand(argv: string[]): ParsedCommand {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: own, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError((error as Error).message, EXIT.usage);
  }
  const [command, ...positionals] = parsed.positionals;
  const flags = parsed.values as Flags;
  if (command !== undefined) {
    const allowed = COMMAND_FLAGS[command];
    if (allowed)
      for (const [name, value] of Object.entries(flags))
        if (value !== undefined && !GLOBAL.includes(name) && !allowed.includes(name))
          throw new CliError(`relay ${command} does not take --${name}.`, EXIT.usage);
  }
  if (rest.length && command !== "run")
    throw new CliError("Only relay run takes arguments after --.", EXIT.usage);
  return { command, positionals, flags, rest };
}
