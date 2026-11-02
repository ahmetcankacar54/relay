/** Everything the CLI reads from and writes to its terminal; tests pass an in-memory one. */
export interface CliIO {
  /** Writes one line to stdout. */
  stdout(line: string): void;
  /** Writes one line to stderr. */
  stderr(line: string): void;
  /** Both stdin and stdout are a terminal: prompts and colors are allowed. */
  isTTY: boolean;
  /** Asks a question on the terminal; undefined on end of input or Ctrl+C. */
  prompt(question: string): Promise<string | undefined>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  now(): number;
  pid: number;
  /**
   * While set, SIGINT, SIGTERM and SIGHUP go to `handler` instead of ending the process;
   * undefined gives them back their default.
   */
  onSignal(handler: ((signal: NodeJS.Signals) => void) | undefined): void;
}

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  busy: 3,
  confirm: 4,
  environment: 5,
} as const;

/** An error the CLI reports as it is, with its exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: number = EXIT.failed,
  ) {
    super(message);
  }
}
