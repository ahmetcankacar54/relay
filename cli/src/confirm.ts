import { CliError, EXIT, type CliIO } from "./io";
import type { T } from "../../shared/i18n/translate";

/**
 * Asks before something that cannot be taken back. With --yes it goes ahead. Without a
 * terminal it refuses (exit 4), since nobody could answer. A declined prompt, or Ctrl+C at
 * it, cancels with nothing changed.
 */
export async function confirm(
  io: CliIO,
  t: T,
  lines: string[],
  yes: boolean,
): Promise<void> {
  if (yes) return;
  if (!io.isTTY)
    throw new CliError(
      t("confirm.thisNeedsConfirmationRunItIn"),
      EXIT.confirm,
    );
  for (const line of lines) io.stdout(line);
  const answer = (await io.prompt(t("confirm.continueYN")))
    ?.trim()
    .toLowerCase();
  const accepted = t("confirm.yYes").split(" ");
  if (!answer || !accepted.includes(answer))
    throw new CliError(
      t("confirm.cancelledNothingChanged"),
      EXIT.failed,
    );
}
