//! Accounts: their planning and switch line, sign-ins, terminals, and the files Relay asks the
//! user to pick (port of electron/main/ipc/accounts.ts).

use std::path::PathBuf;

use relay_core::account_removal::DesktopFacts;
use relay_core::clock::now_ms;
use relay_core::environment::{DesktopExecutableOptions, is_claude_desktop_executable};
use relay_core::fs_util::iso_timestamp;
use relay_core::host::FileDialog;
use relay_core::limit_notice::LimitWindowKind;
use relay_core::remote_notify::{RemoteEventName, RemoteNotice};
use relay_core::service::ServiceRemoval;
use relay_core::shared::feature_risk::antigravity_account_risks;
use relay_core::shared::remote_notify::REMOTE_NOTIFY_URL_MAX;
use relay_core::shared::types::{
    AccountPlanning, AccountProvider, CreateAccount, RemoteNotifyKind,
};
use relay_core::store::schema::{self, StringRule};
use relay_core::store::{account_planning_schema, create_account_schema};
use serde::Deserialize;

use super::{Call, Callers, IpcResult, OrMessage, Registry, done, int, reply, require_risk};
use crate::i18n::say;
use crate::services::desktop_lock::{DESKTOP_LOCK, manual_desktop_lock, profile_locks};
use crate::services::tray_setup::update_tray;
use crate::state::STATE;

const DESKTOP_BUSY_PREFERENCES: &str = "Finish the Desktop operation before changing preferences.";
const REFRESHING: &str = "Wait for the account connection refresh to finish.";

pub fn register(registry: &mut Registry) {
    registry.handle("account-planning", account_planning);
    registry.handle("account-switch-at", account_switch_at);
    registry.handle("test-remote-notify", test_remote_notify);
    registry.handle("create-account", create_account);
    registry.handle("update-account", update_account);
    registry.handle("remove-account", remove_account);
    registry.handle("check-auth", check_auth);
    registry.handle("login", login);
    registry.handle("reopen-login", reopen_login);
    registry.handle("cancel-login", cancel_login);
    registry.handle("submit-login-code", submit_login_code);
    registry.handle("close-run", close_run);
    registry.handle("launch", launch);
    registry.handle("switch-account", switch_account);
    registry.handle("pick-folder", pick_folder);
    registry.handle("pick-executable", pick_executable);
    registry.handle("pick-claude-app", pick_claude_app);
    registry.handle("import", import);
    registry.handle("pin", pin);
    registry.handle("cooldown", cooldown);
    registry.handle("transcript", transcript);
    registry.handle("buffer", buffer);
    registry.handle("stop", stop);
    registry.on("write", Callers::Relay, write);
    registry.on("resize", Callers::Relay, resize);
}

fn desktop_busy() -> bool {
    STATE.desktop().is_busy() || DESKTOP_LOCK.busy()
}

/// `keeper.resume(); void keeper.tick();`: the plan is made again.
fn replan() {
    STATE.keeper().resume();
    std::thread::spawn(|| {
        let _ = STATE.keeper().tick();
    });
}

fn account_planning(call: &Call) -> IpcResult {
    if desktop_busy() {
        return Err(DESKTOP_BUSY_PREFERENCES.into());
    }
    let store = &STATE.service().store;
    let account = store.account(&call.id(0)?).msg()?;
    let planning: AccountPlanning = call.parse(1, &account_planning_schema())?;
    store
        .update(|s| {
            if let Some(saved) = s.accounts.iter_mut().find(|a| a.id == account.id) {
                saved.planning = Some(planning);
            }
        })
        .msg()?;
    // Capacity shapes the plan: replan as after a planning edit.
    replan();
    reply(store.account(&account.id).msg()?)
}

/// An account's own switch line: the ranking, the suggestion and preparing on quit read it next.
fn account_switch_at(call: &Call) -> IpcResult {
    if desktop_busy() {
        return Err(DESKTOP_BUSY_PREFERENCES.into());
    }
    let store = &STATE.service().store;
    let account = store.account(&call.id(0)?).msg()?;
    let percent: Option<f64> = call.opt_parse(1, &int(50.0, 100.0))?;
    store
        .update(|s| {
            if let Some(saved) = s.accounts.iter_mut().find(|a| a.id == account.id) {
                saved.switch_at_percent = percent;
            }
        })
        .msg()?;
    crate::events::changed();
    reply(store.account(&account.id).msg()?)
}

#[derive(Deserialize)]
struct RemoteTest {
    url: String,
    kind: RemoteNotifyKind,
}

/// A sample event to the URL in the form, saved or not; the answer never holds the URL.
fn test_remote_notify(call: &Call) -> IpcResult {
    let target: RemoteTest = call.parse(
        0,
        &schema::strict(vec![
            (
                "url",
                schema::string(StringRule {
                    max: Some(REMOTE_NOTIFY_URL_MAX),
                    ..StringRule::default()
                }),
            ),
            ("kind", schema::enumeration(["ntfy", "webhook"])),
        ]),
    )?;
    let notice = RemoteNotice {
        event: RemoteEventName::Test,
        account_name: Some(say("electronMain.remoteTestAccount")),
        window: Some(LimitWindowKind::FiveHour),
        used_percent: Some(90.0),
        resets_at: Some(iso_timestamp(now_ms() + 2 * 3_600_000)),
        title: say("electronMain.remoteTestTitle"),
        message: say("electronMain.remoteTestBody"),
    };
    reply(crate::services::notifications::remote_notifier().test(&target.url, target.kind, &notice))
}

fn create_account(call: &Call) -> IpcResult {
    let account: CreateAccount = call.parse(0, &create_account_schema())?;
    if account.provider == Some(AccountProvider::Antigravity) {
        require_risk(&antigravity_account_risks(
            crate::services::gateway::proxy_settings().enabled,
        ))?;
    }
    reply(STATE.service().store.create(&account).msg()?)
}

fn update_account(call: &Call) -> IpcResult {
    let id = call.id(0)?;
    let input: CreateAccount = call.parse(1, &create_account_schema())?;
    let updated = STATE.service().store.edit(&id, &input).msg()?;
    update_tray();
    crate::events::changed();
    reply(updated)
}

/// Under the Desktop lock, so no switch to the account starts while it goes. Its usage history
/// and token counts stay: they are the user's record; its profile's transcripts are gone.
fn remove_account(call: &Call) -> IpcResult {
    let account = call.id(0)?;
    if STATE.desktop().is_busy() {
        return Err("Finish the Desktop handoff before starting another Desktop operation.".into());
    }
    let service = STATE.service();
    let removed = manual_desktop_lock(|| {
        service.transaction(|| {
            crate::services::antigravity::stop_bridge(&account);
            crate::services::antigravity::clear_pending(&account);
            let vault = STATE.paths().data_dir().join("desktop-vault");
            let locks = profile_locks();
            let desktop = || -> Result<DesktopFacts, String> {
                let state = STATE.desktop().snapshot().msg()?;
                Ok(DesktopFacts {
                    active_profile_id: state.active_profile_id,
                    pending_profile_id: state.pending_profile_id,
                })
            };
            let removed = service.remove(
                &account,
                &ServiceRemoval {
                    vault: &vault,
                    locks: &locks,
                    desktop: &desktop,
                },
            )?;
            STATE.usage().forget(&account);
            // remove_account took it out of proxy-pool.json; the gateway forgets its sessions.
            crate::services::gateway::reset_proxy_extras_cache();
            crate::services::gateway::evict_account(&account);
            // Its Antigravity app sign-in kept in the vault goes with it, like every other
            // sign-in Relay keeps.
            if let Some(switcher) = STATE.antigravity_switcher.get() {
                let _ = switcher.forget(&account);
            }
            let forget = account.clone();
            std::thread::spawn(move || {
                let _ = STATE.webviews().forget_sign_in_session(&forget);
            });
            replan();
            std::thread::spawn(|| STATE.auto_switch().tick());
            Ok::<_, relay_core::service::ServiceError>(removed)
        })
    });
    update_tray();
    crate::events::changed();
    reply(removed?)
}

fn check_auth(call: &Call) -> IpcResult {
    let service = STATE.service();
    service.transaction(|| {
        let account = call.id(0)?;
        if STATE.usage_credential_refresher().is_refreshing(&account) {
            return Err(REFRESHING.into());
        }
        let checked = service.check_auth(&account).msg()?;
        let _ = crate::services::desktop_support::align_desktop_workspace(&checked);
        reply(service.store.account(&account).msg()?)
    })
}

fn login(call: &Call) -> IpcResult {
    if DESKTOP_LOCK.busy() {
        return Err("Finish the Desktop handoff before signing in.".into());
    }
    let service = STATE.service();
    service.transaction(|| {
        let account = call.id(0)?;
        if STATE.usage_credential_refresher().is_refreshing(&account) {
            return Err(REFRESHING.into());
        }
        reply(service.login(&account).msg()?)
    })
}

fn reopen_login(call: &Call) -> IpcResult {
    let (account, attempt) = (call.id(0)?, call.id(1)?);
    let place = call.opt_one_of(2, &["window", "browser"])?;
    STATE
        .service()
        .auth
        .reopen(&account, &attempt, place.as_deref() == Some("window"))
        .msg()?;
    done()
}

fn cancel_login(call: &Call) -> IpcResult {
    let (account, attempt) = (call.id(0)?, call.id(1)?);
    STATE.service().auth.cancel(&account, &attempt).msg()?;
    done()
}

fn submit_login_code(call: &Call) -> IpcResult {
    let (account, attempt) = (call.id(0)?, call.id(1)?);
    let code: String = call.parse(
        2,
        &schema::string(StringRule {
            max: Some(4096),
            ..StringRule::default()
        }),
    )?;
    STATE
        .service()
        .auth
        .submit_code(&account, &attempt, &code)
        .msg()?;
    done()
}

fn close_run(call: &Call) -> IpcResult {
    STATE.service().runner.close(&call.id(0)?).msg()?;
    done()
}

fn launch(call: &Call) -> IpcResult {
    let service = STATE.service();
    service.transaction(|| reply(service.launch(call.arg(0)).msg()?))
}

fn switch_account(call: &Call) -> IpcResult {
    let service = STATE.service();
    service.transaction(|| {
        let (run, account) = (call.id(0)?, call.id(1)?);
        reply(service.switch_account(&run, &account).msg()?)
    })
}

fn pick_folder(_call: &Call) -> IpcResult {
    let app = crate::state::app().ok_or("Relay has no window.")?;
    let picked = crate::host::pick_folder(app, &say("electronMain.selectTheProjectFolder"));
    reply(picked.map(|path| path.to_string_lossy().into_owned()))
}

/// An open panel for one file (`properties: ["openFile"]`), starting in `directory`.
fn pick_file(title: &str, directory: Option<PathBuf>) -> Option<PathBuf> {
    STATE.shell().open_dialog(&FileDialog {
        title: title.to_owned(),
        default_path: directory,
        ..FileDialog::default()
    })
}

fn pick_executable(_call: &Call) -> IpcResult {
    // The official installer puts `claude` in the hidden ~/.local/bin.
    let installed = relay_core::relay_paths::home_dir()
        .join(".local")
        .join("bin");
    let opens_there = installed.is_dir();
    let Some(path) = pick_file(
        &say("electronMain.selectTheClaudeCodeCliFile"),
        opens_there.then_some(installed),
    ) else {
        return done();
    };
    let file = path.to_string_lossy().into_owned();
    // Claude Desktop is not the CLI: running it for `auth status` or `--version` only opens it.
    if is_claude_desktop_executable(&file, &DesktopExecutableOptions::default()) {
        return Err(say("electronMain.thisFileIsTheClaudeDesktop"));
    }
    let service = STATE.service();
    service.store.update(|s| s.executable = Some(file)).msg()?;
    service.diagnose();
    done()
}

fn pick_claude_app(_call: &Call) -> IpcResult {
    let applications = cfg!(target_os = "macos").then(|| PathBuf::from("/Applications"));
    let Some(path) = pick_file(&say("electronMain.selectTheClaudeApp"), applications) else {
        return done();
    };
    // The store's change reaches every window, which reads the Desktop state again.
    let app = path.to_string_lossy().into_owned();
    STATE
        .service()
        .store
        .update(|s| s.claude_app = Some(app))
        .msg()?;
    done()
}

fn import(_call: &Call) -> IpcResult {
    STATE
        .service()
        .store
        .update(|s| s.import_enabled = true)
        .msg()?;
    done()
}

fn pin(call: &Call) -> IpcResult {
    let (key, pinned) = (call.key(0)?, call.bool(1)?);
    STATE.service().pin(&key, pinned).msg()?;
    done()
}

fn cooldown(call: &Call) -> IpcResult {
    let (account, hours) = (call.id(0)?, call.int(1, 0.0, 168.0)?);
    STATE.service().cooldown(&account, hours as f64).msg()?;
    done()
}

fn transcript(call: &Call) -> IpcResult {
    reply(STATE.service().transcript(&call.key(0)?).msg()?)
}

fn buffer(call: &Call) -> IpcResult {
    let buffer = STATE.service().runner.buffer(&call.id(0)?).msg()?;
    reply(serde_json::json!({
        "data": buffer.data,
        "sequence": buffer.sequence,
        "status": buffer.status,
    }))
}

fn stop(call: &Call) -> IpcResult {
    STATE.service().runner.stop(&call.id(0)?).msg()?;
    done()
}

/// Invalid one-way messages are ignored.
fn write(call: &Call) -> Result<(), String> {
    let _ = (|| -> Result<(), String> {
        let run = call.id(0)?;
        let data: String = call.parse(
            1,
            &schema::string(StringRule {
                max: Some(64_000),
                ..StringRule::default()
            }),
        )?;
        STATE.service().runner.write(&run, &data).msg()
    })();
    Ok(())
}

/// Invalid one-way messages are ignored.
fn resize(call: &Call) -> Result<(), String> {
    let _ = (|| -> Result<(), String> {
        let run = call.id(0)?;
        let cols = call.int(1, 10.0, 500.0)?;
        let rows = call.int(2, 3.0, 200.0)?;
        STATE
            .service()
            .runner
            .resize(&run, cols as u16, rows as u16)
            .msg()
    })();
    Ok(())
}
