//! Relay itself: how it starts Claude, its updates, shortcuts, separate windows, menu bar title
//! and language (port of electron/main/ipc/app.ts).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use relay_core::desktop::WINDOWS_UNSUPPORTED;
use relay_core::desktop_windows::DesktopWindows;
use relay_core::language_file::write_language_pref;
use relay_core::shared::tray::{DEFAULT_MENU_BAR_ITEMS, MENU_BAR_ITEMS, tray_title};
use relay_core::shared::types::{ClaudeLaunchPatch, MenuBarTitleChoice};
use relay_core::store::schema::{self, array, boolean, enumeration, strict};
use relay_i18n::{LanguagePref, Locale, parse_pref};
use serde_json::{Map, Value, json};

use super::{Call, IpcResult, OrMessage, Registry, done, reply};
use crate::services::desktop_lock::manual_desktop_lock;
use crate::services::{tray_setup, updates};
use crate::state::{STATE, lock};

pub fn register(registry: &mut Registry) {
    registry.handle("claude-launch", claude_launch);
    registry.handle("update-check", update_check);
    registry.handle("update-install", update_install);
    registry.handle("set-update-auto", set_update_auto);
    registry.handle("update-notes", update_notes);
    registry.handle("pause-shortcuts", pause_shortcuts);
    registry.handle("set-separate-windows", set_separate_windows);
    registry.handle("open-window", open_window);
    registry.handle("close-window", close_window);
    registry.handle("set-claude-launch", set_claude_launch);
    registry.handle("menu-bar-title", menu_bar_title);
    registry.handle("menu-bar-now", menu_bar_now);
    registry.handle("set-menu-bar-title", set_menu_bar_title);
    registry.handle("set-language", set_language);
    registry.handle("get-language", get_language);
}

/// How Relay starts Claude (HTTP/3).
fn claude_launch(_call: &Call) -> IpcResult {
    match STATE.switch_diagnostics.get() {
        Some(diagnostics) => reply(lock(diagnostics).current()),
        None => Ok(json!({ "quicOff": false })),
    }
}

// Relay's own updates.
fn update_check(_call: &Call) -> IpcResult {
    reply(updates::check()?)
}

fn update_install(_call: &Call) -> IpcResult {
    updates::install()?;
    done()
}

fn set_update_auto(call: &Call) -> IpcResult {
    updates::app_updates().ok_or("Updates are not available in this copy of Relay.")?;
    updates::set_auto(call.bool(0)?)?;
    done()
}

fn update_notes(_call: &Call) -> IpcResult {
    updates::open_notes()?;
    done()
}

/// Bumped by every `pause-shortcuts`: a resume timer that sees another number was cleared.
static SHORTCUT_RESUME: AtomicU64 = AtomicU64::new(0);

fn resume_shortcuts() {
    if let Some(shortcuts) = STATE.global_shortcuts.get() {
        lock(shortcuts).resume();
    }
    crate::events::changed();
}

/// Settings records a shortcut: the registered keys are let go meanwhile, so pressing one is
/// recorded instead of acting. A recorder that never says it ended resumes them after a minute.
fn pause_shortcuts(call: &Call) -> IpcResult {
    let turn = SHORTCUT_RESUME.fetch_add(1, Ordering::SeqCst) + 1;
    if call.bool(0)? {
        if let Some(shortcuts) = STATE.global_shortcuts.get() {
            lock(shortcuts).pause();
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(60_000));
            if SHORTCUT_RESUME.load(Ordering::SeqCst) == turn {
                resume_shortcuts();
            }
        });
        return done();
    }
    resume_shortcuts();
    done()
}

fn desktop_windows() -> Result<&'static Arc<DesktopWindows>, String> {
    STATE
        .desktop_windows
        .get()
        .ok_or_else(|| WINDOWS_UNSUPPORTED.to_owned())
}

/// Separate Claude windows: an account opened in its own Claude beside the main one.
fn set_separate_windows(call: &Call) -> IpcResult {
    let windows = desktop_windows()?;
    windows.set_enabled(call.bool(0)?).msg()?;
    crate::events::changed();
    done()
}

fn window_account(call: &Call) -> Result<(&'static Arc<DesktopWindows>, String), String> {
    let windows = desktop_windows()?;
    let account = STATE.service().store.account(&call.id(0)?).msg()?;
    let desktop = account
        .desktop
        .ok_or("Connect this account in Claude Desktop first.")?;
    Ok((windows, desktop.account_uuid))
}

fn open_window(call: &Call) -> IpcResult {
    let (windows, account_uuid) = window_account(call)?;
    let opened = manual_desktop_lock(|| {
        // A sign-in in progress may be for this very account: one holder at a time.
        let state = STATE.desktop().snapshot().msg()?;
        if state.pending_profile_id.is_some() {
            return Err("Finish or cancel the current Desktop sign-in first.".to_owned());
        }
        if state.recovery_required {
            return Err("Restore the interrupted Desktop switch first.".to_owned());
        }
        windows.open(&account_uuid).msg()
    });
    crate::events::changed();
    reply(opened?.as_str())
}

fn close_window(call: &Call) -> IpcResult {
    let (windows, account_uuid) = window_account(call)?;
    let closed = manual_desktop_lock(|| windows.close(&account_uuid));
    crate::events::changed();
    closed?;
    done()
}

fn set_claude_launch(call: &Call) -> IpcResult {
    let patch: ClaudeLaunchPatch =
        call.parse(0, &strict(vec![("quicOff", boolean().optional())]))?;
    let diagnostics = STATE
        .switch_diagnostics
        .get()
        .ok_or("Invalid Claude launch choice.")?;
    reply(lock(diagnostics).set(patch).msg()?)
}

/// What the menu bar title shows; kept beside the registry, redrawn at once.
fn menu_bar_title(_call: &Call) -> IpcResult {
    match STATE.menu_bar_title.get() {
        Some(title) => reply(lock(title).current()),
        None => reply(MenuBarTitleChoice {
            items: DEFAULT_MENU_BAR_ITEMS.to_vec(),
        }),
    }
}

/// The title as the menu bar shows it now, and each item's value alone, from the last look.
fn menu_bar_now(_call: &Call) -> IpcResult {
    let Some(snapshot) = lock(&STATE.last_tray_snapshot).clone() else {
        return done();
    };
    let now = relay_core::clock::now_ms() as f64;
    let locale = crate::i18n::locale();
    let mut values = Map::new();
    for item in MENU_BAR_ITEMS {
        let mut alone = snapshot.clone();
        alone.title_items = Some(vec![item]);
        let text = tray_title(&alone, now, locale);
        let text = if text == "—" { String::new() } else { text };
        values.insert(item.as_str().to_owned(), Value::String(text));
    }
    // The saved choice, which the snapshot may not hold yet right after a change.
    let mut titled = snapshot;
    if let Some(title) = STATE.menu_bar_title.get() {
        titled.title_items = Some(lock(title).current().items);
    }
    Ok(json!({
        "title": tray_title(&titled, now, locale),
        "values": values,
    }))
}

fn set_menu_bar_title(call: &Call) -> IpcResult {
    let items = enumeration(MENU_BAR_ITEMS.iter().map(|item| item.as_str()));
    let choice: MenuBarTitleChoice = call.parse(
        0,
        &strict(vec![("items", array(items, Some(MENU_BAR_ITEMS.len())))]),
    )?;
    let title = STATE
        .menu_bar_title
        .get()
        .ok_or("Invalid menu bar title.")?;
    let kept = lock(title).set(&choice).msg()?;
    tray_setup::update_tray();
    reply(kept)
}

fn language_id(pref: LanguagePref) -> &'static str {
    match pref {
        LanguagePref::System => "system",
        LanguagePref::Locale(locale) => locale.as_str(),
    }
}

fn set_language(call: &Call) -> IpcResult {
    let locales = enumeration(Locale::ALL.iter().map(|locale| locale.as_str()));
    let value: String = call.parse(
        0,
        &schema::union(vec![schema::literal(json!("system")), locales]),
    )?;
    let pref = parse_pref(&value).ok_or("Invalid language.")?;
    write_language_pref(STATE.service().store.root(), pref).msg()?;
    let before = crate::i18n::locale();
    crate::boot::vault::apply_language(pref);
    let locale = crate::i18n::locale();
    if locale != before {
        if let Some(app) = crate::state::app() {
            crate::menu::apply(app, locale);
        }
        // The widget's strings are in the app's language too.
        crate::services::tokens_widget::write_widget_forced();
    }
    tray_setup::update_tray();
    done()
}

fn get_language(_call: &Call) -> IpcResult {
    let pref = *STATE
        .language_pref
        .read()
        .unwrap_or_else(|e| e.into_inner());
    Ok(json!({
        "pref": language_id(pref),
        "locale": crate::i18n::locale().as_str(),
    }))
}
