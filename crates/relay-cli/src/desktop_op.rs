//! Port of `cli/src/desktop-op.ts`.

use relay_core::desktop::DesktopError;
use relay_core::desktop_files::read_object;
use relay_core::profile_lock::any_exclusive_profile_lock;
use relay_core::redact::{MAX, redact};
use relay_core::shared::error_text::localize_error;
use relay_core::shared::types::DesktopState;

use crate::context::CliContext;
use crate::errors::{CliResult, Failure};
use crate::guards::gui_session_guard;
use crate::io::{CliError, exit};
use crate::shield::shielded;

/// What the user is told before any command that quits the Claude app.
pub fn quit_lines(ctx: &CliContext) -> Vec<String> {
    vec![
        ctx.t.t("desktopOp.theClaudeAppSRunningCode"),
        ctx.t.t("desktopOp.theCliDoesnTReType"),
    ]
}

/// Refuses a Claude-quitting command before it asks anything: a pending sign-in, an
/// interrupted switch, an account connection being renewed, or no desktop session.
pub fn assert_can_quit_claude(ctx: &CliContext, allow_pending: bool) -> CliResult<DesktopState> {
    let t = ctx.t;
    let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
    if state.pending_profile_id.is_some() && !allow_pending {
        return Err(CliError::new(t.t("desktopOp.aSignInIsPendingFinish"), exit::BUSY).into());
    }
    if state.recovery_required {
        return Err(
            CliError::new(t.t("desktopOp.aSwitchWasInterruptedRunRelay"), exit::BUSY).into(),
        );
    }
    if any_exclusive_profile_lock(&ctx.paths.locks, None)? {
        return Err(CliError::new(t.t("desktopOp.anAccountSConnectionIsBeing"), exit::BUSY).into());
    }
    gui_session_guard(&ctx.deps, t)?;
    Ok(state)
}

/// `/-1743|Not authorized to send Apple events|not allowed to send Apple events/i`.
fn automation_refused(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("-1743")
        || lower.contains("not authorized to send apple events")
        || lower.contains("not allowed to send apple events")
}

/// Runs a Desktop operation that quits Claude, held against signals. A failure says what to do
/// next: grant the Automation permission, or run `relay recover` when a journal was left.
pub fn run_desktop_operation<R>(
    ctx: &CliContext,
    run: impl FnOnce() -> Result<R, DesktopError>,
) -> CliResult<R> {
    let t = ctx.t;
    match shielded(&ctx.io, t, run) {
        Ok(value) => Ok(value),
        Err(error) => {
            let full = error.message().to_owned();
            if automation_refused(&full) {
                return Err(CliError::new(
                    t.t("desktopOp.macosDidNotLetThisTerminal"),
                    exit::ENVIRONMENT,
                )
                .into());
            }
            if matches!(read_object(&ctx.paths.vault, "journal.json"), Ok(Some(_))) {
                return Err(Failure::cli(
                    format!(
                        "{} {}",
                        localize_error(&redact(&full, MAX), ctx.lang),
                        t.t("desktopOp.quitClaudeAndRunRelayRecover")
                    ),
                    exit::FAILED,
                ));
            }
            Err(ctx.desktop_failure(error))
        }
    }
}
