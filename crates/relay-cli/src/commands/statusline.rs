use relay_core::claude_statusline::{
    ClaudeStatuslineError, InstallOutcome, STATUSLINE_PREVIOUS_FILE, UninstallOutcome,
    install_statusline, statusline_command as shell_command, uninstall_statusline,
};
use relay_core::relay_paths::Platform;
use relay_i18n::Args;

use crate::CommandRun;
use crate::context::cli_paths;
use crate::errors::{CliResult, Failure};
use crate::io::{CliError, exit};
use crate::statusline::{
    StatuslineRun, read_statusline_snapshot_in, statusline_color, statusline_text,
};

fn failure(error: ClaudeStatuslineError, t: crate::i18n::T) -> Failure {
    match error {
        ClaudeStatuslineError::SettingsUnreadable(e) => CliError::new(
            t.f(
                "statusline.settingsUnreadable",
                Args::new().set("file", e.file.to_string_lossy().as_ref()),
            ),
            exit::FAILED,
        )
        .into(),
        ClaudeStatuslineError::PrivateJson(e) => e.into(),
        ClaudeStatuslineError::Io(e) => e.into(),
    }
}

/// `relay statusline`: the line Claude Code shows under its prompt. `main` runs the plain form
/// itself (statusline::fast_path); it comes here for `install`, `uninstall`, other flags, and
/// when Relay.app has written no snapshot yet, to say so in the user's language.
pub fn statusline_command(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let positionals = &run.parsed.positionals;
    let sub = positionals.first().map(String::as_str);
    if positionals.len() > 1 || !matches!(sub, None | Some("install") | Some("uninstall")) {
        return Err(CliError::new(t.t("statusline.usage"), exit::USAGE).into());
    }
    let claude_dir = run.deps.transcript_root.clone();
    let previous = cli_paths(&io.env).data.join(STATUSLINE_PREVIOUS_FILE);
    let file = claude_dir.join("settings.json");
    let file_text = file.to_string_lossy().into_owned();
    match sub {
        Some("install") => {
            // This very binary, by its absolute path: Claude Code's non-login shell may not
            // have npm's folder on its PATH.
            let command =
                shell_command(&[run.deps.self_exe.to_string_lossy()], Platform::current());
            let outcome =
                install_statusline(&claude_dir, &previous, &command).map_err(|e| failure(e, t))?;
            io.out(&match outcome {
                InstallOutcome::Already => t.t("statusline.alreadyInstalled"),
                InstallOutcome::Replaced => t.f(
                    "statusline.installedReplaced",
                    Args::new().set("file", file_text.as_str()),
                ),
                InstallOutcome::Installed => t.f(
                    "statusline.installed",
                    Args::new().set("file", file_text.as_str()),
                ),
            });
            return Ok(exit::OK);
        }
        Some(_) => {
            let outcome =
                uninstall_statusline(&claude_dir, &previous).map_err(|e| failure(e, t))?;
            io.out(&t.t(match outcome {
                UninstallOutcome::Restored => "statusline.restored",
                UninstallOutcome::Removed => "statusline.removed",
                UninstallOutcome::NotInstalled => "statusline.notInstalled",
            }));
            return Ok(exit::OK);
        }
        None => {}
    }
    // `.claude.json` sits beside the `.claude` folder, in the home folder.
    let home = relay_core::fs_util::dirname(&claude_dir).to_path_buf();
    let Some(snapshot) = read_statusline_snapshot_in(&io.env, &home) else {
        io.out(&t.t("statusline.noData"));
        return Ok(exit::OK);
    };
    let stdin = io
        .read_input
        .as_ref()
        .map(|read| read())
        .unwrap_or_default();
    let flags = &run.parsed.flags;
    let line = statusline_text(
        &snapshot,
        &StatuslineRun {
            stdin: &stdin,
            config_dir: io.var("CLAUDE_CONFIG_DIR"),
            home,
            now: io.now(),
            color: statusline_color(
                flags.truthy("color"),
                flags.truthy("no-color"),
                io.is_tty,
                io.var_set("NO_COLOR"),
            ),
        },
    );
    if !line.is_empty() {
        io.out(&line);
    }
    Ok(exit::OK)
}
