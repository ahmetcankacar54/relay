import { ZodError } from "zod";
import { LockBusyError } from "../../electron/core/process-lock";
import { ProfileLockBusyError } from "../../electron/core/profile-lock";
import { StoreWriteRefused } from "../../electron/core/store";
import { VaultFormatError } from "../../electron/core/vault-crypto";
import { VaultKeyError } from "../../electron/core/vault-key";
import { redact } from "../../electron/core/redact";
import { localizeError } from "../../shared/error-text";
import { parseCommand } from "./args";
import type { CliDeps } from "./deps";
import { helpText } from "./help";
import { pickLang, translator } from "./i18n";
import type { Locale } from "../../shared/i18n/locales";
import type { MessageId, T } from "../../shared/i18n/translate";
import { CliError, EXIT, type CliIO } from "./io";
import { CLI_VERSION } from "./version";
import { lockHolderText } from "./describe";
import { COMMANDS } from "./commands";
import { runWorker } from "./inside-desktop";
import { relayPaths } from "../../electron/core/relay-paths";

/** Core errors that mean "busy or blocked" (exit 3), with what to do about each. */
const BLOCKED: [RegExp, MessageId][] = [
  [/Finish or cancel the current Desktop sign-in first/, "desktopOp.aSignInIsPendingFinish"],
  [/Restore the interrupted Desktop switch first|Desktop recovery is required/, "desktopOp.aSwitchWasInterruptedRunRelay"],
  [/A Desktop operation is already in progress/, "srcMain.anotherClaudeAppOperationIsRunning"],
];

function lockMessage(error: LockBusyError, t: T, now: number): string {
  const { startedAt } = error.holder;
  const seconds = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  return t("srcMain.startedSAgoTryAgainWhen", { lockHolderText: lockHolderText(error.holder, t), seconds });
}

/**
 * The message and exit code an error ends the CLI with, in `lang`. Messages are always redacted,
 * and a core error the app knows (shared/error-text.ts) is shown localized.
 */
export function describeError(error: unknown, lang: Locale, now = Date.now()) {
  const t = translator(lang);
  if (error instanceof CliError) return { message: redact(error.message, 600), code: error.code };
  if (error instanceof LockBusyError) return { message: lockMessage(error, t, now), code: EXIT.busy };
  if (error instanceof ProfileLockBusyError)
    return {
      message: t("srcMain.thisAccountIsInUseBy"),
      code: EXIT.busy,
    };
  if (error instanceof ZodError || (error as Error)?.name === "ZodError") {
    const where = (error as ZodError).issues?.[0]?.path?.join(".");
    return {
      message: where
        ? t("srcMain.relaySAccountListStateJson2", { where })
        : t("srcMain.relaySAccountListStateJson"),
      code: EXIT.failed,
    };
  }
  if (error instanceof StoreWriteRefused || error instanceof VaultKeyError || error instanceof VaultFormatError)
    return { message: localizeError(redact(error.message, 600), lang), code: EXIT.environment };
  const message = redact(error, 600);
  for (const [pattern, id] of BLOCKED)
    if (pattern.test(message)) return { message: t(id), code: EXIT.busy };
  return { message: localizeError(message, lang), code: EXIT.failed };
}

/** Runs one `relay` invocation and returns its exit code. Never throws. */
export async function runCli(
  argv: string[],
  io: CliIO,
  deps: Partial<CliDeps> = {},
): Promise<number> {
  let lang = pickLang(undefined, io.env);
  try {
    const parsed = parseCommand(argv);
    lang = pickLang(parsed.flags.lang as string | undefined, io.env);
    const t = translator(lang);
    if (parsed.flags.version) {
      io.stdout(CLI_VERSION);
      return EXIT.ok;
    }
    if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
      io.stdout(helpText(t));
      return EXIT.ok;
    }
    if (parsed.command === "__worker")
      return await runWorker(relayPaths(io.env).cliOperations, parsed.positionals[0] ?? "", io, (args, workerIO) =>
        runCli(args, workerIO, deps),
      );
    const command = COMMANDS[parsed.command];
    if (!command)
      throw new CliError(
        t("srcMain.unknownCommandForTheCommandsRelay", { parsedCommand: parsed.command }),
        EXIT.usage,
      );
    return await command({ io, deps, parsed, t, lang, argv });
  } catch (error) {
    const { message, code } = describeError(error, lang, io.now());
    io.stderr(`relay: ${message}`);
    return code;
  }
}
