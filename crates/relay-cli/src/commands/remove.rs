use std::path::Path;
use std::time::Duration;

use relay_core::account_removal::{
    AccountRemoval, AccountRemovalError, DesktopFacts, RemovalBlock, removal_block, remove_account,
};
use relay_core::redact::{MAX, redact};
use relay_i18n::Args;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::claude_cli::run_claude;
use crate::confirm::confirm;
use crate::context::{Needs, open_context};
use crate::errors::{CliResult, Failure};
use crate::io::{CliError, exit};

pub fn remove(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let Some(query) = positionals
        .first()
        .filter(|q| !q.is_empty() && positionals.len() == 1)
    else {
        return Err(CliError::new(t.t("remove.usageRelayRemoveName"), exit::USAGE).into());
    };
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::WRITE)?;
    let registry = ctx.store.state();
    let account = resolve_account(&registry.accounts, query, t)?.clone();
    let refuse = |reason: RemovalBlock| -> Failure {
        CliError::new(
            match reason {
                RemovalBlock::Active => t.f(
                    "remove.isSignedInToTheClaude",
                    Args::new().set("accountName", account.name.as_str()),
                ),
                RemovalBlock::Pending => t.t("remove.thisAccountSSignInIs"),
            },
            exit::BUSY,
        )
        .into()
    };
    let facts = || -> Result<DesktopFacts, String> {
        let state = ctx.desktop.snapshot().map_err(|e| e.message().to_owned())?;
        Ok(DesktopFacts {
            active_profile_id: state.active_profile_id,
            pending_profile_id: state.pending_profile_id,
        })
    };
    let now = facts().map_err(Failure::Other)?;
    if let Some(reason) = removal_block(&account.id, &now) {
        return Err(refuse(reason));
    }
    confirm(
        io,
        t,
        &[t.f(
            "remove.willBeForgottenItsSavedClaude",
            Args::new().set("accountName", account.name.as_str()),
        )],
        ctx.yes,
    )?;
    let claude = (ctx.deps.claude)(registry.executable.as_deref());
    let sign_out = |profile: &Path| -> Result<bool, String> {
        let Some(claude) = &claude else {
            return Ok(false);
        };
        match run_claude(
            claude,
            &["auth", "logout"],
            profile,
            &io.env,
            false,
            Some(Duration::from_secs(30)),
        ) {
            Ok(code) => Ok(code == 0),
            Err(error) => {
                io.err(&format!("relay: {}", redact(&error.to_string(), MAX)));
                Ok(false)
            }
        }
    };
    // The shared core checks Desktop again, so a switch made while the question was open still counts.
    let removed = remove_account(
        &account.id,
        &AccountRemoval {
            store: &ctx.store,
            vault: &ctx.paths.vault,
            locks: &ctx.paths.locks,
            desktop: &facts,
            sign_out: if claude.is_some() {
                Some(&sign_out)
            } else {
                None
            },
        },
    )
    .map_err(|error| match error {
        AccountRemovalError::Refused(refused) => refuse(refused.reason),
        AccountRemovalError::Store(e) => e.into(),
        AccountRemovalError::ProfileLock(e) => e.into(),
        AccountRemovalError::File(e) => e.into(),
        AccountRemovalError::Io(e) => e.into(),
        AccountRemovalError::Desktop(m) => Failure::Other(m),
    })?;
    if removed.signed_out == Some(false) {
        io.err(&t.t("remove.warningCouldNotSignOutOf"));
    }
    io.out(&t.f(
        "remove.forgot",
        Args::new().set("accountName", account.name.as_str()),
    ));
    Ok(exit::OK)
}
