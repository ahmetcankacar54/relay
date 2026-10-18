import { LockBusyError } from "../../electron/core/process-lock";
import { ProfileLockBusyError } from "../../electron/core/profile-lock";
import { StoreWriteRefused } from "../../electron/core/store";
import { VaultFormatError } from "../../electron/core/vault-crypto";
import { VaultKeyError } from "../../electron/core/vault-key";
import { redact } from "../../electron/core/redact";
import { parseCommand } from "./args";
import type { CliDeps } from "./deps";
import { helpText } from "./help";
import { pickLang, translator, type Translate } from "./i18n";
import { CliError, EXIT, type CliIO } from "./io";
import { CLI_VERSION } from "./version";
import { COMMANDS } from "./commands";

/** Core errors that mean "busy or blocked" (exit 3), with what to do about each. */
const BLOCKED: [RegExp, string, string][] = [
  [/Finish or cancel the current Desktop sign-in first/, "Yarım kalan bir giriş var: relay add --resume ile bitirin ya da relay add --cancel ile iptal edin.", "A sign-in is pending: finish it with relay add --resume or cancel it with relay add --cancel."],
  [/Restore the interrupted Desktop switch first|Desktop recovery is required/, "Yarıda kalan bir geçiş var: önce relay recover çalıştırın.", "A switch was interrupted: run relay recover first."],
  [/A Desktop operation is already in progress/, "Başka bir Desktop işlemi sürüyor.", "Another Desktop operation is running."],
];

function lockMessage(error: LockBusyError, t: Translate, now: number): string {
  const { by, kind, startedAt } = error.holder;
  const seconds = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  const who =
    by === "app"
      ? t("Relay.app", "Relay.app")
      : by === "cli"
        ? t("Başka bir relay komutu", "Another relay command")
        : t("Başka bir Relay işlemi", "Another Relay process");
  return t(
    `${who} şu an bir Claude Desktop işlemi yapıyor (${kind}, ${seconds} sn önce başladı). Bitince yeniden deneyin.`,
    `${who} is running a Claude Desktop operation (${kind}, started ${seconds} s ago). Try again when it ends.`,
  );
}

/** The message and exit code an error ends the CLI with. Messages are always redacted. */
export function describeError(error: unknown, t: Translate, now = Date.now()) {
  if (error instanceof CliError) return { message: redact(error.message, 600), code: error.code };
  if (error instanceof LockBusyError) return { message: lockMessage(error, t, now), code: EXIT.busy };
  if (error instanceof ProfileLockBusyError)
    return {
      message: t(
        "Bu hesap şu an başka bir işlemde kullanılıyor (giriş, bağlantı yenileme ya da çalışan Claude Code). Bitince yeniden deneyin.",
        "This account is in use by another process (a sign-in, a connection renewal or a running Claude Code). Try again when it ends.",
      ),
      code: EXIT.busy,
    };
  if (error instanceof StoreWriteRefused || error instanceof VaultKeyError || error instanceof VaultFormatError)
    return { message: redact(error.message, 600), code: EXIT.environment };
  const message = redact(error, 600);
  for (const [pattern, tr, en] of BLOCKED)
    if (pattern.test(message)) return { message: t(tr, en), code: EXIT.busy };
  return { message, code: EXIT.failed };
}

/** Runs one `relay` invocation and returns its exit code. Never throws. */
export async function runCli(
  argv: string[],
  io: CliIO,
  deps: Partial<CliDeps> = {},
): Promise<number> {
  let t = translator(pickLang(undefined, io.env));
  try {
    const parsed = parseCommand(argv);
    const lang = pickLang(parsed.flags.lang as string | undefined, io.env);
    t = translator(lang);
    if (parsed.flags.version) {
      io.stdout(CLI_VERSION);
      return EXIT.ok;
    }
    if (!parsed.command || parsed.command === "help" || parsed.flags.help) {
      io.stdout(helpText(t));
      return EXIT.ok;
    }
    const command = COMMANDS[parsed.command];
    if (!command)
      throw new CliError(
        t(`Bilinmeyen komut: ${parsed.command}. Komutlar için: relay help`, `Unknown command: ${parsed.command}. For the commands: relay help`),
        EXIT.usage,
      );
    return await command({ io, deps, parsed, t, lang });
  } catch (error) {
    const { message, code } = describeError(error, t, io.now());
    io.stderr(`relay: ${message}`);
    return code;
  }
}
