import type { Command } from "../command";
import { list } from "./list";
import { status } from "./status";

/** Every command by name, aliases included. */
export const COMMANDS: Record<string, Command> = {
  status,
  list,
  ls: list,
};
