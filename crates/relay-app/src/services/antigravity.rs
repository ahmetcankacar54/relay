//! Antigravity accounts: their CLIProxyAPI helpers, the Google sign-in in progress, the app on
//! this Mac (port of electron/main/antigravity.ts).

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use relay_core::antigravity_app::{
    antigravity_data_dir, antigravity_last_login, match_antigravity_app,
};
use relay_core::antigravity_bridge::{AntigravityBridge, AntigravityOAuthState};
use relay_core::clock::now_ms;
use relay_core::fs_util::iso_timestamp;
use relay_core::oauth_callback_server::CallbackServer;
use relay_core::relay_paths::{Platform, home_dir};
use relay_core::shared::types::{
    AccountAuth, AccountProvider, AntigravityAppState, AntigravityOAuthPoll, CascadeLayerStatus,
    CascadeLayers, OneClickCascadeResult,
};
use relay_core::store::StoreError;

use crate::i18n::say;
use crate::ipc::OrMessage;
use crate::state::{STATE, lock};

/// The port Antigravity's Google OAuth client sends the browser back to.
pub const ANTIGRAVITY_CALLBACK_PORT: u16 = 51121;
/// How long a browser sign-in may take.
pub const OAUTH_TIMEOUT_MS: u64 = 10 * 60_000;
const OAUTH_POLL: Duration = Duration::from_millis(1500);

/// When each Antigravity account's Google plan was last read (ms).
pub static ANTIGRAVITY_TIER_READS: LazyLock<Mutex<HashMap<String, i64>>> =
    LazyLock::new(Mutex::default);

static BRIDGES: LazyLock<Mutex<HashMap<String, Arc<AntigravityBridge>>>> =
    LazyLock::new(Mutex::default);
/// The sign-in each pending account waits for (its OAuth state).
static PENDING: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);
/// How a finished sign-in ended, for a poll that comes after.
static OUTCOMES: LazyLock<Mutex<HashMap<String, AntigravityOAuthPoll>>> =
    LazyLock::new(Mutex::default);
/// One poll per account at a time; a second waits for the first and reads its outcome.
static POLL_TURNS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = LazyLock::new(Mutex::default);
/// Each pending sign-in's poll timer, stopped by setting its flag (`clearInterval`).
static TIMERS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Mutex::default);
/// Relay's own listener on Google's redirect port while a sign-in waits.
static CALLBACK_SERVERS: LazyLock<Mutex<HashMap<String, CallbackServer>>> =
    LazyLock::new(Mutex::default);
static STARTING: AtomicBool = AtomicBool::new(false);

/// The Antigravity app and the Relay account it is signed in with. Read from its settings file
/// only when some account is an Antigravity one; cheap (a few KB) and read on each snapshot.
pub fn antigravity_app() -> Option<AntigravityAppState> {
    let accounts = STATE.accounts();
    if !accounts
        .iter()
        .any(|a| a.provider == Some(AccountProvider::Antigravity))
    {
        return None;
    }
    let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    let data_dir = antigravity_data_dir(Platform::current(), &home_dir().to_string_lossy(), &env);
    let app = match_antigravity_app(
        &antigravity_last_login(Path::new(&data_dir)),
        &accounts,
        cfg!(target_os = "macos"),
    );
    let Some(switcher) = STATE.antigravity_switcher.get() else {
        return Some(app);
    };
    if !app.installed {
        return Some(app);
    }
    // On macOS the Keychain item itself says which account the app and agy use; the settings
    // file only says who signed in last.
    let state = switcher.state();
    let current = switcher.current();
    let (account_id, other_sign_in) = if current.account_id.is_some() {
        (current.account_id, None)
    } else if current.other == Some(true) {
        (None, Some(true))
    } else if current.signed_out == Some(true) {
        (None, None)
    } else {
        (app.account_id, app.other_sign_in)
    };
    Some(AntigravityAppState {
        installed: app.installed,
        can_open: app.can_open,
        account_id,
        other_sign_in,
        can_switch: Some(true),
        saved: Some(state.saved),
        busy: state.busy,
        sign_in_for: state.sign_in_for,
        result: state.result,
    })
}

/// The account's CLIProxyAPI helper, made on first use.
pub fn antigravity_bridge(account_id: &str) -> Result<Arc<AntigravityBridge>, String> {
    let store = &STATE.service().store;
    let account = store.account(account_id).msg()?;
    if account.provider != Some(AccountProvider::Antigravity) {
        return Err(say("electronMain.notAnAntigravityAccount"));
    }
    let mut bridges = lock(&BRIDGES);
    if let Some(bridge) = bridges.get(account_id) {
        return Ok(bridge.clone());
    }
    let bridge = Arc::new(AntigravityBridge::new(
        store.profile(account_id).msg()?,
        STATE.paths().data_dir().join("tools"),
        None,
    ));
    bridges.insert(account_id.to_owned(), bridge.clone());
    Ok(bridge)
}

/// Stops and forgets one account's helper (backup restore, account removal).
pub fn stop_bridge(account_id: &str) {
    let bridge = lock(&BRIDGES).remove(account_id);
    if let Some(bridge) = bridge {
        bridge.stop();
    }
}

/// At quit: every Antigravity sidecar stops (`antigravityBridges.values().stop()`).
pub fn stop_bridges() {
    let bridges: Vec<_> = lock(&BRIDGES).values().cloned().collect();
    for bridge in bridges {
        bridge.stop();
    }
}

/// The state of the account's pending sign-in, if one is pending.
pub fn pending_state(account_id: &str) -> Option<String> {
    lock(&PENDING).get(account_id).cloned()
}

/// Whether the account's pending sign-in is `state`.
pub fn is_pending(account_id: &str, state: &str) -> bool {
    lock(&PENDING).get(account_id).is_some_and(|s| s == state)
}

/// Claims the one Antigravity sign-in start: false while another is pending or starting, as
/// a double click must not start two sign-ins on the helper's one callback port.
pub fn claim_start() -> bool {
    let pending = lock(&PENDING);
    pending.is_empty()
        && STARTING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

/// Lets the sign-in start go.
pub fn end_start() {
    STARTING.store(false, Ordering::SeqCst);
}

pub fn set_pending(account_id: &str, state: &str) {
    lock(&PENDING).insert(account_id.to_owned(), state.to_owned());
}

pub fn set_outcome(account_id: &str, outcome: AntigravityOAuthPoll) {
    lock(&OUTCOMES).insert(account_id.to_owned(), outcome);
}

pub fn set_callback_server(account_id: &str, server: CallbackServer) {
    lock(&CALLBACK_SERVERS).insert(account_id.to_owned(), server);
}

fn close_callback_server(account_id: &str) {
    if let Some(server) = lock(&CALLBACK_SERVERS).remove(account_id) {
        server.close();
    }
}

/// The sign-in is over: its poll timer stops (`clearInterval`) and its poll turn goes.
fn clear_timer(account_id: &str) {
    if let Some(stop) = lock(&TIMERS).remove(account_id) {
        stop.store(true, Ordering::SeqCst);
    }
    lock(&POLL_TURNS).remove(account_id);
}

/// Forgets the account's sign-in in progress and its poll timer (`remove-account`).
pub fn clear_pending(account_id: &str) {
    lock(&PENDING).remove(account_id);
    clear_timer(account_id);
}

/// Polls the pending sign-in every 1.5 s; after 10 minutes it is discarded as timed out.
pub fn start_poll_timer(account_id: &str, state: &str) {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(old) = lock(&TIMERS).insert(account_id.to_owned(), stop.clone()) {
        old.store(true, Ordering::SeqCst);
    }
    let (account_id, state) = (account_id.to_owned(), state.to_owned());
    let started = Instant::now();
    let _ = std::thread::Builder::new()
        .name("relay-antigravity-oauth".into())
        .spawn(move || {
            loop {
                std::thread::sleep(OAUTH_POLL);
                if stop.load(Ordering::SeqCst) || STATE.quitting() {
                    return;
                }
                if started.elapsed() > Duration::from_millis(OAUTH_TIMEOUT_MS) {
                    let _ = discard_pending_antigravity(&account_id);
                    set_outcome(
                        &account_id,
                        AntigravityOAuthPoll::Error {
                            error: say("electronMain.antigravitySignInTimedOut"),
                        },
                    );
                    return;
                }
                let _ = poll_antigravity_oauth(&account_id, &state);
            }
        });
}

/// Drops a sign-in that cannot finish: its helper, its listener, its timer and the account
/// made for it, with its profile folder.
pub fn discard_pending_antigravity(account_id: &str) -> Result<(), String> {
    lock(&PENDING).remove(account_id);
    close_callback_server(account_id);
    clear_timer(account_id);
    stop_bridge(account_id);
    let store = &STATE.service().store;
    store
        .update(|state| state.accounts.retain(|account| account.id != account_id))
        .msg()?;
    let profile = store.root().join("profiles").join(account_id);
    match std::fs::remove_dir_all(&profile) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(error.to_string());
        }
        _ => {}
    }
    crate::events::changed();
    Ok(())
}

/// Where the account's browser sign-in stands; a finished one is kept for later polls.
pub fn poll_antigravity_oauth(
    account_id: &str,
    state: &str,
) -> Result<AntigravityOAuthPoll, String> {
    if let Some(completed) = lock(&OUTCOMES).get(account_id) {
        return Ok(completed.clone());
    }
    if !is_pending(account_id, state) {
        return Err(say("electronMain.antigravitySignInIsNoLonger"));
    }
    let turn = lock(&POLL_TURNS)
        .entry(account_id.to_owned())
        .or_default()
        .clone();
    let _turn = lock(&turn);
    // A poll that held the turn may have finished the sign-in.
    if let Some(completed) = lock(&OUTCOMES).get(account_id) {
        return Ok(completed.clone());
    }
    poll_now(account_id, state)
}

fn poll_now(account_id: &str, state: &str) -> Result<AntigravityOAuthPoll, String> {
    let email = match antigravity_bridge(account_id)?.poll_oauth(state).msg()? {
        AntigravityOAuthState::Wait => return Ok(AntigravityOAuthPoll::Wait),
        AntigravityOAuthState::Error { error } => {
            discard_pending_antigravity(account_id)?;
            let result = AntigravityOAuthPoll::Error { error };
            set_outcome(account_id, result.clone());
            return Ok(result);
        }
        AntigravityOAuthState::Ok { email } => email,
    };
    let store = &STATE.service().store;
    let lower = email.to_lowercase();
    let duplicate = store.with_state(|s| {
        s.accounts.iter().any(|a| {
            a.id != account_id
                && a.provider == Some(AccountProvider::Antigravity)
                && a.auth
                    .as_ref()
                    .and_then(|auth| auth.email.as_deref())
                    .is_some_and(|e| e.to_lowercase() == lower)
        })
    });
    if duplicate {
        discard_pending_antigravity(account_id)?;
        let result = AntigravityOAuthPoll::Error {
            error: say("electronMain.thisAntigravityAccountIsAlreadyConnected"),
        };
        set_outcome(account_id, result.clone());
        return Ok(result);
    }
    store
        .try_update(|saved| {
            let account = saved
                .accounts
                .iter_mut()
                .find(|a| a.id == account_id)
                .ok_or_else(|| Msg(say("electronMain.accountDisappearedDuringOauthSignIn")))?;
            // The plan (Google AI Pro, Ultra, free) is read with the account's first limits.
            account.auth = Some(signed_in(email));
            Ok::<(), Msg>(())
        })
        .map_err(|Msg(error)| error)?;
    lock(&PENDING).remove(account_id);
    close_callback_server(account_id);
    clear_timer(account_id);
    crate::events::changed();
    let result = AntigravityOAuthPoll::Ok {
        result: Box::new(OneClickCascadeResult {
            account: store.account(account_id).msg()?,
            layers: CascadeLayers {
                desktop: CascadeLayerStatus::Skipped,
                usage: CascadeLayerStatus::Skipped,
                terminal: CascadeLayerStatus::Skipped,
                extension_and_proxy: CascadeLayerStatus::Done,
            },
            needs_sign_in: None,
        }),
    };
    set_outcome(account_id, result.clone());
    Ok(result)
}

fn signed_in(email: String) -> AccountAuth {
    AccountAuth {
        logged_in: true,
        email: Some(email),
        account_uuid: None,
        org_id: None,
        org_name: None,
        subscription: None,
        plan: None,
        checked_at: iso_timestamp(now_ms()),
        error: None,
    }
}

/// A failed store change as its message.
struct Msg(String);

impl From<StoreError> for Msg {
    fn from(error: StoreError) -> Self {
        Msg(error.to_string())
    }
}

/// boot/vault.ts: a browser sign-in that finished after its dialog closed or Relay restarted is
/// kept when CLIProxyAPI saved and validated it; a sign-in Relay quit during is discarded.
pub fn recover_saved_sign_ins() {
    for account in STATE.accounts() {
        if account.provider != Some(AccountProvider::Antigravity)
            || account.auth.as_ref().is_some_and(|auth| auth.logged_in)
        {
            continue;
        }
        let email = antigravity_bridge(&account.id)
            .ok()
            .and_then(|bridge| bridge.saved_oauth_email());
        let Some(email) = email else {
            // Never signed in and nothing saved: a sign-in Relay quit during; nothing can
            // finish it.
            if account.auth.is_none()
                && let Err(error) = discard_pending_antigravity(&account.id)
            {
                crate::services::errors::record_main_error("antigravity", &error);
            }
            continue;
        };
        let saved = STATE.service().store.update(|state| {
            if let Some(saved) = state.accounts.iter_mut().find(|a| a.id == account.id) {
                saved.auth = Some(AccountAuth {
                    subscription: Some("Antigravity OAuth".into()),
                    ..signed_in(email)
                });
            }
        });
        if let Err(error) = saved {
            crate::services::errors::record_main_error("antigravity", &error.to_string());
        }
    }
}
