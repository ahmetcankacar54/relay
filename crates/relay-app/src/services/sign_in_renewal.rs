//! Renews an account's Claude Code sign-in with no one at the screen (port of
//! electron/main/sign-in-renewal.ts, and the `SignInRenewal` boot/start.ts makes on macOS).

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use relay_core::auth::{AuthError, BackgroundSignIn};
use relay_core::desktop_usage::PlainCookie;
use relay_core::quiet_approval::{QUIET_TIMEOUT_MS, QuietOutcome, QuietResult, approve_quietly};
use relay_core::service::ServiceError;
use relay_core::shared::account_state::desktop_cli_mismatch;
use relay_core::shared::types::js::iso;
use relay_core::shared::types::{Account, AuthFlowStatus};
use relay_core::sign_in_renewal::{
    FRESH_SIGN_IN_MS, RenewalResult, SignInRenewal, SignInRenewalDeps,
};
use serde_json::{Map, Value, json};

use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::state::{STATE, lock};

/// The first pass waits for the first reads to say when each sign-in ends.
const FIRST_TICK: Duration = Duration::from_secs(3 * 60);
const TICK_EVERY: Duration = Duration::from_secs(15 * 60);
/// An approved sign-in the CLI has not saved by then is stopped.
const APPROVED_GRACE: Duration = Duration::from_secs(2 * 60);

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A serde-tagged value's name, as the TS string.
fn name_of(value: &impl serde::Serialize, tag: Option<&str>) -> String {
    let value = serde_json::to_value(value).unwrap_or(Value::Null);
    let value = match tag {
        Some(tag) => value.get(tag).cloned().unwrap_or(Value::Null),
        None => value,
    };
    value.as_str().unwrap_or_default().to_owned()
}

fn quiet_detail(result: &QuietResult) -> Option<&str> {
    match result {
        QuietResult::Approved => None,
        QuietResult::SignedOut { detail }
        | QuietResult::NoApproval { detail }
        | QuietResult::Failed { detail } => Some(detail),
    }
}

/// `renewSignInQuietly`: the CLI's own sign-in, its page approved in a hidden window holding the
/// account's claude.ai session from the Claude app.
pub fn renew_sign_in_quietly(account: &Account) -> RenewalResult {
    let reader = crate::services::desktop_usage::desktop_usage_reader();
    let Some(reader) = reader.filter(|_| cfg!(target_os = "macos")) else {
        return RenewalResult::Unavailable {
            detail: "no Claude app sign-in reader".into(),
        };
    };
    let service = STATE.service().clone();
    if DESKTOP_LOCK.active() || STATE.desktop().is_busy() {
        return RenewalResult::Busy {
            detail: "Claude app busy".into(),
        };
    }
    // Renewing from the Claude app's session would give this profile the app's identity.
    if desktop_cli_mismatch(account) {
        return RenewalResult::Unavailable {
            detail: "Claude Code sign-in is for another account or workspace than the Claude app's"
                .into(),
        };
    }
    let cookies = match reader.cookies(account) {
        Ok(Some(cookies)) => cookies,
        Ok(None) => {
            return RenewalResult::Unavailable {
                detail: "no claude.ai session".into(),
            };
        }
        Err(error) => {
            return RenewalResult::Unavailable {
                detail: format!("claude.ai session not readable: {}", error.issue.as_str()),
            };
        }
    };
    // claude.ai approves a new Claude Code sign-in only from a recent claude.ai sign-in
    // (`session_stale_relogin` otherwise): an older one is not tried, and the next pass looks
    // again.
    let now = relay_core::clock::now_ms() as f64;
    if let Some(created) = cookies
        .iter()
        .find(|c| c.name == "sessionKey")
        .and_then(|c| c.created)
        && now - created * 1000.0 > FRESH_SIGN_IN_MS as f64
    {
        return RenewalResult::Waiting {
            detail: format!(
                "claude.ai sign-in is {} h old",
                ((now - created * 1000.0) / 3_600_000.0).round()
            ),
        };
    }
    // The hidden window's outcome, once the CLI presented its page.
    let quiet: Arc<Mutex<Option<mpsc::Receiver<QuietOutcome>>>> = Arc::new(Mutex::new(None));
    let presented = quiet.clone();
    let lent: Vec<PlainCookie> = cookies.clone();
    let present = Arc::new(move |url: &str| {
        let mut slot = lock(&presented);
        if slot.is_some() {
            return;
        }
        let (send, receive) = mpsc::channel();
        let (url, cookies) = (url.to_owned(), lent.clone());
        std::thread::spawn(move || {
            let outcome = approve_quietly(&**STATE.webviews(), &url, cookies, QUIET_TIMEOUT_MS);
            let _ = send.send(outcome);
        });
        *slot = Some(receive);
    });
    let flow = match service.login_in_background(&account.id, BackgroundSignIn { present }) {
        Ok(flow) => flow,
        Err(error) => {
            let detail = clip(&error.to_string(), 160);
            return match error {
                ServiceError::Auth(AuthError::Busy(_)) => RenewalResult::Busy { detail },
                _ => RenewalResult::Unavailable { detail },
            };
        }
    };
    let Some(ended) = service.auth.settled(&account.id, &flow.id) else {
        return RenewalResult::Failed {
            detail: "sign-in attempt lost".into(),
        };
    };
    // The page must be approved within the window's own time; otherwise the attempt is stopped.
    let mut receiver = None;
    for _ in 0..60 {
        receiver = lock(&quiet).take();
        if receiver.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    // `synthesized`: no window ran, so there is no trail to log.
    let (outcome, synthesized) = match receiver.and_then(|receiver| receiver.recv().ok()) {
        Some(outcome) => (outcome, false),
        None => (
            QuietOutcome {
                result: QuietResult::Failed {
                    detail: "no sign-in page".into(),
                },
                trail: Vec::new(),
                refused: Vec::new(),
                last: None,
            },
            true,
        ),
    };
    if outcome.result != QuietResult::Approved {
        let _ = service.auth.cancel(&account.id, &flow.id);
    } else {
        // Approved: the CLI saves the sign-in within seconds; one that does not is stopped.
        let (service, account_id, flow_id) = (service.clone(), account.id.clone(), flow.id.clone());
        std::thread::spawn(move || {
            std::thread::sleep(APPROVED_GRACE);
            let _ = service.auth.cancel(&account_id, &flow_id);
        });
    }
    let end = ended.wait();
    log_attempt(account, &end.status, &outcome, &cookies, synthesized);
    if end.status == AuthFlowStatus::Connected {
        return RenewalResult::Connected;
    }
    let detail = match quiet_detail(&outcome.result) {
        None => end.error.unwrap_or_else(|| name_of(&end.status, None)),
        Some(detail) => format!("{}: {detail}", name_of(&outcome.result, Some("result"))),
    };
    RenewalResult::Failed {
        detail: clip(&detail, 200),
    }
}

/// Where the hidden window went and what it last saw (hosts, paths, button labels only): the
/// last ten attempts in `<userData>/diagnostics/quiet-sign-in.json`.
fn log_attempt(
    account: &Account,
    status: &AuthFlowStatus,
    outcome: &QuietOutcome,
    cookies: &[PlainCookie],
    synthesized: bool,
) {
    let file = STATE
        .paths()
        .data_dir()
        .join("diagnostics")
        .join("quiet-sign-in.json");
    let mut entries: Vec<Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    let keep = entries.len().saturating_sub(9);
    entries.drain(..keep);
    let mut names: Vec<&str> = cookies.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    let mut entry = Map::new();
    entry.insert("at".into(), json!(iso(relay_core::clock::now_ms() as f64)));
    entry.insert("accountId".into(), json!(clip(&account.id, 8)));
    entry.insert("flow".into(), json!(status));
    entry.insert(
        "window".into(),
        json!(name_of(&outcome.result, Some("result"))),
    );
    // Names only: which of the Claude app's cookies the window carried.
    entry.insert("cookies".into(), json!(names));
    if let Some(detail) = quiet_detail(&outcome.result) {
        entry.insert("detail".into(), json!(detail));
    }
    if !synthesized {
        entry.insert("trail".into(), json!(outcome.trail));
        entry.insert("last".into(), json!(outcome.last));
        entry.insert("refused".into(), json!(outcome.refused));
    }
    entries.push(Value::Object(entry));
    let Ok(text) = serde_json::to_string_pretty(&entries) else {
        return;
    };
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    if let Ok(mut out) = options.open(&file) {
        let _ = std::io::Write::write_all(&mut out, text.as_bytes());
    }
}

/// boot/start.ts on macOS: makes the `SignInRenewal` and its timers (first tick after 3 min,
/// then every 15 min).
pub fn start() {
    let renewal = STATE.sign_in_renewal.get_or_init(|| {
        Arc::new(SignInRenewal::new(SignInRenewalDeps {
            file: STATE.paths().data_dir().join("sign-in-renewal.json"),
            accounts: Box::new(|| STATE.accounts()),
            usage: Box::new(|id| STATE.usage().snapshot().get(id).cloned()),
            renew: Box::new(|account| Ok(renew_sign_in_quietly(account))),
            notify: Box::new(crate::services::notifications::notify_sign_in_ending),
            now: None,
        }))
    });
    // After the first reads have said when each sign-in ends.
    let first = renewal.clone();
    let _ = std::thread::Builder::new()
        .name("relay-sign-in-renewal-first".into())
        .spawn(move || {
            std::thread::sleep(FIRST_TICK);
            if !STATE.quitting() {
                first.tick();
            }
        });
    let every = renewal.clone();
    let _ = std::thread::Builder::new()
        .name("relay-sign-in-renewal".into())
        .spawn(move || {
            loop {
                std::thread::sleep(TICK_EVERY);
                if STATE.quitting() {
                    return;
                }
                every.tick();
            }
        });
}
