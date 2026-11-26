use crate::CommandRun;
use crate::confirm::confirm;
use crate::context::{Needs, open_context};
use crate::desktop_op::{quit_lines, run_desktop_operation};
use crate::errors::CliResult;
use crate::guards::gui_session_guard;
use crate::inside_desktop::{detach, inside_desktop, session_ends_line};
use crate::io::{CliError, exit};

pub fn recover(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    if !run.parsed.positionals.is_empty() {
        return Err(CliError::new(t.t("recover.usageRelayRecover"), exit::USAGE).into());
    }
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::DESKTOP)?;
    let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
    if !state.recovery_required {
        io.out(&t.t("recover.noBackupToRestore"));
        return Ok(exit::OK);
    }
    gui_session_guard(&ctx.deps, t)?;
    let inside = inside_desktop(&ctx);
    let mut lines = vec![t.t("recover.theClaudeAppWillQuitThe")];
    lines.extend(quit_lines(&ctx));
    if inside {
        lines.push(session_ends_line(&ctx));
    }
    confirm(io, t, &lines, ctx.yes)?;
    if inside {
        return detach(&ctx, run.argv);
    }
    run_desktop_operation(&ctx, || ctx.desktop.recover())?;
    io.out(&t.t("recover.theInterruptedSwitchSBackupWas"));
    Ok(exit::OK)
}
