//! Port of `cli/src/confirm.ts`.

use crate::i18n::T;
use crate::io::{CliError, CliIo, exit};

/// Asks before something that cannot be taken back. With --yes it goes ahead. Without a
/// terminal it refuses (exit 4), since nobody could answer. A declined prompt, or Ctrl+C at
/// it, cancels with nothing changed.
pub fn confirm(io: &CliIo, t: T, lines: &[String], yes: bool) -> Result<(), CliError> {
    if yes {
        return Ok(());
    }
    if !io.is_tty {
        return Err(CliError::new(
            t.t("confirm.thisNeedsConfirmationRunItIn"),
            exit::CONFIRM,
        ));
    }
    for line in lines {
        io.out(line);
    }
    let answer = (io.prompt)(&t.t("confirm.continueYN"))
        .map(|a| relay_core::store::schema::js_trim(&a).to_lowercase());
    let accepted = t.t("confirm.yYes");
    match answer {
        Some(answer) if !answer.is_empty() && accepted.split(' ').any(|word| word == answer) => {
            Ok(())
        }
        _ => Err(CliError::new(
            t.t("confirm.cancelledNothingChanged"),
            exit::FAILED,
        )),
    }
}
