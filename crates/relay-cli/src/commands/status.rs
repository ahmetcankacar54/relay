use relay_core::desktop_files::read_object;
use relay_core::vault_migration::VaultState;
use relay_i18n::Args;
use serde_json::{Map, Value, json};

use crate::CommandRun;
use crate::context::{Needs, open_context};
use crate::describe::{history_mode_text, lock_holder_text, relay_app_running};
use crate::errors::{CliResult, seconds_since};
use crate::inside_desktop::{WorkerRecord, last_worker_record, write_worker_record};
use crate::output::{Style, paint, print_json};

/// `ctx.vault.kind`.
pub fn vault_kind(vault: &VaultState) -> &'static str {
    match vault {
        VaultState::Empty => "empty",
        VaultState::Ready => "ready",
        VaultState::Legacy { .. } => "legacy",
        VaultState::Newer { .. } => "newer",
    }
}

pub fn status(run: &CommandRun<'_>) -> CliResult<i32> {
    let (io, t) = (run.io, run.t);
    let ctx = open_context(io, run.deps, &run.parsed.flags, Needs::READ)?;
    let state = ctx.desktop.snapshot().map_err(|e| ctx.desktop_failure(e))?;
    let registry = ctx.store.state();
    let accounts = &registry.accounts;
    let active = accounts
        .iter()
        .find(|a| Some(a.id.as_str()) == state.active_profile_id.as_deref());
    let mut pending_sign_in: Option<(String, Option<String>)> = None;
    if let Some(pending_id) = &state.pending_profile_id {
        let pending = read_object(&ctx.paths.vault, "pending.json").ok().flatten();
        let since = pending.and_then(|p| {
            p.get("startedAt")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        let name = accounts
            .iter()
            .find(|a| &a.id == pending_id)
            .map_or_else(|| pending_id.clone(), |a| a.name.clone());
        pending_sign_in = Some((name, since));
    }
    let app_running = (ctx.deps.process_list)()
        .map(|l| relay_app_running(&l))
        .unwrap_or(false);
    let holder = ctx.lock.holder();
    let history_mode = registry.settings.desktop_history_transfer;
    let last: Option<WorkerRecord> = last_worker_record(&ctx.paths.cli_operations);
    if ctx.json {
        let mut desktop = Map::new();
        desktop.insert("installed".into(), json!(state.available));
        desktop.insert("running".into(), json!(state.running));
        if let Some(uuid) = state
            .current_account_uuid
            .as_deref()
            .filter(|u| !u.is_empty())
        {
            let mut account = Map::new();
            if let Some(active) = active {
                account.insert("id".into(), json!(active.id));
                account.insert("name".into(), json!(active.name));
                if let Some(org) = active.desktop.as_ref().map(|d| d.org_id.clone()) {
                    account.insert("orgId".into(), json!(org));
                }
            }
            account.insert("accountUuid".into(), json!(uuid));
            desktop.insert("account".into(), Value::Object(account));
        }
        if let Some((name, since)) = &pending_sign_in {
            let mut pending = Map::new();
            pending.insert("name".into(), json!(name));
            if let Some(since) = since {
                pending.insert("since".into(), json!(since));
            }
            desktop.insert("pendingSignIn".into(), Value::Object(pending));
        }
        desktop.insert("recoveryRequired".into(), json!(state.recovery_required));
        let mut relay = Map::new();
        relay.insert("appRunning".into(), json!(app_running));
        if let Some(version) = ctx.app_version.as_deref().filter(|v| !v.is_empty()) {
            relay.insert("appVersion".into(), json!(version));
        }
        relay.insert("vault".into(), json!(vault_kind(&ctx.vault)));
        if let Some(holder) = &holder {
            relay.insert(
                "lock".into(),
                json!({ "by": holder.by, "kind": holder.kind, "since": holder.started_at }),
            );
        }
        relay.insert("historyMode".into(), json!(history_mode.as_str()));
        if let Some(last) = &last {
            let mut op = Map::new();
            op.insert("command".into(), json!(last.argv.join(" ")));
            op.insert("status".into(), json!(last.status));
            if let Some(at) = last.finished_at.as_deref().filter(|v| !v.is_empty()) {
                op.insert("finishedAt".into(), json!(at));
            }
            if let Some(error) = last.error.as_deref().filter(|v| !v.is_empty()) {
                op.insert("error".into(), json!(error));
            }
            relay.insert("lastOperation".into(), Value::Object(op));
        }
        print_json(io, &json!({ "desktop": desktop, "relay": relay }));
        return Ok(0);
    }
    let who = match (
        active,
        state
            .current_account_uuid
            .as_deref()
            .filter(|u| !u.is_empty()),
    ) {
        (Some(active), _) => Some(active.name.clone()),
        (None, Some(uuid)) => Some(t.f(
            "status.anUnsavedAccount",
            Args::new().set("slice", slice8(uuid)),
        )),
        (None, None) => None,
    };
    let desktop_line = if !state.available {
        t.t("status.notInstalled")
    } else {
        [
            if state.running {
                paint(ctx.color, Style::Green, &t.t("status.running"))
            } else {
                t.t("status.notRunning")
            },
            match who {
                Some(who) => t.f("status.signedInAs", Args::new().set("who", who)),
                None => t.t("status.notSignedIn"),
            },
        ]
        .join(" · ")
    };
    let mut lines = vec![format!("{}: {desktop_line}", t.t("common.claudeApp"))];
    if let Some((name, _)) = &pending_sign_in {
        lines.push(
            paint(
                ctx.color,
                Style::Yellow,
                &t.f(
                    "status.pendingSignIn",
                    Args::new().set("pendingSignInName", name.as_str()),
                ),
            ) + &t.t("status.finishWithRelayAddResumeCancel"),
        );
    }
    if state.recovery_required {
        lines.push(paint(
            ctx.color,
            Style::Red,
            &t.t("status.aSwitchWasInterruptedRelayRecover"),
        ));
    }
    let version = ctx.app_version.as_deref().filter(|v| !v.is_empty());
    lines.push(format!(
        "Relay.app: {}",
        match (app_running, version) {
            (true, Some(v)) => t.f("status.running2", Args::new().set("version", v)),
            (true, None) => t.t("status.running"),
            (false, Some(v)) => t.f(
                "status.installedNotRunning",
                Args::new().set("ctxAppVersion", v)
            ),
            (false, None) => t.t("status.notInstalled"),
        }
    ));
    if let Some(holder) = &holder {
        lines.push(
            t.f(
                "status.lockS",
                Args::new()
                    .set("lockHolderText", lock_holder_text(holder, t))
                    .set("seconds", seconds_since(&holder.started_at, io.now())),
            ),
        );
    }
    if matches!(ctx.vault, VaultState::Legacy { .. }) {
        lines.push(t.t("status.vaultOldFormatUpdateRelayApp"));
    }
    if matches!(ctx.vault, VaultState::Newer { .. }) {
        lines.push(t.t("status.vaultWrittenByANewerRelay"));
    }
    lines.push(t.f(
        "status.codeHistory",
        Args::new().set("historyModeText", history_mode_text(history_mode, t)),
    ));
    // A worker's result is shown once, after it ends; while it runs, every time.
    if let Some(last) = last.filter(|l| l.shown != Some(true)) {
        let what = format!("relay {}", last.argv.join(" "));
        if last.status == "pending" || last.status == "running" {
            lines.push(t.f(
                "status.runningInASeparateProcess",
                Args::new().set("what", what.as_str()),
            ));
        } else {
            lines.push(if last.status == "done" {
                paint(
                    ctx.color,
                    Style::Green,
                    &t.f("status.done", Args::new().set("what", what.as_str())),
                )
            } else {
                paint(
                    ctx.color,
                    Style::Red,
                    &t.f(
                        "status.failed",
                        Args::new()
                            .set("what", what.as_str())
                            .set("p1", last.error.clone().unwrap_or_default()),
                    ),
                )
            });
            // Shown again next time when this fails.
            let _ = write_worker_record(
                &ctx.paths.cli_operations,
                &WorkerRecord {
                    shown: Some(true),
                    ..last
                },
            );
        }
    }
    for line in lines {
        io.out(&line);
    }
    Ok(0)
}

/// `text.slice(0, 8)` in UTF-16 units.
pub fn slice8(text: &str) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(8).collect::<Vec<_>>())
}
