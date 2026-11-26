//! What the hidden renewal window does on claude.ai's authorize page, decided from what the page
//! shows, and the loop that drives that window through `host::Webviews` (the port of
//! `electron/quiet-sign-in.ts`).

use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::auth_page_policy::{local_callback, sign_in_navigation_allowed};
use crate::desktop_usage::PlainCookie;
use crate::host::{QuietNavigationKind, QuietWindow, Webviews};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalButton {
    pub text: String,
    pub disabled: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPage {
    pub host: String,
    pub path: String,
    /// The page asks for an email or a password: the session is gone.
    pub login_form: bool,
    pub buttons: Vec<ApprovalButton>,
}

/// The approval button, in the languages claude.ai shows; whole labels only.
static APPROVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(authori[sz]e|allow|approve|yetkilendir|izin ver|onayla)$").unwrap()
});
static LOGIN_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/login(?-u:\b)").unwrap());
static CLAUDE_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|\.)claude\.(ai|com)$").unwrap());

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "kebab-case")]
pub enum ApprovalStep {
    Click { index: usize },
    SignedOut,
    Wait,
}

pub fn approval_step(page: &ApprovalPage) -> ApprovalStep {
    if page.login_form || LOGIN_PATH.is_match(&page.path) {
        return ApprovalStep::SignedOut;
    }
    if !CLAUDE_HOST.is_match(&page.host) {
        return ApprovalStep::Wait;
    }
    page.buttons
        .iter()
        .position(|b| !b.disabled && APPROVE.is_match(b.text.trim()))
        .map_or(ApprovalStep::Wait, |index| ApprovalStep::Click { index })
}

/// Runs in the page: what `approval_step` reads. Button labels only; no field value or address
/// leaves the page.
pub const READ_PAGE: &str = r#"(() => {
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit]')];
  return {
    host: location.hostname,
    path: location.pathname,
    loginForm: !!document.querySelector('input[type=email], input[type=password], input[name=email]'),
    buttons: buttons.map((b) => ({ text: String(b.innerText || b.value || '').trim().slice(0, 60), disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true' })),
  };
})()"#;

/// Runs in the page: clicks the button `READ_PAGE` listed at `index`, if it is still the same.
pub fn click_button(index: usize, text: &str) -> String {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(() => {{\n  const b = [...document.querySelectorAll('button, [role=button], input[type=submit]')][{index}];\n  if (!b || String(b.innerText || b.value || '').trim().slice(0, 60) !== {text}) return false;\n  b.click();\n  return true;\n}})()"
    )
}

// ---------------------------------------------------------------------------------------------
// The quiet window
// ---------------------------------------------------------------------------------------------

/// A click is tried again when the page still shows the button this long after, at most this often.
const RECLICK: Duration = Duration::from_millis(5_000);
const MAX_CLICKS: u32 = 3;
/// How long a sign-in form must stay before the window gives up: the page passes /login on its way.
const SIGNED_OUT: Duration = Duration::from_millis(6_000);
/// How often the page is read.
const POLL: Duration = Duration::from_millis(1_000);
/// How often the window's navigations are looked at between reads.
const TICK: Duration = Duration::from_millis(100);
/// A moment for the CLI's page to answer before an approved window goes.
const CLOSE_AFTER_APPROVAL: Duration = Duration::from_millis(1_500);
pub const QUIET_TIMEOUT_MS: u64 = 60_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum QuietResult {
    Approved,
    SignedOut { detail: String },
    NoApproval { detail: String },
    Failed { detail: String },
}

/// What the last page read showed, for the log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPage {
    pub at: String,
    pub login_form: bool,
    pub buttons: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuietOutcome {
    #[serde(flatten)]
    pub result: QuietResult,
    /// Where the window went (host and path only).
    pub trail: Vec<String>,
    /// Cookies the window's session refused, by name.
    pub refused: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<LastPage>,
}

/// Host and path of an address, at most 120 characters; "?" when it is none.
fn place(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!("{}{}", u.host_str().unwrap_or(""), u.path())
            .chars()
            .take(120)
            .collect(),
        Err(_) => "?".into(),
    }
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// Opens a Claude Code sign-in page in a hidden window that holds an account's claude.ai session
/// (its cookies, in memory only) and approves it, as the user would in their browser. The page
/// then hands the approval to the CLI on localhost, which saves the new sign-in. Nothing leaves
/// Anthropic's sites and the CLI's callback; the session is dropped when the window closes.
/// Blocks until the outcome.
pub fn approve_quietly(
    webviews: &dyn Webviews,
    url: &str,
    cookies: Vec<PlainCookie>,
    timeout_ms: u64,
) -> QuietOutcome {
    let outcome = |result, trail, refused, last| QuietOutcome {
        result,
        trail,
        refused,
        last,
    };
    let Some(callback) = local_callback(url) else {
        return outcome(
            QuietResult::Failed {
                detail: "page has no local callback".into(),
            },
            Vec::new(),
            Vec::new(),
            None,
        );
    };
    let window = QuietWindow {
        url: url.to_owned(),
        cookies,
        callback,
    };
    let opened = match webviews.open_quiet(&window) {
        Ok(opened) => opened,
        Err(error) => {
            return outcome(
                QuietResult::Failed {
                    detail: clip(&error, 160),
                },
                Vec::new(),
                Vec::new(),
                None,
            );
        }
    };
    let refused = opened.refused;
    let mut page = opened.page;
    let mut trail: Vec<String> = Vec::new();
    let mut last: Option<LastPage> = None;
    let mut signed_out_since: Option<Instant> = None;
    // Clicks so far and when the last one was: a click that changed nothing (the page not yet
    // ready, or a second step) is tried again after a pause, a few times at most.
    let mut clicks = 0u32;
    let mut clicked_at: Option<Instant> = None;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);
    let mut next_read = started + POLL;
    let result = 'run: loop {
        for navigation in page.take_navigations() {
            let where_ = place(&navigation.url);
            if trail.last() != Some(&where_) && trail.len() < 30 {
                trail.push(where_);
            }
            if navigation.kind == QuietNavigationKind::Committed
                && navigation.url.starts_with("http:")
                && sign_in_navigation_allowed(&navigation.url, Some(&window.callback))
            {
                break 'run QuietResult::Approved;
            }
        }
        let now = Instant::now();
        if now >= deadline {
            break QuietResult::NoApproval {
                detail: if clicks > 0 {
                    format!("approved {clicks}x, no callback")
                } else {
                    "no approve button".into()
                },
            };
        }
        if now >= next_read {
            next_read = now + POLL;
            let read = page
                .eval(READ_PAGE)
                .and_then(|value| serde_json::from_value::<ApprovalPage>(value).ok());
            if let Some(read) = read {
                let at = clip(&format!("{}{}", read.host, read.path), 120);
                last = Some(LastPage {
                    at: at.clone(),
                    login_form: read.login_form,
                    buttons: read
                        .buttons
                        .iter()
                        .map(|b| b.text.clone())
                        .filter(|t| !t.is_empty())
                        .take(12)
                        .collect(),
                });
                match approval_step(&read) {
                    ApprovalStep::SignedOut => {
                        let since = *signed_out_since.get_or_insert(now);
                        if now.duration_since(since) >= SIGNED_OUT {
                            break QuietResult::SignedOut {
                                detail: format!("claude.ai asked to sign in at {at}"),
                            };
                        }
                    }
                    step => {
                        signed_out_since = None;
                        if let ApprovalStep::Click { index } = step
                            && clicks < MAX_CLICKS
                            && clicked_at.is_none_or(|at| now.duration_since(at) >= RECLICK)
                        {
                            let done = page
                                .eval(&click_button(index, &read.buttons[index].text))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if done {
                                clicks += 1;
                                clicked_at = Some(Instant::now());
                            }
                        }
                    }
                }
            }
        }
        thread::sleep(TICK.min(deadline.saturating_duration_since(Instant::now())));
    };
    if result == QuietResult::Approved {
        thread::spawn(move || {
            thread::sleep(CLOSE_AFTER_APPROVAL);
            page.close();
        });
    } else {
        page.close();
    }
    outcome(result, trail, refused, last)
}
