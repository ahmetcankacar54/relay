//! Continuing conversations at the limit, the Accessibility request, and the panel's draft and
//! sidebar offers (port of electron/main/ipc/continuation.ts).

use std::sync::{Arc, LazyLock};

use relay_core::continuation::ExecutionPolicy;
use relay_core::desktop_continuation::DesktopContinuationArmInput;
use relay_core::draft_main::{DraftActions, DraftActionsDeps, draft_actions};
use relay_core::sidebar_main::{SidebarActions, SidebarActionsDeps, SidebarGaps, sidebar_actions};
use relay_core::store::schema;
use serde_json::json;

use super::{Call, IpcResult, OrMessage, Registry, done, id_schema, reply};
use crate::state::STATE;

pub fn register(registry: &mut Registry) {
    registry.handle("inspect-continuation", inspect_continuation);
    registry.handle("arm-continuation", arm_continuation);
    registry.handle("disarm-continuation", |_| {
        reply(STATE.continuation().disarm().msg()?)
    });
    registry.handle("set-fleet-continuation", set_fleet_continuation);
    registry.handle("reconcile-continuation", |_| {
        reply(STATE.continuation().resume_pending().msg()?)
    });
    registry.handle("abandon-continuation", |_| {
        reply(STATE.continuation().abandon_pending().msg()?)
    });
    registry.handle(
        "request-desktop-accessibility",
        request_desktop_accessibility,
    );
    registry.handle("copy-draft", |call| {
        DRAFTS.copy(call.arg(0)).msg()?;
        done()
    });
    registry.handle("dismiss-draft", |call| {
        DRAFTS.dismiss(call.arg(0)).msg()?;
        done()
    });
    registry.handle("copy-sidebar-recipe", |call| {
        SIDEBAR.copy(call.arg(0)).msg()?;
        done()
    });
    registry.handle("dismiss-sidebar-gap", |call| {
        SIDEBAR.dismiss(call.arg(0)).msg()?;
        done()
    });
}

fn inspect_continuation(_: &Call) -> IpcResult {
    reply(STATE.continuation().inspect())
}

fn arm_continuation(call: &Call) -> IpcResult {
    let target = call.value(
        0,
        &schema::union(vec![schema::literal(json!("automatic")), id_schema()]),
    )?;
    call.value(1, &schema::literal(json!("guarded-native-at-most-once")))?;
    // Ask for the saved sign-ins' Keychain consent now, not during the handoff.
    STATE.desktop().verify_saved_logins().msg()?;
    reply(
        STATE
            .continuation()
            .arm(&DesktopContinuationArmInput {
                target_account_id: target.as_str().unwrap_or_default().to_owned(),
                execution_policy: Some(ExecutionPolicy::GuardedNativeAtMostOnce),
            })
            .msg()?,
    )
}

fn set_fleet_continuation(call: &Call) -> IpcResult {
    let on = call.bool(0)?;
    if on {
        // Ask for the saved sign-ins' Keychain consent now, not during a handoff.
        STATE.desktop().verify_saved_logins().msg()?;
        // One monitor at a time: the all-conversations mode replaces a single watch.
        if STATE.continuation().snapshot().enabled {
            STATE.continuation().disarm().msg()?;
        }
    }
    let state = STATE.fleet().set_enabled(on)?;
    if on {
        let fleet = STATE.fleet().clone();
        std::thread::spawn(move || {
            fleet.tick();
        });
    }
    reply(state)
}

fn request_desktop_accessibility(_: &Call) -> IpcResult {
    if !cfg!(target_os = "macos") {
        return reply(false);
    }
    // With draft re-typing and continuation off, nothing needs it: never ask.
    if !crate::services::logs::accessibility_wanted() {
        return reply(false);
    }
    // Register the explicit permission request against the foreground Relay app. A
    // helper-only request can obscure which rebuilt app owns the OS consent.
    #[cfg(target_os = "macos")]
    crate::macos::request_accessibility_trust();
    // The child still verifies its real access; the main-process result alone must never
    // authorize Desktop inspection or any automation.
    let automation = STATE.automation();
    let granted =
        automation.supports_request_accessibility() && automation.request_accessibility().msg()?;
    // Drafts left for Copy for want of access go back to waiting for the next run.
    if granted {
        let drafts = STATE.draft_restore().clone();
        std::thread::spawn(move || {
            drafts.retry_accessibility(false);
        });
    } else {
        STATE.shell().open_external(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        )?;
    }
    reply(granted)
}

fn write_clipboard(text: &str) {
    STATE.shell().write_clipboard(text);
}

static DRAFTS: LazyLock<DraftActions> = LazyLock::new(|| {
    draft_actions(DraftActionsDeps {
        drafts: STATE.desktop().clone(),
        write_clipboard: Box::new(|text| {
            write_clipboard(text);
            Ok(())
        }),
        changed: Box::new(crate::events::changed),
        log: Some(Arc::new(crate::services::logs::log_draft_event)),
    })
});

/// The sidebar offers of the Claude app's manager.
struct Gaps;

impl SidebarGaps for Gaps {
    fn sidebar_recipe(&self, id: &str) -> Result<Option<String>, String> {
        SidebarGaps::sidebar_recipe(&**STATE.desktop(), id)
    }
    fn dismiss_sidebar_gap(&self, id: &str) -> Result<(), String> {
        SidebarGaps::dismiss_sidebar_gap(&**STATE.desktop(), id)
    }
}

static SIDEBAR: LazyLock<SidebarActions> = LazyLock::new(|| {
    sidebar_actions(SidebarActionsDeps {
        gaps: Box::new(Gaps),
        write_clipboard: Box::new(write_clipboard),
        changed: Box::new(crate::events::changed),
        log: Some(Box::new(crate::services::logs::log_draft_event)),
    })
});
