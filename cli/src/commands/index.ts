import type { Command } from "../command";
import { add } from "./add";
import { resetVault } from "./reset-vault";
import { doctor } from "./doctor";
import { tokens } from "./tokens";
import { run } from "./run";
import { connect } from "./connect";
import { usage } from "./usage";
import { history } from "./history";
import { remove } from "./remove";
import { rename } from "./rename";
import { list } from "./list";
import { recover } from "./recover";
import { status } from "./status";
import { switchCommand } from "./switch";
import { proxyCommand } from "./proxy";

/** Every command by name, aliases included. */
export const COMMANDS: Record<string, Command> = {
  status,
  list,
  ls: list,
  switch: switchCommand,
  recover,
  add,
  remove,
  rename,
  history,
  connect,
  usage,
  run,
  tokens,
  doctor,
  proxy: proxyCommand,
  "reset-vault": resetVault,
};
