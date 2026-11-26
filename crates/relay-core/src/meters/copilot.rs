//! Port of `electron/core/meters/copilot.ts`: GitHub Copilot's monthly quotas, from
//! `api.github.com/copilot_internal/user`, the private call Copilot's own editor plugins make.
//! It takes any GitHub OAuth token in the `token` scheme, so the meter uses the one Copilot's
//! plugins or the `gh` CLI already saved, and never signs in itself.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::Value;

use super::common::{
    MeterError, MeterRead, MeterReaderOptions, clamp_percent, iso_date, num, object, plain_label,
    request_json,
};
use crate::detached_exec::{ExecOptions, run_attached};
use crate::relay_paths::Platform;
use crate::shared::meters::{MeterIssue, MeterUnit, MeterWindow, MeterWindowKind, MeterWindowName};

pub const COPILOT_USER_URL: &str = "https://api.github.com/copilot_internal/user";

/// The headers Copilot Chat sends; the endpoint answers editors only.
const HEADERS: [(&str, &str); 5] = [
    ("Accept", "application/json"),
    ("Editor-Version", "vscode/1.96.2"),
    ("Editor-Plugin-Version", "copilot-chat/0.26.7"),
    ("User-Agent", "GitHubCopilotChat/0.26.7"),
    ("X-Github-Api-Version", "2025-04-01"),
];

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.-]{20,255}$").expect("valid regex"));

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopilotToken {
    pub token: String,
    /// The GitHub login the file names, when it does.
    pub login: Option<String>,
}

/// `gh auth token`, or a stand-in: the token `gh` keeps, given the environment.
pub type GhToken = Arc<dyn Fn(&BTreeMap<String, String>) -> Option<String> + Send + Sync>;

fn config_home(home: &Path, env: &BTreeMap<String, String>) -> PathBuf {
    match env.get("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home.join(".config"),
    }
}

/// Copilot's plugins keep their sign-in under the config folder: `~/.config/github-copilot`
/// (`%LOCALAPPDATA%` on Windows).
fn copilot_dirs(home: &Path, env: &BTreeMap<String, String>, platform: Platform) -> Vec<PathBuf> {
    let mut dirs = vec![config_home(home, env).join("github-copilot")];
    if platform == Platform::Windows
        && let Some(local) = env.get("LOCALAPPDATA").filter(|v| !v.is_empty())
    {
        dirs.push(Path::new(local).join("github-copilot"));
    }
    dirs
}

/// The github.com token in a Copilot `apps.json` or `hosts.json`: an object keyed by host
/// (`github.com`, or `github.com:<app id>` in apps.json) whose value holds `oauth_token` and
/// `user`.
pub fn copilot_token_from_file(value: &Value) -> Option<CopilotToken> {
    for (host, entry) in value.as_object()? {
        if host != "github.com" && !host.starts_with("github.com:") {
            continue;
        }
        let token = entry.get("oauth_token").and_then(Value::as_str);
        if let Some(token) = token.filter(|t| TOKEN.is_match(t)) {
            return Some(CopilotToken {
                token: token.to_owned(),
                login: plain_label(entry.get("user")),
            });
        }
    }
    None
}

static TOP_LEVEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\S").expect("valid regex"));
static GITHUB_HOST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^github\.com:\s*$").expect("valid regex"));
static FIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^ {4}(oauth_token|user):\s*"?([^"\s]+)"?\s*$"#).expect("valid regex")
});

/// A plain-text token in `gh`'s `hosts.yml` (saved so when `gh` has no keyring):
/// `oauth_token:` under `github.com:`.
pub fn gh_token_from_hosts(text: &str) -> Option<CopilotToken> {
    let mut in_github = false;
    let mut token: Option<String> = None;
    let mut login: Option<String> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if TOP_LEVEL.is_match(line) {
            if in_github {
                break;
            }
            in_github = GITHUB_HOST.is_match(line);
            continue;
        }
        if !in_github {
            continue;
        }
        if let Some(field) = FIELD.captures(line) {
            if &field[1] == "oauth_token" {
                token = Some(field[2].to_owned());
            } else {
                login = plain_label(Some(&Value::String(field[2].to_owned())));
            }
        }
    }
    token
        .filter(|t| TOKEN.is_match(t))
        .map(|token| CopilotToken { token, login })
}

/// `gh auth token`, which prints the token `gh` keeps (in its own keyring item, which it may
/// read without asking).
pub fn gh_auth_token(env: &BTreeMap<String, String>) -> Option<String> {
    let mut env = env.clone();
    env.insert("GH_PROMPT_DISABLED".into(), "1".into());
    env.insert("NO_COLOR".into(), "1".into());
    let out = run_attached(
        "gh",
        &[
            "auth".to_owned(),
            "token".to_owned(),
            "--hostname".to_owned(),
            "github.com".to_owned(),
        ],
        &ExecOptions {
            env: Some(env),
            ..ExecOptions::timeout_ms(5_000)
        },
    )
    .ok()?;
    let token = out.stdout.trim();
    TOKEN.is_match(token).then(|| token.to_owned())
}

fn read_json(file: &Path) -> Value {
    fs::read(file)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or(Value::Null)
}

/// The first GitHub token found: Copilot's `apps.json`, then its older `hosts.json`, then
/// `gh`'s plain-text `hosts.yml`, then `gh auth token`.
pub fn find_copilot_token(
    options: &MeterReaderOptions,
    gh_token: Option<&GhToken>,
) -> Option<CopilotToken> {
    let home = options.home();
    let env = options.env();
    for dir in copilot_dirs(&home, &env, options.platform()) {
        for name in ["apps.json", "hosts.json"] {
            if let Some(found) = copilot_token_from_file(&read_json(&dir.join(name))) {
                return Some(found);
            }
        }
    }
    let gh_dir = match env.get("GH_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => config_home(&home, &env).join("gh"),
    };
    let hosts = fs::read_to_string(gh_dir.join("hosts.yml")).unwrap_or_default();
    if let Some(plain) = gh_token_from_hosts(&hosts) {
        return Some(plain);
    }
    let token = match gh_token {
        Some(ask) => ask(&env),
        None => gh_auth_token(&env),
    };
    token.map(|token| CopilotToken { token, login: None })
}

const SNAPSHOTS: [(&str, MeterWindowName, MeterUnit); 3] = [
    (
        "premium_interactions",
        MeterWindowName::Premium,
        MeterUnit::PremiumRequests,
    ),
    ("chat", MeterWindowName::Chat, MeterUnit::Requests),
    (
        "completions",
        MeterWindowName::Completions,
        MeterUnit::Requests,
    ),
];

/// One quota snapshot as a window, or none when it is unlimited or an org seat's empty
/// placeholder.
fn snapshot_window(
    raw: Option<&Value>,
    name: MeterWindowName,
    unit: MeterUnit,
    resets_at: Option<&String>,
) -> Option<MeterWindow> {
    let s = object(raw)?;
    if s.get("unlimited") == Some(&Value::Bool(true)) {
        return None;
    }
    let limit = num(s.get("entitlement"));
    let remaining = num(s.get("remaining"));
    if limit == Some(0.0) && remaining.unwrap_or(0.0) == 0.0 {
        return None;
    }
    let used_percent = match (num(s.get("percent_remaining")), limit, remaining) {
        (Some(left), _, _) => clamp_percent(100.0 - left),
        (None, Some(limit), Some(remaining)) if limit != 0.0 => {
            clamp_percent((limit - remaining) / limit * 100.0)
        }
        _ => return None,
    };
    let (used, limit) = match (limit, remaining) {
        (Some(limit), Some(remaining)) => (Some((limit - remaining).max(0.0)), Some(limit)),
        _ => (None, None),
    };
    Some(MeterWindow {
        name,
        kind: MeterWindowKind::Monthly,
        used_percent: Some(used_percent),
        used,
        limit,
        unit,
        resets_at: resets_at.cloned(),
    })
}

/// The windows and plan in a `copilot_internal/user` answer.
pub fn parse_copilot_user(value: &Value, login: Option<&str>) -> Result<MeterRead, MeterError> {
    let Some(root) = value.as_object() else {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            "copilot: not an object",
        ));
    };
    if root.get("access_type_sku").and_then(Value::as_str) == Some("subscription_ended") {
        return Err(MeterError::new(
            MeterIssue::NotAvailable,
            None,
            "copilot: subscription ended",
        ));
    }
    let resets_at = iso_date(root.get("quota_reset_date"))
        .or_else(|| iso_date(root.get("limited_user_reset_date")));
    let mut windows = Vec::new();
    let snapshots = root.get("quota_snapshots").filter(|v| js_object(v));
    if let Some(snapshots) = snapshots {
        for (key, name, unit) in SNAPSHOTS {
            if let Some(window) =
                snapshot_window(snapshots.get(key), name, unit, resets_at.as_ref())
            {
                windows.push(window);
            }
        }
    } else if let (Some(monthly), Some(limited)) = (
        root.get("monthly_quotas").filter(|v| js_truthy(v)),
        root.get("limited_user_quotas").filter(|v| js_truthy(v)),
    ) {
        // Copilot Free before quota snapshots: the month's allowance, and what is left of it.
        for (key, name) in [
            ("chat", MeterWindowName::Chat),
            ("completions", MeterWindowName::Completions),
        ] {
            let limit = num(monthly.get(key)).filter(|l| *l != 0.0);
            let remaining = num(limited.get(key));
            let (Some(limit), Some(remaining)) = (limit, remaining) else {
                continue;
            };
            windows.push(MeterWindow {
                name,
                kind: MeterWindowKind::Monthly,
                used_percent: Some(clamp_percent((limit - remaining) / limit * 100.0)),
                used: Some((limit - remaining).max(0.0)),
                limit: Some(limit),
                unit: MeterUnit::Requests,
                resets_at: resets_at.clone(),
            });
        }
    }
    let plan = plain_label(root.get("copilot_plan"));
    let parts: Vec<&str> = [plan.as_deref(), login.filter(|l| !l.is_empty())]
        .into_iter()
        .flatten()
        .collect();
    let label = (!parts.is_empty()).then(|| parts.join(" · "));
    Ok(MeterRead { label, windows })
}

/// `value && typeof value === "object"`: an object or an array.
fn js_object(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

/// JavaScript truthiness of a JSON value.
fn js_truthy(value: &Value) -> bool {
    crate::desktop_files::js_truthy(value)
}

/// Reads the Copilot quotas of the GitHub sign-in found on this computer.
pub fn read_copilot(
    options: &MeterReaderOptions,
    gh_token: Option<&GhToken>,
) -> Result<MeterRead, MeterError> {
    let Some(found) = find_copilot_token(options, gh_token) else {
        return Err(MeterError::new(
            MeterIssue::NotSignedIn,
            None,
            "copilot: no GitHub token",
        ));
    };
    let authorization = format!("token {}", found.token);
    let mut headers = HEADERS.to_vec();
    headers.push(("Authorization", &authorization));
    // A 403 or 404 is an account without Copilot; a 401 a token GitHub no longer takes.
    let answer = request_json(
        COPILOT_USER_URL,
        "GET",
        &headers,
        None,
        "copilot user",
        options,
        Some(&|status| status == 403 || status == 404),
    )?;
    if answer.status != 200 {
        return Err(MeterError::new(
            MeterIssue::NotAvailable,
            None,
            format!("copilot user {}", answer.status),
        ));
    }
    parse_copilot_user(&answer.body, found.login.as_deref())
}
