//! Antigravity accounts: the Google sign-in and moving the Antigravity app between them (port of
//! electron/main/ipc/antigravity.ts).

use relay_core::antigravity_switch::AntigravitySwitcher;
use relay_core::oauth_callback_server::{CallbackOptions, CallbackPage, listen_oauth_callback};
use relay_core::shared::feature_risk::antigravity_account_risks;
use relay_core::shared::types::{
    AccountProvider, AntigravityCallback, AntigravityOAuthPoll, AntigravityOAuthStart,
    CreateAccount,
};
use relay_core::store::schema::{self, Schema};
use relay_core::store::{create_account_schema, parse_as};
use serde_json::{Map, Value};

use super::{Call, IpcResult, OrMessage, Registry, done, id_schema, reply, require_risk, string};
use crate::i18n::say;
use crate::services::antigravity::{
    ANTIGRAVITY_CALLBACK_PORT, OAUTH_TIMEOUT_MS, antigravity_bridge, claim_start,
    discard_pending_antigravity, end_start, is_pending, pending_state, poll_antigravity_oauth,
    set_callback_server, set_outcome, set_pending, start_poll_timer,
};
use crate::state::STATE;

pub fn register(registry: &mut Registry) {
    registry.handle("antigravity-oauth-start", oauth_start);
    registry.handle("antigravity-oauth-cancel", oauth_cancel);
    registry.handle("antigravity-oauth-callback", oauth_callback);
    registry.handle("antigravity-oauth-poll", oauth_poll);
    registry.handle("switch-antigravity", switch_antigravity);
    registry.handle("save-antigravity-sign-in", save_sign_in);
    registry.handle("cancel-antigravity-sign-in", cancel_sign_in);
}

/// `{ accountId: z.uuid(), state: z.string().min(8).max(128) }.strict()`.
fn sign_in_schema() -> Schema {
    schema::strict(vec![("accountId", id_schema()), ("state", string(8, 128))])
}

fn oauth_start(call: &Call) -> IpcResult {
    // Claimed before anything else: a double click must not start two sign-ins on the helper's
    // one callback port.
    if !claim_start() {
        return Err(say("electronMain.finishThePendingAntigravitySignIn"));
    }
    let result = start(call);
    end_start();
    result
}

fn start(call: &Call) -> IpcResult {
    // `{ ...raw, provider: "antigravity" }`
    let mut raw = match call.arg(0) {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    raw.insert("provider".into(), Value::from("antigravity"));
    let input: CreateAccount = parse_as(&create_account_schema(), &Value::Object(raw))
        .map_err(|e| super::zod_message(&e))?;
    require_risk(&antigravity_account_risks(
        crate::services::gateway::proxy_settings().enabled,
    ))?;
    let account = STATE.service().store.create(&input).msg()?;
    match begin(&account.id) {
        Ok(started) => reply(started),
        Err(error) => {
            let _ = discard_pending_antigravity(&account.id);
            Err(error)
        }
    }
}

fn begin(account_id: &str) -> Result<AntigravityOAuthStart, String> {
    let bridge = antigravity_bridge(account_id)?;
    // Relay answers Google's redirect itself: the browser gets a short page and Relay comes
    // forward. If the port is taken, CLIProxyAPI's own forwarder is the way back.
    let (state_id, handle_id, handle_bridge) =
        (account_id.to_owned(), account_id.to_owned(), bridge.clone());
    let callback = listen_oauth_callback(CallbackOptions {
        port: ANTIGRAVITY_CALLBACK_PORT,
        path: "/oauth-callback".into(),
        // Set below, once the helper has named the sign-in; a redirect for another one waits.
        state: Box::new(move || pending_state(&state_id)),
        handle: Box::new(move |address| {
            let finished = pending_state(&handle_id)
                .ok_or_else(|| say("electronMain.noSignInIsPending"))
                .and_then(|expected| handle_bridge.submit_callback(&expected, address).msg());
            if let Some(app) = crate::state::app() {
                // Focusing the window brings the app forward (`app.focus({ steal: true })`).
                crate::windows::main::show(app, None);
            }
            Ok(match finished {
                Ok(()) => CallbackPage {
                    title: say("electronMain.signedIn"),
                    body: say("electronMain.youCanGoBackToRelay"),
                },
                Err(_) => CallbackPage {
                    title: say("electronMain.signInNotFinished"),
                    body: say("electronMain.goBackToRelayAndTry"),
                },
            })
        }),
        timeout_ms: OAUTH_TIMEOUT_MS,
    });
    let forwarder = callback.is_none();
    if let Some(callback) = callback {
        set_callback_server(account_id, callback);
    }
    let (state, url) = bridge.begin_oauth(forwarder).msg()?;
    set_pending(account_id, &state);
    STATE.shell().open_external(&url)?;
    start_poll_timer(account_id, &state);
    crate::events::changed();
    Ok(AntigravityOAuthStart {
        account_id: account_id.to_owned(),
        state,
    })
}

fn oauth_cancel(call: &Call) -> IpcResult {
    let input: AntigravityOAuthStart = call.parse(0, &sign_in_schema())?;
    // Only the sign-in that is still pending; a finished one is an account like any other.
    if !is_pending(&input.account_id, &input.state) {
        return done();
    }
    discard_pending_antigravity(&input.account_id)?;
    set_outcome(
        &input.account_id,
        AntigravityOAuthPoll::Error {
            error: say("electronMain.antigravitySignInWasCancelled"),
        },
    );
    done()
}

fn oauth_callback(call: &Call) -> IpcResult {
    let input: AntigravityCallback = call.parse(
        0,
        &schema::strict(vec![
            ("accountId", id_schema()),
            ("state", string(8, 128)),
            ("url", string(1, 4_096)),
        ]),
    )?;
    if !is_pending(&input.account_id, &input.state) {
        return Err(say("electronMain.antigravitySignInIsNoLonger"));
    }
    antigravity_bridge(&input.account_id)?
        .submit_callback(&input.state, &input.url)
        .msg()?;
    done()
}

fn oauth_poll(call: &Call) -> IpcResult {
    let input: AntigravityOAuthStart = call.parse(0, &sign_in_schema())?;
    reply(poll_antigravity_oauth(&input.account_id, &input.state)?)
}

fn antigravity_only() -> Result<&'static AntigravitySwitcher, String> {
    STATE
        .antigravity_switcher
        .get()
        .ok_or_else(|| say("electronMain.antigravityAccountSwitchingWorksOnMacos"))
}

fn antigravity_account(call: &Call) -> Result<String, String> {
    let account = STATE.service().store.account(&call.id(0)?).msg()?;
    if account.provider != Some(AccountProvider::Antigravity) {
        return Err(say("electronMain.notAnAntigravityAccount"));
    }
    Ok(account.id)
}

fn switch_antigravity(call: &Call) -> IpcResult {
    let switcher = antigravity_only()?;
    let result = switcher
        .switch_to(&antigravity_account(call)?)
        .map_err(|reason| reason.as_str().to_owned())?;
    reply(result)
}

/// The switcher waits for the new sign-in in the background; the snapshot shows how it ends.
fn save_sign_in(call: &Call) -> IpcResult {
    let switcher = antigravity_only()?;
    switcher
        .begin_sign_in(&antigravity_account(call)?)
        .map_err(|reason| reason.as_str().to_owned())?;
    done()
}

fn cancel_sign_in(_call: &Call) -> IpcResult {
    antigravity_only()?.cancel_sign_in();
    done()
}
