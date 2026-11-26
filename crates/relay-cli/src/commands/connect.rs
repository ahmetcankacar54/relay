use std::time::Duration;

use relay_core::profile_auth::read_profile_auth;
use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::shared::error_text::localize_error;
use relay_core::shared::external_links::CLI_SETUP;
use relay_i18n::Args;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::claude_cli::run_claude;
use crate::context::{Needs, open_context};
use crate::errors::{CliResult, Failure};
use crate::io::{CliError, exit};

const MOVED_WORKSPACE: &str = "This sign-in belongs to a workspace of the account that the Claude app has not opened yet. Open Code in that workspace in the Claude app, then renew the sign-in.";

pub fn connect(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let Some(query) = positionals
        .first()
        .filter(|q| !q.is_empty() && positionals.len() == 1)
    else {
        return Err(CliError::new(t.t("connect.usageRelayConnectName"), exit::USAGE).into());
    };
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::WRITE)?;
    let registry = ctx.store.state();
    let account = resolve_account(&registry.accounts, query, t)?.clone();
    let Some(claude) = (ctx.deps.claude)(registry.executable.as_deref()) else {
        return Err(CliError::new(
            t.f(
                "connect.theClaudeCodeCliWasNot",
                Args::new().set("EXTERNAL_LINKSCliSetup", CLI_SETUP),
            ),
            exit::ENVIRONMENT,
        )
        .into());
    };
    let profile = ctx.store.profile(&account.id)?;
    let mut guard =
        acquire_profile_lock(&ctx.paths.locks, &account.id, ProfileLockKind::Exclusive)?;
    let logout = || {
        let _ = run_claude(
            &claude,
            &["auth", "logout"],
            &profile,
            &io.env,
            false,
            Some(Duration::from_secs(30)),
        );
    };
    let result = (|| -> CliResult<i32> {
        io.out(&t.f(
            "connect.openingTheUsageSignInFor",
            Args::new().set("accountName", account.name.as_str()),
        ));
        let code = run_claude(
            &claude,
            &["auth", "login", "--claudeai"],
            &profile,
            &io.env,
            true,
            None,
        )?;
        if code != 0 {
            return Err(CliError::new(t.t("connect.theSignInDidNotFinish"), exit::FAILED).into());
        }
        let auth = read_profile_auth(&claude, &profile, account.auth.as_ref(), None);
        if !auth.logged_in {
            return Err(CliError::new(
                match auth.error.as_deref().filter(|e| !e.is_empty()) {
                    Some(error) => localize_error(error, ctx.lang),
                    None => t.t("connect.theSignInCouldNotBe"),
                },
                exit::FAILED,
            )
            .into());
        }
        let lower = |s: Option<&str>| s.map(str::to_lowercase);
        let mut moved = false;
        if let Some(desktop) = &account.desktop
            && let Some(org) = auth.org_id.as_deref().filter(|o| !o.is_empty())
            && lower(auth.account_uuid.as_deref()) == Some(desktop.account_uuid.to_lowercase())
            && org.to_lowercase() != desktop.org_id.to_lowercase()
        {
            // The profile's own account in another of its workspaces: the profile moves there
            // when the Claude app has that workspace. Signing in again could never make the two agree.
            let id = account.id.clone();
            let next = auth.clone();
            ctx.store.update(|s| {
                if let Some(a) = s.accounts.iter_mut().find(|a| a.id == id) {
                    a.auth = Some(next);
                }
            })?;
            moved = ctx.desktop.rebind_org(&account.id, org).unwrap_or(false);
            if !moved {
                let previous = account.auth.clone();
                ctx.store.update(|s| {
                    if let Some(a) = s.accounts.iter_mut().find(|a| a.id == id) {
                        a.auth = previous;
                    }
                })?;
                logout();
                return Err(
                    CliError::new(localize_error(MOVED_WORKSPACE, ctx.lang), exit::FAILED).into(),
                );
            }
        }
        if let Some(desktop) = &account.desktop
            && !moved
            && (lower(auth.account_uuid.as_deref()) != Some(desktop.account_uuid.to_lowercase())
                || lower(auth.org_id.as_deref()) != Some(desktop.org_id.to_lowercase()))
        {
            logout();
            let expected = desktop
                .email
                .clone()
                .unwrap_or_else(|| t.t("connect.itsClaudeAppAccount"));
            let args = Args::new()
                .set("accountName", account.name.as_str())
                .set("expected", expected);
            return Err(CliError::new(
                match auth.email.as_deref().filter(|e| !e.is_empty()) {
                    Some(email) => t.f("connect.signedInAsButMustSign", args.set("email", email)),
                    None => t.f("connect.signedInAsAnotherAccountBut", args),
                },
                exit::FAILED,
            )
            .into());
        }
        let id = account.id.clone();
        let next = auth.clone();
        ctx.store.update(|s| {
            if let Some(a) = s.accounts.iter_mut().find(|a| a.id == id) {
                a.auth = Some(next);
            }
        })?;
        io.out(&match auth.email.as_deref().filter(|e| !e.is_empty()) {
            Some(email) => t.f(
                "connect.signedInToReadUsageFor2",
                Args::new()
                    .set("accountName", account.name.as_str())
                    .set("email", email),
            ),
            None => t.f(
                "connect.signedInToReadUsageFor",
                Args::new().set("accountName", account.name.as_str()),
            ),
        });
        Ok(exit::OK)
    })();
    guard.release();
    result.map_err(|e: Failure| e)
}
