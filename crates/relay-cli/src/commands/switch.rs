use relay_core::desktop::DesktopSwitchOptions;
use relay_core::shared::extension_text::extension_line;
use relay_core::shared::history_policy::history_sources;
use relay_core::shared::terminal_identity::{TerminalMode, terminal_line};
use relay_core::shared::types::DesktopHistoryTransfer;
use relay_i18n::Args;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::confirm::confirm;
use crate::context::{Needs, open_context};
use crate::describe::history_mode_text;
use crate::desktop_op::{assert_can_quit_claude, quit_lines, run_desktop_operation};
use crate::errors::CliResult;
use crate::inside_desktop::{detach, inside_desktop, session_ends_line};
use crate::io::{CliError, exit};
use crate::output::{Style, paint};

pub fn switch_command(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let Some(query) = positionals
        .first()
        .filter(|q| !q.is_empty() && positionals.len() == 1)
    else {
        return Err(CliError::new(t.t("commandsSwitch.usageRelaySwitchName"), exit::USAGE).into());
    };
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::DESKTOP)?;
    let registry = ctx.store.state();
    let accounts = &registry.accounts;
    let target = resolve_account(accounts, query, t)?.clone();
    let name = || Args::new().set("targetName", target.name.as_str());
    if target.desktop.is_none() {
        return Err(CliError::new(
            t.f("commandsSwitch.hasNoSavedClaudeAppSign", name()),
            exit::FAILED,
        )
        .into());
    }
    let state = assert_can_quit_claude(&ctx, false)?;
    if state.active_profile_id.as_deref() == Some(target.id.as_str()) {
        io.out(&t.f("commandsSwitch.isAlreadyActive", name()));
        return Ok(exit::OK);
    }
    let settings = &registry.settings;
    let sources: Vec<&str> = history_sources(&target, accounts, settings)
        .into_iter()
        .filter(|a| a.id != target.id)
        .map(|a| a.name.as_str())
        .collect();
    let history =
        if settings.desktop_history_transfer == DesktopHistoryTransfer::Off || sources.is_empty() {
            t.f(
                "commandsSwitch.codeHistoryNothingToBringOver",
                Args::new().set(
                    "historyModeText",
                    history_mode_text(settings.desktop_history_transfer, t),
                ),
            )
        } else {
            t.f(
                "commandsSwitch.codeHistoryComesOverFrom",
                Args::new().set("join", sources.join(", ")),
            )
        };
    let browser = ctx.desktop.extension_quits_browser();
    // The plain `claude` in a terminal follows the account too, unless that is turned off.
    let terminal_follows = ctx
        .desktop
        .terminal_status()
        .is_some_and(|s| s.mode != TerminalMode::Off);
    let inside = inside_desktop(&ctx);
    let mut lines = vec![paint(
        ctx.color,
        Style::Bold,
        &t.f("commandsSwitch.theClaudeAppWillQuitAnd", name()),
    )];
    lines.extend(quit_lines(&ctx));
    if let Some(browser) = browser.as_deref().filter(|b| !b.is_empty()) {
        lines.push(t.f(
            "commandsSwitch.willAlsoQuitForAMoment",
            Args::new().set("browser", browser),
        ));
    }
    if terminal_follows {
        lines.push(t.f("commandsSwitch.theTerminalClaudeSSignIn", name()));
    }
    if inside {
        lines.push(session_ends_line(&ctx));
    }
    lines.push(history);
    confirm(io, t, &lines, ctx.yes)?;
    if inside {
        return detach(&ctx, run.argv);
    }
    run_desktop_operation(&ctx, || {
        ctx.desktop
            .switch_to(&target.id, DesktopSwitchOptions::default())
    })?;
    io.out(&t.f(
        "commandsSwitch.switchedToConversationSCarried",
        name().set("n", ctx.desktop.carried_count()),
    ));
    // As the app does: what became of the Claude extension's sign-in, when there is something to say.
    if let Some(line) = ctx
        .desktop
        .extension_outcome()
        .and_then(|o| extension_line(&o, ctx.lang))
    {
        io.out(&line);
    }
    // And what became of the terminal's Claude Code sign-in.
    if terminal_follows
        && let Some(last) = ctx.desktop.terminal_status().and_then(|s| s.last)
        && let Some(text) = terminal_line(&last, ctx.lang, Some(&target.name))
    {
        io.out(&text);
    }
    Ok(exit::OK)
}
