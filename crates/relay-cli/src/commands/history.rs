use relay_core::shared::history_policy::history_sources;
use relay_core::shared::types::{Account, DesktopHistoryTransfer};
use relay_i18n::Args;
use serde_json::json;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::confirm::confirm;
use crate::context::{CliContext, Needs, open_context};
use crate::describe::history_mode_text;
use crate::desktop_op::{assert_can_quit_claude, quit_lines, run_desktop_operation};
use crate::errors::CliResult;
use crate::inside_desktop::{detach, inside_desktop, session_ends_line};
use crate::io::{CliError, exit};
use crate::output::print_json;

/// The named account, or the one open in the Claude app.
fn chosen(ctx: &CliContext, query: Option<&str>) -> CliResult<Account> {
    let accounts = ctx.store.state().accounts;
    // `if (query)`: an empty name is no name.
    if let Some(query) = query.filter(|q| !q.is_empty()) {
        return Ok(resolve_account(&accounts, query, ctx.t)?.clone());
    }
    let active = ctx
        .desktop
        .snapshot()
        .map_err(|e| ctx.desktop_failure(e))?
        .active_profile_id;
    accounts
        .into_iter()
        .find(|a| Some(&a.id) == active.as_ref())
        .ok_or_else(|| {
            CliError::new(ctx.t.t("history.noSavedAccountIsSignedIn"), exit::USAGE).into()
        })
}

fn mode_of(text: &str) -> Option<DesktopHistoryTransfer> {
    Some(match text {
        "all" => DesktopHistoryTransfer::All,
        "same-group" => DesktopHistoryTransfer::SameGroup,
        "selected" => DesktopHistoryTransfer::Selected,
        "off" => DesktopHistoryTransfer::Off,
        _ => return None,
    })
}

pub fn history(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let sub = positionals.first().map(String::as_str);
    let args = positionals.get(1..).unwrap_or_default();
    if sub == Some("mode") {
        let mode = args.first().and_then(|m| mode_of(m));
        let Some(mode) = mode.filter(|_| args.len() <= 1) else {
            return Err(
                CliError::new(t.t("history.usageRelayHistoryModeAllSame"), exit::USAGE).into(),
            );
        };
        let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::WRITE)?;
        let mut selected: Option<Vec<String>> = None;
        if mode == DesktopHistoryTransfer::Selected {
            let accounts = ctx.store.state().accounts;
            let mut ids: Vec<String> = Vec::new();
            for name in ctx.flags.str("accounts").unwrap_or("").split(',') {
                let name = relay_core::store::schema::js_trim(name);
                if name.is_empty() {
                    continue;
                }
                let id = resolve_account(&accounts, name, t)?.id.clone();
                if !ids.contains(&id) {
                    ids.push(id);
                }
            }
            if ids.len() < 2 {
                return Err(CliError::new(
                    t.t("history.selectedSharingNeedsAtLeastTwo"),
                    exit::USAGE,
                )
                .into());
            }
            selected = Some(ids);
        }
        ctx.store.update(|s| {
            s.settings.desktop_history_transfer = mode;
            if let Some(selected) = selected {
                s.settings.desktop_history_accounts = selected;
            }
        })?;
        io.out(&t.f(
            "history.codeHistoryIsNow",
            Args::new().set("historyModeText", history_mode_text(mode, t)),
        ));
        return Ok(exit::OK);
    }
    if sub == Some("sync") {
        if args.len() > 1 {
            return Err(
                CliError::new(t.t("history.usageRelayHistorySyncName"), exit::USAGE).into(),
            );
        }
        let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::DESKTOP)?;
        let account = chosen(&ctx, args.first().map(String::as_str))?;
        assert_can_quit_claude(&ctx, false)?;
        let inside = inside_desktop(&ctx);
        let mut lines = vec![t.f(
            "history.codeHistoryFromTheOtherAccounts",
            Args::new().set("accountName", account.name.as_str()),
        )];
        lines.extend(quit_lines(&ctx));
        if inside {
            lines.push(session_ends_line(&ctx));
        }
        confirm(io, t, &lines, ctx.yes)?;
        if inside {
            return detach(&ctx, run.argv);
        }
        run_desktop_operation(&ctx, || ctx.desktop.sync_history(&account.id))?;
        io.out(&t.f(
            "history.conversationSCarried",
            Args::new().set("n", ctx.desktop.carried_count()),
        ));
        return Ok(exit::OK);
    }
    if !args.is_empty() {
        return Err(CliError::new(t.t("history.usageRelayHistoryName"), exit::USAGE).into());
    }
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let account = chosen(&ctx, sub)?;
    let registry = ctx.store.state();
    let settings = &registry.settings;
    let sources: Vec<String> = history_sources(&account, &registry.accounts, settings)
        .into_iter()
        .filter(|a| a.id != account.id)
        .map(|a| a.name.clone())
        .collect();
    let summary = ctx
        .desktop
        .history_summary(&account.id)
        .map_err(|e| ctx.desktop_failure(e))?;
    if ctx.json {
        print_json(
            io,
            &json!({
                "mode": settings.desktop_history_transfer.as_str(),
                "account": { "id": account.id, "name": account.name },
                "sources": sources,
                "summary": serde_json::to_value(&summary)?,
            }),
        );
        return Ok(exit::OK);
    }
    io.out(&t.f(
        "history.codeHistory",
        Args::new().set(
            "historyModeText",
            history_mode_text(settings.desktop_history_transfer, t),
        ),
    ));
    io.out(&if sources.is_empty() {
        t.f(
            "history.getsNoHistoryFromOtherAccounts",
            Args::new().set("accountName", account.name.as_str()),
        )
    } else {
        t.f(
            "history.getsHistoryFrom",
            Args::new()
                .set("accountName", account.name.as_str())
                .set("join", sources.join(", ")),
        )
    });
    io.out(
        &t.f(
            "history.conversationsArchivedProjectsTranscripts",
            Args::new()
                .set("summaryIndexed", summary.indexed)
                .set("summaryArchived", summary.archived)
                .set("summaryProjects", summary.projects)
                .set("summaryTranscriptsFound", summary.transcripts_found)
                .set("summaryMissingTranscripts", summary.missing_transcripts)
                .set("summaryDuplicates", summary.duplicates),
        ),
    );
    Ok(exit::OK)
}
