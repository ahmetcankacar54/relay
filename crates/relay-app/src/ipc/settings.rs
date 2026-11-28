//! Settings and planning, usage reads, Claude Code's status line and the Claude app's sign-in
//! (port of electron/main/ipc/settings.ts).

use std::collections::HashSet;

use relay_core::claude_statusline::{
    ClaudeStatuslineError, STATUSLINE_PREVIOUS_FILE, install_statusline, statusline_command,
    statusline_setup, uninstall_statusline,
};
use relay_core::relay_cli_path::{FindRelayCliOptions, find_relay_cli};
use relay_core::relay_paths::{Platform, home_dir};
use relay_core::shared::feature_risk::{meter_risks, planning_risks};
use relay_core::shared::meters::MeterProvider;
use relay_core::shared::types::{PlanningSettings, RelaySettings, UpdateChannel, UsageIssue};
use relay_core::store::schema::boolean;
use relay_core::store::{planning_patch_schema, planning_schema, settings_patch_schema};
use serde_json::{Value, json};

use super::{Call, IpcResult, OrMessage, Registry, reply, require_risk, zod_message};
use crate::i18n::say_with;
use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::state::{STATE, lock};

pub fn register(registry: &mut Registry) {
    registry.handle("update-settings", update_settings);
    registry.handle("update-planning", update_planning);
    registry.handle("refresh-usage", refresh_usage);
    registry.handle("claude-statusline", claude_statusline);
    registry.handle("claude-app-access", claude_app_access);
    registry.handle("renew-sign-in-now", renew_sign_in_now);
}

fn refuse_while_busy() -> Result<(), String> {
    if STATE.desktop().is_busy() || DESKTOP_LOCK.busy() {
        return Err("Finish the Desktop operation before changing preferences.".into());
    }
    Ok(())
}

const SELECT_EXISTING: &str = "Select existing Relay accounts once each.";

/// `Object.assign(target, patch)` over their JSON: each key the patch has replaces the target's.
fn assign<T: serde::Serialize + serde::de::DeserializeOwned>(
    target: &T,
    patch: &Value,
) -> Result<T, String> {
    let mut merged = serde_json::to_value(target).msg()?;
    if let (Some(merged), Some(patch)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(merged).msg()
}

fn update_settings(call: &Call) -> IpcResult {
    refuse_while_busy()?;
    let patch = call.value(0, &settings_patch_schema())?;
    let service = STATE.service();
    let current = STATE.settings();
    let meters: Option<Vec<MeterProvider>> = patch
        .get("meters")
        .map(|meters| serde_json::from_value(meters.clone()))
        .transpose()
        .msg()?;
    if let Some(meters) = &meters {
        require_risk(&meter_risks(current.meters.as_deref(), Some(meters)))?;
    }
    let accounts = STATE.accounts();
    for key in ["desktopHistoryAccounts", "autoSwitchAccounts"] {
        let Some(selected) = patch.get(key).and_then(Value::as_array) else {
            continue;
        };
        let ids: Vec<&str> = selected.iter().filter_map(Value::as_str).collect();
        let unique: HashSet<&str> = ids.iter().copied().collect();
        if unique.len() != ids.len()
            || ids
                .iter()
                .any(|id| !accounts.iter().any(|account| account.id == *id))
        {
            return Err(SELECT_EXISTING.into());
        }
    }
    let retype = crate::services::logs::draft_retype();
    let launch_at_login = current.launch_at_login;
    let channel_of =
        |settings: &RelaySettings| settings.update_channel.unwrap_or(UpdateChannel::Stable);
    let update_channel = channel_of(&current);
    let mut failure = None;
    service
        .store
        .update(|state| match assign(&state.settings, &patch) {
            Ok(next) => state.settings = next,
            Err(error) => failure = Some(error),
        })
        .msg()?;
    if let Some(error) = failure {
        return Err(error);
    }
    let settings = STATE.settings();
    crate::boot::vault::apply_theme(&settings);
    if settings.launch_at_login != launch_at_login {
        std::thread::spawn(crate::services::login_item::apply_launch_at_login);
    }
    if patch.get("shortcuts").is_some()
        && let Some(shortcuts) = STATE.global_shortcuts.get()
    {
        lock(shortcuts).apply(settings.shortcuts.as_ref());
    }
    if channel_of(&settings) != update_channel {
        crate::services::updates::channel_changed();
    }
    STATE.usage().tick();
    // A meter just turned on is read now; the others wait for their interval.
    if meters.is_some() {
        crate::services::notifications::meters_tick();
    }
    let auto_switch = STATE.auto_switch().clone();
    std::thread::spawn(move || auto_switch.tick());
    // Turned off, the drafts still pending go to Copy now, not at the next switch.
    if crate::services::logs::draft_retype() != retype {
        let drafts = STATE.draft_restore().clone();
        std::thread::spawn(move || drafts.retype_changed());
    }
    reply(settings)
}

fn update_planning(call: &Call) -> IpcResult {
    refuse_while_busy()?;
    let patch = call.value(0, &planning_patch_schema())?;
    let planning = STATE.settings().planning;
    require_risk(&planning_risks(
        planning.auto_start,
        patch.get("autoStart").and_then(Value::as_bool),
    ))?;
    let mut merged = serde_json::to_value(&planning).msg()?;
    if let (Some(merged), Some(patch)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            merged.insert(key.clone(), value.clone());
        }
    }
    let next = planning_schema()
        .parse(&merged)
        .map_err(|e| zod_message(&e))?;
    let next: PlanningSettings = serde_json::from_value(next).msg()?;
    let accounts = STATE.accounts();
    if next
        .accounts
        .iter()
        .any(|planned| !accounts.iter().any(|account| account.id == planned.id))
    {
        return Err(SELECT_EXISTING.into());
    }
    STATE
        .service()
        .store
        .update(|state| state.settings.planning = next.clone())
        .msg()?;
    let keeper = STATE.keeper().clone();
    keeper.resume();
    std::thread::spawn(move || {
        let _ = keeper.tick();
    });
    reply(next)
}

fn refresh_usage(call: &Call) -> IpcResult {
    let id = call.id(0)?;
    let allow_prompt: Option<bool> = call.opt_parse(1, &boolean())?;
    reply(
        STATE
            .usage()
            .refresh(&id, allow_prompt.unwrap_or(false))
            .msg()?,
    )
}

fn statusline_failure(error: ClaudeStatuslineError) -> String {
    match error {
        ClaudeStatuslineError::SettingsUnreadable(error) => say_with(
            "statusline.settingsUnreadable",
            &relay_i18n::Args::new().set("file", error.file.to_string_lossy().into_owned()),
        ),
        other => other.to_string(),
    }
}

/// Relay in Claude Code's status line (`relay statusline`), as `relay statusline
/// install|uninstall` sets it; `enable` turns it on or off, then the state comes back with where
/// relay is installed. Without an installed relay it is never turned on: Claude Code would run a
/// missing command.
fn claude_statusline(call: &Call) -> IpcResult {
    let enable: Option<bool> = call.opt_parse(0, &boolean())?;
    let claude_dir = home_dir().join(".claude");
    let previous = STATE.paths().data_dir().join(STATUSLINE_PREVIOUS_FILE);
    let cli = find_relay_cli(FindRelayCliOptions::default());
    if enable == Some(true)
        && let Some(cli) = &cli
    {
        let command = statusline_command(&[cli.to_string_lossy()], Platform::current());
        install_statusline(&claude_dir, &previous, &command).map_err(statusline_failure)?;
    }
    if enable == Some(false) {
        uninstall_statusline(&claude_dir, &previous).map_err(statusline_failure)?;
    }
    let mut setup =
        serde_json::to_value(statusline_setup(&claude_dir).map_err(statusline_failure)?).msg()?;
    if let (Some(setup), Some(cli)) = (setup.as_object_mut(), cli) {
        setup.insert("cli".into(), json!(cli.to_string_lossy()));
    }
    Ok(setup)
}

fn claude_app_access(call: &Call) -> IpcResult {
    let ask: Option<bool> = call.opt_parse(0, &boolean())?;
    let reader = crate::services::desktop_usage::desktop_usage_reader();
    let Some(reader) = reader.filter(|_| cfg!(target_os = "macos")) else {
        return Ok(json!({ "supported": false, "allowed": false }));
    };
    let allowed = crate::services::desktop_usage::desktop_usage_allowed;
    if ask == Some(true) {
        // A refusal comes back as the state below; it is not an error to show.
        let _ = reader.allow_keychain();
        if allowed() {
            // Reads and renewals that waited for it run now, not at their next turn.
            let usage = STATE.usage().clone();
            let snapshot = usage.snapshot();
            for account in STATE.accounts() {
                if snapshot
                    .get(&account.id)
                    .is_some_and(|read| read.issue == Some(UsageIssue::Expired))
                {
                    let usage = usage.clone();
                    std::thread::spawn(move || {
                        let _ = usage.refresh(&account.id, true);
                    });
                }
            }
            if let Some(renewal) = STATE.sign_in_renewal.get() {
                let renewal = renewal.clone();
                std::thread::spawn(move || renewal.retry_unavailable());
            }
        }
    }
    Ok(json!({ "supported": true, "allowed": allowed() }))
}

fn renew_sign_in_now(call: &Call) -> IpcResult {
    let account = STATE.service().store.account(&call.id(0)?).msg()?;
    let Some(renewal) = STATE.sign_in_renewal.get() else {
        return Ok(json!({ "result": "unavailable", "detail": "only on macOS" }));
    };
    let outcome = renewal.renew_now(&account);
    crate::events::changed();
    reply(outcome)
}
