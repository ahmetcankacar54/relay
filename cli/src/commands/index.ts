import type { Command } from "../command";
import { add } from "./add";
import { list } from "./list";
import { recover } from "./recover";
import { status } from "./status";
import { switchCommand } from "./switch";

/** Every command by name, aliases included. */
export const COMMANDS: Record<string, Command> = {
  status,
  list,
  ls: list,
  switch: switchCommand,
  recover,
  add,
};
