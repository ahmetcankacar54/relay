import { CliError, EXIT, type CliIO } from "./io";
import type { Translate } from "./i18n";

/**
 * Asks before something that cannot be taken back. With --yes it goes ahead. Without a
 * terminal it refuses (exit 4), since nobody could answer. A declined prompt, or Ctrl+C at
 * it, cancels with nothing changed.
 */
export async function confirm(
  io: CliIO,
  t: Translate,
  lines: string[],
  yes: boolean,
): Promise<void> {
  if (yes) return;
  if (!io.isTTY)
    throw new CliError(
      t(
        "Bu işlem onay ister. Bir terminalde çalıştır ya da --yes ekle.",
        "This needs confirmation. Run it in a terminal, or add --yes.",
      ),
      EXIT.confirm,
    );
  for (const line of lines) io.stdout(line);
  const answer = (await io.prompt(t("Devam edilsin mi? [e/H] ", "Continue? [y/N] ")))
    ?.trim()
    .toLowerCase();
  const accepted = t("e evet y yes", "y yes").split(" ");
  if (!answer || !accepted.includes(answer))
    throw new CliError(
      t("Vazgeçildi; hiçbir şey değişmedi.", "Cancelled; nothing changed."),
      EXIT.failed,
    );
}
