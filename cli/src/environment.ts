import { profileEnvironment } from "../../electron/core/environment";

/**
 * The environment for the official CLI started from this terminal: the account's isolated
 * profile, without inherited credentials or routing (profileEnvironment), but with the user's
 * own TERM and COLORTERM. profileEnvironment sets those for the app's xterm.js terminals.
 */
export function cliEnvironment(profile: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const result = profileEnvironment(profile, env);
  delete result.TERM;
  delete result.COLORTERM;
  if (env.TERM) result.TERM = env.TERM;
  if (env.COLORTERM) result.COLORTERM = env.COLORTERM;
  return result;
}
