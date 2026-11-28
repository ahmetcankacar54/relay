//! The Claude app: its extension and terminal sign-ins, captures and switches, history, and
//! the panel's messages (port of electron/main/ipc/desktop.ts).

use relay_core::antigravity_app::open_antigravity_app;
use relay_core::code_tab::{CODE_TAB_TIMEOUT_MS, CodeTabDeps, open_code_tab};
use relay_core::desktop::DesktopSwitchOptions;
use relay_core::provider_discovery::{
    HookError, OneClickCascadeDeps, OneClickError, ProviderDiscoveryPaths, detect_providers,
    execute_one_click_cascade,
};
use relay_core::shared::routes::{PAGES, PageIntent};
use serde_json::{Value, json};

use super::{Call, Callers, IpcResult, OrMessage, Registry, Sender, done, reply, zod_message};
use crate::services::desktop_lock::{DESKTOP_LOCK, manual_desktop_lock};
use crate::services::notifications::{notify_extension_left, notify_switched};
use crate::state::STATE;
use crate::windows::panel::TrayPanel;

pub fn register(registry: &mut Registry) {
    registry.handle("extension-status", extension_status);
    registry.handle("extension-sync", extension_sync);
    registry.handle("extension-web", extension_web);
    registry.handle("extension-settings", extension_settings);
    registry.handle("extension-check", extension_check);
    registry.handle("extension-link", extension_link);
    registry.handle("terminal-status", terminal_status);
    registry.handle("terminal-check", terminal_check);
    registry.handle("terminal-sync", terminal_sync);
    registry.handle("terminal-link", terminal_link);
    registry.handle("terminal-link-cancel", terminal_link_cancel);
    registry.handle("detect-providers", detect);
    registry.handle("one-click-connect", one_click_connect);
    registry.handle("desktop-snapshot", desktop_snapshot);
    registry.handle("dismiss-desktop-error", dismiss_desktop_error);
    registry.handle("capture-desktop", capture_desktop);
    registry.handle("begin-desktop-login", begin_desktop_login);
    registry.handle("cancel-desktop-login", cancel_desktop_login);
    registry.handle("arm-auto-capture", arm_auto_capture);
    registry.handle("disarm-auto-capture", disarm_auto_capture);
    registry.handle("choose-auto-capture-org", choose_auto_capture_org);
    registry.handle("switch-desktop", switch_desktop);
    registry.handle("take-switch-request", take_switch_request);
    registry.handle("open-page", open_page);
    registry.handle("quit", quit);
    registry.on("panel-size", Callers::Panel, panel_size);
    registry.on("panel-close", Callers::Panel, panel_close);
    registry.on("switch-ready", Callers::Switch, switch_ready);
    registry.handle("sync-desktop-history", sync_desktop_history);
    registry.handle("desktop-history-summary", desktop_history_summary);
    registry.handle("open-desktop", open_desktop);
    registry.handle("open-antigravity", open_antigravity);
    registry.handle("open-code-tab", open_code);
    registry.handle("recover-desktop", recover_desktop);
}

fn hide_panel() {
    if let Some(panel) = TrayPanel::current() {
        panel.hide();
    }
}

fn extension_status(_call: &Call) -> IpcResult {
    reply(STATE.desktop().extension_status())
}

/// The panel's extension offer follows a sync at once. Not a check: the settings card checks
/// again whenever the settings it reads change, and a broadcast would bring it new ones.
fn extension_sync(_call: &Call) -> IpcResult {
    let result = STATE.desktop().sync_extension();
    crate::events::changed();
    reply(result.msg()?)
}

fn extension_web(_call: &Call) -> IpcResult {
    STATE.desktop().open_claude_web().msg()?;
    done()
}

fn extension_settings(_call: &Call) -> IpcResult {
    if let Some(app) = crate::state::app() {
        crate::windows::main::open_page(app, "gecis", None);
    }
    hide_panel();
    done()
}

fn extension_check(_call: &Call) -> IpcResult {
    reply(STATE.desktop().check_extension(None).msg()?)
}

fn extension_link(call: &Call) -> IpcResult {
    let account_id = call.id(0)?;
    reply(STATE.desktop().check_extension(Some(&account_id)).msg()?)
}

fn terminal_status(_call: &Call) -> IpcResult {
    reply(STATE.desktop().terminal_status())
}

fn terminal_check(_call: &Call) -> IpcResult {
    reply(STATE.desktop().check_terminal())
}

fn terminal_sync(_call: &Call) -> IpcResult {
    let result = STATE.desktop().sync_terminal();
    crate::events::changed();
    reply(result.msg()?)
}

fn terminal_link(call: &Call) -> IpcResult {
    let account_id = call.id(0)?;
    let service = STATE.service();
    reply(
        service
            .transaction(|| service.link_terminal(&account_id))
            .msg()?,
    )
}

fn terminal_link_cancel(call: &Call) -> IpcResult {
    let (account_id, attempt_id) = (call.id(0)?, call.id(1)?);
    STATE
        .service()
        .terminal_auth
        .cancel(&account_id, &attempt_id)
        .msg()?;
    done()
}

fn detect(_call: &Call) -> IpcResult {
    reply(detect_providers(
        &STATE.accounts(),
        &ProviderDiscoveryPaths {
            claude_desktop_root: Some(STATE.desktop().root.clone()),
            ..ProviderDiscoveryPaths::default()
        },
    ))
}

fn one_click_connect(call: &Call) -> IpcResult {
    let desktop = STATE.desktop();
    let capture = |profile_id: &str, org_id: &str| -> Result<(), HookError> {
        manual_desktop_lock(|| desktop.capture(profile_id, org_id)).map_err(HookError::from)
    };
    let begin_login = |profile_id: &str| -> Result<(), HookError> {
        manual_desktop_lock(|| desktop.begin_login(profile_id)).map_err(HookError::from)
    };
    let arm = |profile_id: &str| {
        if let Some(auto_capture) = STATE.auto_capture.get() {
            auto_capture.arm(profile_id);
        }
    };
    let check_terminal = || {
        desktop.check_terminal();
    };
    let check_extension = |profile_id: &str| {
        let _ = desktop.check_extension(Some(profile_id));
    };
    let refresh_usage = |profile_id: &str| {
        let _ = STATE.usage().refresh(profile_id, false);
    };
    let mut deps = OneClickCascadeDeps::new(&STATE.service().store, desktop.root.clone());
    deps.capture_desktop = Some(&capture);
    deps.begin_desktop_login = Some(&begin_login);
    deps.arm_auto_capture = Some(&arm);
    deps.check_terminal = Some(&check_terminal);
    deps.check_extension = Some(&check_extension);
    deps.refresh_usage = Some(&refresh_usage);
    let result = match execute_one_click_cascade(call.arg(0), &deps) {
        Ok(result) => result,
        Err(OneClickError::Invalid(error)) => return Err(zod_message(&error)),
        Err(error) => return Err(error.to_string()),
    };
    crate::services::tray_setup::update_tray();
    crate::events::changed();
    reply(result)
}

fn desktop_snapshot(_call: &Call) -> IpcResult {
    let desktop = STATE.desktop();
    let mut snapshot = reply(desktop.cached_snapshot().msg()?)?;
    if let Value::Object(map) = &mut snapshot {
        map.insert(
            "proxyStatus".into(),
            crate::services::gateway::proxy_status(),
        );
        if let Some(state) = STATE.auto_capture.get().and_then(|auto| auto.state()) {
            map.insert("autoCapture".into(), reply(state)?);
        }
        let busy = desktop.is_busy()
            || DESKTOP_LOCK.busy()
            || STATE
                .usage_credential_refresher
                .get()
                .is_some_and(|refresher| refresher.any_active());
        map.insert("busy".into(), json!(busy));
    }
    Ok(snapshot)
}

fn dismiss_desktop_error(call: &Call) -> IpcResult {
    let revision = call.int(0, 0.0, 9_007_199_254_740_991.0)?;
    STATE.desktop().dismiss_error(revision);
    done()
}

fn capture_desktop(call: &Call) -> IpcResult {
    let (profile_id, org_id) = (call.id(0)?, call.id(1)?);
    manual_desktop_lock(|| STATE.desktop().capture(&profile_id, &org_id))?;
    done()
}

fn begin_desktop_login(call: &Call) -> IpcResult {
    let profile_id = call.id(0)?;
    manual_desktop_lock(|| STATE.desktop().begin_login(&profile_id))?;
    done()
}

fn cancel_desktop_login(_call: &Call) -> IpcResult {
    if let Some(auto_capture) = STATE.auto_capture.get() {
        auto_capture.disarm(None);
    }
    manual_desktop_lock(|| STATE.desktop().cancel_login())?;
    done()
}

fn arm_auto_capture(call: &Call) -> IpcResult {
    let profile_id = call.id(0)?;
    if let Some(auto_capture) = STATE.auto_capture.get() {
        auto_capture.arm(&profile_id);
    }
    done()
}

fn disarm_auto_capture(call: &Call) -> IpcResult {
    let profile_id = call.opt_id(0)?;
    if let Some(auto_capture) = STATE.auto_capture.get() {
        auto_capture.disarm(profile_id.as_deref());
    }
    done()
}

fn choose_auto_capture_org(call: &Call) -> IpcResult {
    let (profile_id, org_id) = (call.id(0)?, call.id(1)?);
    if let Some(auto_capture) = STATE.auto_capture.get() {
        auto_capture.choose(&profile_id, &org_id).msg()?;
    }
    done()
}

/// A panel-initiated switch confirms with a notification.
fn switch_desktop(call: &Call) -> IpcResult {
    let target = call.id(0)?;
    let result = manual_desktop_lock(|| {
        STATE
            .desktop()
            .switch_to(&target, DesktopSwitchOptions::default())
    });
    if result.is_ok()
        && let Some(account) = STATE
            .accounts()
            .into_iter()
            .find(|account| account.id == target)
    {
        if call.sender == Sender::Panel {
            notify_switched(&account.name);
        }
        notify_extension_left(&account);
    }
    crate::services::tray_setup::update_tray();
    crate::events::changed();
    result?;
    done()
}

/// Main window only: the widget's switch request is never the panel's to take.
fn take_switch_request(call: &Call) -> IpcResult {
    if call.sender != Sender::Main {
        return done();
    }
    reply(crate::services::links::take_linked_switch())
}

fn open_page(call: &Call) -> IpcResult {
    let pages: Vec<&str> = PAGES.iter().map(|page| page.as_str()).collect();
    let page = call.one_of(0, &pages)?;
    let intent = call.opt_one_of(1, &[PageIntent::Ekle.as_str()])?;
    if let Some(app) = crate::state::app() {
        crate::windows::main::open_page(app, &page, intent.as_deref());
    }
    hide_panel();
    done()
}

fn quit(_call: &Call) -> IpcResult {
    hide_panel();
    crate::lifecycle::quit();
    done()
}

/// `z.number().finite().positive().max(4000)`; an invalid one-way message is ignored.
fn panel_size(call: &Call) -> Result<(), String> {
    let Some(height) = call.arg(0).as_f64() else {
        return Ok(());
    };
    if height.is_finite()
        && height > 0.0
        && height <= 4000.0
        && let Some(panel) = TrayPanel::current()
    {
        panel.set_height(height);
    }
    Ok(())
}

fn panel_close(_call: &Call) -> Result<(), String> {
    hide_panel();
    Ok(())
}

/// The switch story's page is ready; a failure only skips the story.
fn switch_ready(call: &Call) -> Result<(), String> {
    if let Some(window) = crate::services::tray_setup::switch_window() {
        window.ready(call.sender.label());
    }
    Ok(())
}

fn sync_desktop_history(call: &Call) -> IpcResult {
    let profile_id = call.id(0)?;
    manual_desktop_lock(|| STATE.desktop().sync_history(&profile_id))?;
    done()
}

fn desktop_history_summary(call: &Call) -> IpcResult {
    let profile_id = call.id(0)?;
    reply(STATE.desktop().history_summary(&profile_id).msg()?)
}

fn open_desktop(_call: &Call) -> IpcResult {
    manual_desktop_lock(|| STATE.desktop().open())?;
    done()
}

fn open_antigravity(_call: &Call) -> IpcResult {
    open_antigravity_app()?;
    done()
}

/// Setup's "Open Code" in the Claude app.
struct CodeTab;

impl CodeTabDeps for CodeTab {
    type Error = String;
    fn open(&mut self) -> Result<(), String> {
        STATE.desktop().open().msg()
    }
    fn booted(&mut self) -> Result<Option<bool>, String> {
        Ok(crate::services::logs::claude_page_booted())
    }
    fn running(&mut self) -> Result<bool, String> {
        Ok(STATE.desktop().snapshot().msg()?.running)
    }
    fn open_link(&mut self, url: &str) -> Result<(), String> {
        STATE.shell().open_external(url)
    }
    fn sleep(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
    fn now(&self) -> i64 {
        relay_core::clock::now_ms()
    }
}

/// Setup's "Open Code": the fixed claude:// link to Code's new-session screen, macOS and Linux
/// (where Claude's package registers the link and hands it to the running Claude).
fn open_code(_call: &Call) -> IpcResult {
    manual_desktop_lock(|| {
        if !cfg!(any(target_os = "macos", target_os = "linux")) {
            return STATE.desktop().open().msg();
        }
        open_code_tab(&mut CodeTab, CODE_TAB_TIMEOUT_MS).map(drop)
    })?;
    done()
}

fn recover_desktop(_call: &Call) -> IpcResult {
    manual_desktop_lock(|| STATE.desktop().recover())?;
    done()
}
