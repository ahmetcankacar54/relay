use std::process::Command;
use std::sync::Arc;

use relay_core::profile_lock::{ProfileLockKind, acquire_profile_lock};
use relay_core::shared::external_links::CLI_SETUP;
use relay_i18n::Args;

use crate::CommandRun;
use crate::accounts::resolve_account;
use crate::claude_cli::exit_code;
use crate::context::{Needs, open_context};
use crate::environment::cli_environment;
use crate::errors::CliResult;
use crate::io::{CliError, Signal, exit};

/// Runs Claude Code as an account: the official CLI with the account's own profile
/// (CLAUDE_CONFIG_DIR), this terminal and folder, holding the shared profile lock so neither
/// Relay.app nor another relay renews its credential meanwhile.
pub fn run(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let Some(query) = positionals
        .first()
        .filter(|q| !q.is_empty() && positionals.len() == 1)
    else {
        return Err(CliError::new(t.t("run.usageRelayRunNameClaudeOptions"), exit::USAGE).into());
    };
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let registry = ctx.store.state();
    let account = resolve_account(&registry.accounts, query, t)?;
    if !account.auth.as_ref().is_some_and(|a| a.logged_in) {
        return Err(CliError::new(
            t.f(
                "run.sClaudeCodeProfileIsNot",
                Args::new().set("accountName", account.name.as_str()),
            ),
            exit::FAILED,
        )
        .into());
    }
    let Some(claude) = (ctx.deps.claude)(registry.executable.as_deref()) else {
        return Err(CliError::new(
            t.f(
                "run.theClaudeCodeCliWasNot",
                Args::new().set("EXTERNAL_LINKSCliSetup", CLI_SETUP),
            ),
            exit::ENVIRONMENT,
        )
        .into());
    };
    let mut guard = acquire_profile_lock(&ctx.paths.locks, &account.id, ProfileLockKind::Shared)?;
    let profile = ctx.store.profile(&account.id)?;
    let result = (|| -> CliResult<i32> {
        let mut child = Command::new(&claude)
            .args(&run.parsed.rest)
            .current_dir(&io.cwd)
            .env_clear()
            .envs(cli_environment(&profile.to_string_lossy(), &io.env))
            .spawn()?;
        let pid = child.id();
        // The terminal sends Ctrl+C to Claude Code itself; passing it on again would double it.
        io.signal(Some(Arc::new(move |signal| {
            if signal != Signal::Int {
                pass_on(pid, signal);
            }
        })));
        Ok(exit_code(child.wait()?))
    })();
    io.signal(None);
    guard.release();
    result
}

fn pass_on(pid: u32, signal: Signal) {
    #[cfg(unix)]
    // SAFETY: kill(2) on a child this process started.
    unsafe {
        libc::kill(pid as libc::pid_t, signal.number());
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_TERMINATE, TerminateProcess,
        };
        // Node's `child.kill(signal)` on Windows ends the process whatever the signal.
        let _ = signal;
        // SAFETY: a handle opened, used and closed here, for a child this process started.
        unsafe {
            let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !handle.is_null() {
                TerminateProcess(handle, 1);
                CloseHandle(handle);
            }
        }
    }
}
