//! Port of `shared/meters.ts`: read-only usage meters for other AI tools on this computer.

use serde::{Deserialize, Serialize};

use super::types::js;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeterProvider {
    Copilot,
    Cursor,
    GeminiCli,
}

/// `METER_PROVIDERS`, in Relay's order.
pub const METER_PROVIDERS: [MeterProvider; 3] = [
    MeterProvider::Copilot,
    MeterProvider::Cursor,
    MeterProvider::GeminiCli,
];

impl MeterProvider {
    pub const fn as_str(self) -> &'static str {
        match self {
            MeterProvider::Copilot => "copilot",
            MeterProvider::Cursor => "cursor",
            MeterProvider::GeminiCli => "gemini-cli",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        METER_PROVIDERS.into_iter().find(|p| p.as_str() == id)
    }

    /// `METER_NAMES`: the tools' own product names, shown as they are in every language.
    pub const fn name(self) -> &'static str {
        match self {
            MeterProvider::Copilot => "GitHub Copilot",
            MeterProvider::Cursor => "Cursor",
            MeterProvider::GeminiCli => "Gemini CLI",
        }
    }
}

/// How long a meter waits between two reads, even when asked sooner.
pub const METER_INTERVAL_MS: u64 = 10 * 60_000;

/// What a window counts: requests, Copilot's premium requests, or dollars of a plan's budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum MeterUnit {
    #[serde(rename = "requests")]
    Requests,
    #[serde(rename = "premium requests")]
    PremiumRequests,
    #[serde(rename = "$")]
    Dollars,
}

/// One limit of a meter, by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeterWindowName {
    Premium,
    Chat,
    Completions,
    Included,
    Auto,
    Api,
    OnDemand,
    Requests,
    Pro,
    Flash,
    FlashLite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeterWindowKind {
    Daily,
    Monthly,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterWindow {
    pub name: MeterWindowName,
    /// A daily window (Gemini) or a billing month (Copilot, Cursor).
    pub kind: MeterWindowKind,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub used_percent: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub used: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "js::ser_opt_num"
    )]
    pub limit: Option<f64>,
    pub unit: MeterUnit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
}

/// Why a meter has no current reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MeterIssue {
    NotSignedIn,
    Expired,
    Encrypted,
    NotAvailable,
    UnsupportedAuth,
    RateLimited,
    Unavailable,
    Unsupported,
}

/// `METER_ISSUES`.
pub const METER_ISSUES: [MeterIssue; 8] = [
    MeterIssue::NotSignedIn,
    MeterIssue::Expired,
    MeterIssue::Encrypted,
    MeterIssue::NotAvailable,
    MeterIssue::UnsupportedAuth,
    MeterIssue::RateLimited,
    MeterIssue::Unavailable,
    MeterIssue::Unsupported,
];

/// Official: a documented API. Unofficial: an endpoint the tool itself uses, undocumented.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeterSource {
    Official,
    Unofficial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterReadingError {
    pub issue: MeterIssue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterReading {
    pub provider: MeterProvider,
    /// The plan or login the provider reported ("individual", "pro", "Standard").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub windows: Vec<MeterWindow>,
    pub source: MeterSource,
    /// When `windows` were read; absent before the first good read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    /// The last read failed: shown beside the windows of the read before it, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<MeterReadingError>,
}

/// The meters turned on, once each, in Relay's order.
pub fn enabled_meters(meters: Option<&[MeterProvider]>) -> Vec<MeterProvider> {
    METER_PROVIDERS
        .into_iter()
        .filter(|p| meters.is_some_and(|list| list.contains(p)))
        .collect()
}
