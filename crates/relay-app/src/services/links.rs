//! relay:// links from the widgets, and the switch review they ask the main window for (port of
//! electron/main/links.ts).

use std::sync::Mutex;

use relay_core::shared::relay_link::{RelayLink, parse_relay_link};

use crate::state::{STATE, lock};
use crate::windows::panel::TrayPanel;

/// How long a widget's switch link waits for the main window to take it.
const LINKED_SWITCH_MS: i64 = 2 * 60_000;

/// A widget's Geç: the account whose switch review the main window opens next, and when.
static LINKED_SWITCH: Mutex<Option<(String, i64)>> = Mutex::new(None);

/// A link that came before Relay was ready.
static PENDING_RELAY_LINK: Mutex<Option<String>> = Mutex::new(None);

/// `openRelayLink`: a relay:// link from a widget, the command line or a second instance.
/// `relay://switch?account=<id>` shows the main window and asks it for its usual switch review
/// of that account, the one its own Switch buttons open; nothing here switches. Anything else,
/// or an id that is not one of Relay's accounts, only shows Relay or is ignored.
pub fn open_relay_link(url: &str) {
    if !STATE.initialized() {
        *lock(&PENDING_RELAY_LINK) = Some(url.to_owned());
        return;
    }
    let accounts = STATE.accounts();
    let Some(link) = parse_relay_link(Some(url), Some(accounts.as_slice())) else {
        return;
    };
    let switch = matches!(link, RelayLink::Switch { .. });
    if let RelayLink::Switch { account_id } = link {
        *lock(&LINKED_SWITCH) = Some((account_id, relay_core::clock::now_ms()));
    }
    let Some(app) = crate::state::app() else {
        return;
    };
    crate::windows::main::show(app, None);
    if let Some(panel) = TrayPanel::current() {
        panel.hide();
    }
    // A window still loading takes the request when its page starts.
    if switch
        && crate::windows::main::window(app).is_some()
        && !crate::windows::main::is_loading(app)
    {
        crate::events::switch_request();
    }
}

/// `takeLinkedSwitch`: the main window takes the widget's switch request once; an old one is
/// dropped.
pub fn take_linked_switch() -> Option<String> {
    let (account_id, at) = lock(&LINKED_SWITCH).take()?;
    if relay_core::clock::now_ms() - at > LINKED_SWITCH_MS {
        return None;
    }
    STATE
        .accounts()
        .iter()
        .any(|account| account.id == account_id)
        .then_some(account_id)
}

/// `takePendingRelayLink`: the link Relay was opened with before it was ready, taken once.
pub fn take_pending_relay_link() -> Option<String> {
    lock(&PENDING_RELAY_LINK).take()
}
