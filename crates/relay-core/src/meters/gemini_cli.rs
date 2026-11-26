//! Port of `electron/core/meters/gemini-cli.ts`: Gemini CLI's daily quota, from Code Assist's
//! `loadCodeAssist` (the tier and project) and `retrieveUserQuota` (a bucket per model), the
//! calls Gemini CLI's own `/stats` makes. It uses the access token Gemini CLI saved in
//! `~/.gemini/oauth_creds.json` while it is valid, and never renews it: renewing would need
//! Gemini CLI's own OAuth client, which Gemini CLI's FAQ forbids other software to use.
//!
//! Google ended Gemini CLI sign-ins for personal Google accounts on 2026-06-18; only Workspace,
//! education and Code Assist Standard/Enterprise accounts still have a quota here. Code Assist
//! says so by listing the account's tiers as ineligible.

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::common::{
    Json, MeterError, MeterRead, MeterReaderOptions, clamp_percent, iso_date, num, object,
    plain_label, request_json,
};
use crate::shared::meters::{MeterIssue, MeterUnit, MeterWindow, MeterWindowKind, MeterWindowName};

const CODE_ASSIST: &str = "https://cloudcode-pa.googleapis.com/v1internal";
/// A token this close to its end is not sent.
const EXPIRY_MARGIN_MS: f64 = 60_000.0;

fn read_json(file: &Path) -> Option<Json> {
    match serde_json::from_slice::<Value>(&fs::read(file).ok()?).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// The saved access token, when Gemini CLI signs in with Google: `security.auth.selectedType`
/// (`selectedAuthType` in older settings) is `oauth-personal` or unset. An API key or Vertex AI
/// has no quota to read.
pub fn find_gemini_token(options: &MeterReaderOptions) -> Result<String, MeterError> {
    let dir = options.home().join(".gemini");
    let settings = read_json(&dir.join("settings.json"));
    let selected = settings.as_ref().and_then(|s| {
        s.get("security")
            .and_then(|v| v.get("auth"))
            .and_then(|v| v.get("selectedType"))
            .filter(|v| !v.is_null())
            .or_else(|| s.get("selectedAuthType"))
    });
    if let Some(Value::String(selected)) = selected
        && selected != "oauth-personal"
    {
        return Err(MeterError::new(
            MeterIssue::UnsupportedAuth,
            None,
            "gemini-cli: not a Google sign-in",
        ));
    }
    let creds = read_json(&dir.join("oauth_creds.json"));
    let token = creds
        .as_ref()
        .and_then(|c| c.get("access_token"))
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            MeterError::new(
                MeterIssue::NotSignedIn,
                None,
                "gemini-cli: no saved sign-in",
            )
        })?;
    if let Some(expiry) = num(creds.as_ref().and_then(|c| c.get("expiry_date")))
        && expiry - options.now() <= EXPIRY_MARGIN_MS
    {
        return Err(MeterError::new(
            MeterIssue::Expired,
            None,
            "gemini-cli: token ended",
        ));
    }
    Ok(token.to_owned())
}

/// The plan and project of an account.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CodeAssistTier {
    pub label: Option<String>,
    pub project: Option<String>,
}

static PROJECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$").expect("valid regex"));

/// The plan and project in a `loadCodeAssist` answer; refuses an account with no eligible tier.
pub fn parse_load_code_assist(value: &Value) -> Result<CodeAssistTier, MeterError> {
    let Some(root) = value.as_object() else {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            "gemini-cli: tier not an object",
        ));
    };
    let Some(current) = object(root.get("currentTier")) else {
        let ineligible = root
            .get("ineligibleTiers")
            .and_then(Value::as_array)
            .is_some_and(|tiers| !tiers.is_empty());
        return Err(MeterError::new(
            if ineligible {
                MeterIssue::NotAvailable
            } else {
                MeterIssue::Unsupported
            },
            None,
            "gemini-cli: no current tier",
        ));
    };
    let paid = object(root.get("paidTier"));
    let label = plain_label(paid.and_then(|p| p.get("name")))
        .or_else(|| plain_label(current.get("name")))
        .or_else(|| plain_label(current.get("id")));
    let project = match root.get("cloudaicompanionProject") {
        Some(Value::String(project)) => Some(project.as_str()),
        Some(Value::Object(project)) => project.get("id").and_then(Value::as_str),
        _ => None,
    };
    Ok(CodeAssistTier {
        label,
        project: project.filter(|p| PROJECT.is_match(p)).map(str::to_owned),
    })
}

/// A model's family by name: flash-lite before flash, flash before pro.
fn family(model_id: &str) -> Option<MeterWindowName> {
    let id = model_id.to_lowercase();
    if id.contains("flash-lite") {
        Some(MeterWindowName::FlashLite)
    } else if id.contains("flash") {
        Some(MeterWindowName::Flash)
    } else if id.contains("pro") {
        Some(MeterWindowName::Pro)
    } else {
        None
    }
}

const FAMILY_ORDER: [MeterWindowName; 3] = [
    MeterWindowName::Pro,
    MeterWindowName::Flash,
    MeterWindowName::FlashLite,
];

/// The day's windows in a `retrieveUserQuota` answer: per model family the bucket with the
/// least left (`remainingFraction`, 0–1), as the share used.
pub fn parse_gemini_quota(value: &Value) -> Result<Vec<MeterWindow>, MeterError> {
    let Some(root) = value.as_object() else {
        return Err(MeterError::new(
            MeterIssue::Unsupported,
            None,
            "gemini-cli: quota not an object",
        ));
    };
    let buckets = root
        .get("buckets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut least: Vec<(MeterWindowName, f64, Option<String>)> = Vec::new();
    for bucket in buckets.iter().filter_map(Value::as_object) {
        let name = bucket
            .get("modelId")
            .and_then(Value::as_str)
            .and_then(family);
        let fraction = num(bucket.get("remainingFraction"));
        let (Some(name), Some(fraction)) = (name, fraction) else {
            continue;
        };
        match least.iter_mut().find(|(n, _, _)| *n == name) {
            Some(known) if fraction >= known.1 => {}
            Some(known) => *known = (name, fraction, iso_date(bucket.get("resetTime"))),
            None => least.push((name, fraction, iso_date(bucket.get("resetTime")))),
        }
    }
    Ok(FAMILY_ORDER
        .iter()
        .filter_map(|name| {
            let (_, fraction, resets_at) = least.iter().find(|(n, _, _)| n == name)?;
            Some(MeterWindow {
                name: *name,
                kind: MeterWindowKind::Daily,
                used_percent: Some(clamp_percent(100.0 - fraction * 100.0)),
                used: None,
                limit: None,
                unit: MeterUnit::Requests,
                resets_at: resets_at.clone(),
            })
        })
        .collect())
}

static NOT_SUPPORTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)UNSUPPORTED_CLIENT|INELIGIBLE|not (?:supported|available|eligible)")
        .expect("valid regex")
});

/// A refusal that says the client or the account is not supported (a personal account since
/// 2026-06-18).
fn not_supported(text: &str) -> bool {
    NOT_SUPPORTED.is_match(text)
}

/// Reads the day's quota of the Gemini CLI sign-in found on this computer.
pub fn read_gemini_cli(options: &MeterReaderOptions) -> Result<MeterRead, MeterError> {
    let token = find_gemini_token(options)?;
    let authorization = format!("Bearer {token}");
    let headers = [
        ("Authorization", authorization.as_str()),
        ("Accept", "application/json"),
        ("Content-Type", "application/json"),
    ];
    let accept = |status: u16| status == 400 || status == 403;
    let tier = request_json(
        &format!("{CODE_ASSIST}:loadCodeAssist"),
        "POST",
        &headers,
        Some(
            json!({ "metadata": { "ideType": "GEMINI_CLI", "pluginType": "GEMINI" } }).to_string(),
        ),
        "gemini-cli tier",
        options,
        Some(&accept),
    )?;
    if tier.status != 200 {
        return Err(MeterError::new(
            if not_supported(&tier.text) {
                MeterIssue::NotAvailable
            } else if tier.status == 403 {
                MeterIssue::Expired
            } else {
                MeterIssue::Unsupported
            },
            None,
            format!("gemini-cli tier {}", tier.status),
        ));
    }
    let CodeAssistTier { label, project } = parse_load_code_assist(&tier.body)?;
    let body = match &project {
        Some(project) => json!({ "project": project }),
        None => json!({}),
    };
    let quota = request_json(
        &format!("{CODE_ASSIST}:retrieveUserQuota"),
        "POST",
        &headers,
        Some(body.to_string()),
        "gemini-cli quota",
        options,
        Some(&accept),
    )?;
    if quota.status != 200 {
        return Err(MeterError::new(
            if not_supported(&quota.text) || quota.status == 403 {
                MeterIssue::NotAvailable
            } else {
                MeterIssue::Unsupported
            },
            None,
            format!("gemini-cli quota {}", quota.status),
        ));
    }
    Ok(MeterRead {
        label,
        windows: parse_gemini_quota(&quota.body)?,
    })
}
