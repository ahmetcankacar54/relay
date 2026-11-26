use relay_core::cli_diagnostics::diagnose_cli;
use relay_core::desktop_host_node::claude_executable;
use relay_core::environment::current_arch;
use relay_core::relay_paths::Platform;
use relay_core::shared::cli_version::reads_usage;
use relay_core::shared::error_text::localize_error;
use relay_core::shared::terminal_identity::{
    DEFAULT_TERMINAL_MODE, TerminalCurrentState, TerminalIdentity, TerminalMode, same_identity,
    terminal_identities,
};
use relay_core::shared::types::Account;
use relay_core::terminal_identity::peek_terminal;
use relay_core::vault_key::{VaultKeyError, read_vault_key};
use relay_core::vault_migration::VaultState;
use relay_i18n::Args;
use serde_json::{Value, json};

use crate::CommandRun;
use crate::context::{Needs, open_context};
use crate::deps::platform_name;
use crate::describe::relay_app_running;
use crate::errors::CliResult;
use crate::guards::older_than;
use crate::io::exit;
use crate::output::{Style, pad_end, paint, print_json};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Ok,
    Warn,
    Fail,
}

impl Status {
    const fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Warn => "warn",
            Status::Fail => "fail",
        }
    }
}

/// An account's terminal identities (`terminalIdentities(account)`).
pub fn identities_of(account: &Account) -> Vec<TerminalIdentity> {
    terminal_identities(
        account
            .desktop
            .as_ref()
            .map(|d| (d.account_uuid.as_str(), d.org_id.as_str())),
        account
            .auth
            .as_ref()
            .map(|a| (a.account_uuid.as_deref(), a.org_id.as_deref())),
    )
}

pub fn doctor(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let mut checks: Vec<(&str, Status, String)> = Vec::new();
    // Off macOS the CLI reads and runs, but leaves saving and switching to Relay.app.
    let mac = ctx.deps.platform == Platform::MacOs;
    let platform = format!("{} {}", platform_name(ctx.deps.platform), current_arch());
    checks.push(if mac {
        ("platform", Status::Ok, platform)
    } else {
        (
            "platform",
            Status::Warn,
            format!(
                "{platform} · {}",
                t.t("srcContext.savingAndSwitchingWorksOnMacosOnly")
            ),
        )
    });
    let app = claude_executable(&ctx.paths.claude_apps);
    checks.push((
        "claude-app",
        if app.is_some() {
            Status::Ok
        } else if mac {
            Status::Fail
        } else {
            Status::Warn
        },
        app.map_or_else(
            || t.t("doctor.theClaudeAppWasNotFound"),
            |p| p.to_string_lossy().into_owned(),
        ),
    ));
    let registry = ctx.store.state();
    let cli = diagnose_cli(
        (ctx.deps.claude)(registry.executable.as_deref()).as_deref(),
        &ctx.paths.data,
    );
    let version = cli.version.clone().unwrap_or_default();
    checks.push((
        "claude-cli",
        if cli.executable.is_none() || cli.error.is_some() || !reads_usage(&version) {
            Status::Warn
        } else {
            Status::Ok
        },
        match (&cli.executable, &cli.error) {
            (None, _) => t.t("doctor.noClaudeCodeCliOnlyNeeded"),
            (Some(_), Some(error)) => localize_error(error, ctx.lang),
            (Some(executable), None) if reads_usage(&version) => {
                format!("{executable} · {version}")
            }
            (Some(_), None) => t.f(
                "doctor.limitsNeed21296Or",
                Args::new().set("cliVersion", version.as_str()),
            ),
        },
    ));
    let data = ctx.paths.data.to_string_lossy().into_owned();
    let data_args = || Args::new().set("pathsData", data.as_str());
    let (folder, folder_detail) = match std::fs::symlink_metadata(&ctx.paths.data) {
        Ok(meta) if meta.file_type().is_symlink() => {
            (Status::Fail, t.f("doctor.isASymbolicLink", data_args()))
        }
        Ok(meta) if private_mode_broken(&meta) => {
            (Status::Warn, t.f("doctor.shouldBePrivate0700", data_args()))
        }
        Ok(_) => (Status::Ok, data.clone()),
        Err(_) => (Status::Warn, t.f("doctor.doesNotExist", data_args())),
    };
    checks.push(("data-folder", folder, folder_detail));
    let app_ok = ctx
        .app_version
        .as_deref()
        .is_some_and(|v| !v.is_empty() && !older_than(v, "0.12.0"));
    checks.push((
        "vault",
        if matches!(
            ctx.vault,
            VaultState::Legacy { .. } | VaultState::Newer { .. }
        ) {
            Status::Fail
        } else {
            Status::Ok
        },
        match ctx.vault {
            VaultState::Legacy { .. } if app_ok => t.t("doctor.oldFormatOpenRelayAppAnd"),
            VaultState::Legacy { .. } => t.t("doctor.oldFormatUpdateRelayAppTo"),
            VaultState::Newer { .. } => t.t("doctor.writtenByANewerRelayUpdate"),
            VaultState::Empty => t.t("doctor.emptyMadeWithTheFirstAccount"),
            VaultState::Ready => t.t("doctor.ready"),
        },
    ));
    if !mac {
        // The vault key is a macOS Keychain item; elsewhere only Relay.app reads it.
    } else if matches!(ctx.vault, VaultState::Ready | VaultState::Newer { .. }) {
        match read_vault_key(&ctx.deps.security_tool) {
            Ok(_) => checks.push(("key", Status::Ok, t.t("doctor.relayVaultKeyIsReadableIn"))),
            Err(error) => checks.push((
                "key",
                Status::Fail,
                match &error {
                    VaultKeyError::Spawn(message) => message.clone(),
                    VaultKeyError::Locked => localize_error(&error.to_string(), ctx.lang),
                    _ => format!(
                        "{} {}",
                        localize_error(&error.to_string(), ctx.lang),
                        t.t("doctor.toStartOverRelayResetVault")
                    ),
                },
            )),
        }
    } else {
        checks.push(("key", Status::Ok, t.t("doctor.madeWithTheFirstAccount")));
    }
    let app_running = (ctx.deps.process_list)()
        .map(|l| relay_app_running(&l))
        .unwrap_or(false);
    let app_version = ctx.app_version.as_deref().filter(|v| !v.is_empty());
    checks.push((
        "relay-app",
        if app_version.is_some_and(|v| older_than(v, "0.12.0")) {
            Status::Fail
        } else {
            Status::Ok
        },
        match app_version {
            Some(v) => format!(
                "{v}{}{}",
                if app_running {
                    t.t("doctor.running")
                } else {
                    t.t("doctor.notRunning")
                },
                if older_than(v, "0.12.0") {
                    t.t("doctor.updateTo012OrLater")
                } else {
                    String::new()
                }
            ),
            None => t.t("doctor.notInstalledNotNeeded"),
        },
    ));
    let holder = ctx.lock.holder();
    checks.push(match &holder {
        Some(h) => (
            "lock",
            Status::Warn,
            format!("{} · {} · {}", lock_by(h), h.kind, h.started_at),
        ),
        None => ("lock", Status::Ok, t.t("doctor.free")),
    });
    let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
    checks.push((
        "desktop",
        if state.pending_profile_id.is_some() || state.recovery_required {
            Status::Warn
        } else {
            Status::Ok
        },
        if state.recovery_required {
            t.t("doctor.interruptedSwitchRelayRecover")
        } else if state.pending_profile_id.is_some() {
            t.t("doctor.pendingSignInRelayAddResume")
        } else {
            t.t("doctor.readyToSwitch")
        },
    ));
    if let Some(terminal) = &ctx.deps.terminal
        && registry
            .settings
            .terminal_cli
            .unwrap_or(DEFAULT_TERMINAL_MODE)
            != TerminalMode::Off
    {
        let accounts = &registry.accounts;
        let known: Vec<TerminalIdentity> = accounts.iter().flat_map(identities_of).collect();
        let now = io.now.clone();
        let seen = peek_terminal(terminal, &known, &move || now());
        let on = match (&seen.account_uuid, &seen.org_id) {
            (Some(u), Some(o)) if !u.is_empty() && !o.is_empty() => {
                let id = TerminalIdentity {
                    account_uuid: u.clone(),
                    org_id: o.clone(),
                };
                accounts
                    .iter()
                    .find(|a| identities_of(a).iter().any(|x| same_identity(x, &id)))
            }
            _ => None,
        };
        let active = state
            .active_profile_id
            .as_deref()
            .and_then(|id| accounts.iter().find(|a| a.id == id));
        let signed_in = seen.state == TerminalCurrentState::SignedIn;
        let status = match (on, active) {
            (Some(on), active) if signed_in && active.is_none_or(|a| a.id == on.id) => Status::Ok,
            _ => Status::Warn,
        };
        let detail = match seen.state {
            TerminalCurrentState::Unreadable => t.t("doctor.couldNotReadTheTerminalClaude"),
            TerminalCurrentState::SignedOut => t.t("doctor.theTerminalClaudeIsSignedOut"),
            _ => match (on, active) {
                (None, _) => t.f(
                    "doctor.theTerminalClaudeIsOnAn",
                    Args::new().set(
                        "join",
                        [seen.email.as_deref(), seen.org_name.as_deref()]
                            .into_iter()
                            .flatten()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join(" · "),
                    ),
                ),
                (Some(on), Some(active)) if active.id != on.id => t.f(
                    "doctor.theTerminalClaudeIsOnDesktop",
                    Args::new()
                        .set("onName", on.name.as_str())
                        .set("activeName", active.name.as_str()),
                ),
                (Some(on), _) => t.f(
                    "doctor.theTerminalClaudeIsOn",
                    Args::new().set("onName", on.name.as_str()),
                ),
            },
        };
        checks.push(("terminal", status, detail));
    }
    // A desktop session and the Automation permission matter only where the CLI quits Claude.
    if mac {
        let gui = (ctx.deps.gui_session)();
        let gui_detail = if (ctx.deps.gui_session)() {
            t.t("doctor.macosDesktopSession")
        } else {
            t.t("doctor.noDesktopSessionSshClaudeCannot")
        };
        checks.push((
            "gui-session",
            if gui { Status::Ok } else { Status::Warn },
            gui_detail,
        ));
        checks.push((
            "automation",
            Status::Ok,
            t.t("doctor.macosAsksForTheAutomationPermission"),
        ));
    }
    let failed = checks.iter().any(|c| c.1 == Status::Fail);
    if ctx.json {
        let items: Vec<Value> = checks
            .iter()
            .map(|(check, status, detail)| json!({ "check": check, "status": status.as_str(), "detail": detail }))
            .collect();
        print_json(io, &Value::Array(items));
    } else {
        for (check, status, detail) in &checks {
            let mark = match status {
                Status::Ok => paint(ctx.color, Style::Green, "✓"),
                Status::Warn => paint(ctx.color, Style::Yellow, "!"),
                Status::Fail => paint(ctx.color, Style::Red, "✗"),
            };
            io.out(&format!("{mark} {} {detail}", pad_end(check, 12)));
        }
    }
    Ok(if failed { exit::ENVIRONMENT } else { exit::OK })
}

fn lock_by(holder: &relay_core::process_lock::LockInfo) -> &'static str {
    match holder.by {
        relay_core::process_lock::LockBy::App => "app",
        relay_core::process_lock::LockBy::Cli => "cli",
        relay_core::process_lock::LockBy::Unknown => "unknown",
    }
}

/// `stat.mode & 0o077`.
fn private_mode_broken(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o077 != 0
    }
    #[cfg(not(unix))]
    {
        // Node reports a Windows folder's mode with group and other bits set (0o40666).
        let _ = meta;
        true
    }
}
