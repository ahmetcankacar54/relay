//! The Rust port of `shared/widget-snapshot.ts`, delegating to
//! `relay_core::shared::widget_snapshot`.

#![forbid(unsafe_code)]

use parity_args::{arg, opt_arg};
use relay_core::shared::token_usage_view::{TokenDay, TokenToday};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{Account, AccountUsage, RelaySettings};
use relay_core::shared::widget_snapshot::{
    self, WidgetLimits, WidgetMoodLimits, WidgetProgress, WidgetSnapshot, WidgetSnapshotInput,
    WidgetState,
};
use relay_i18n::Locale;
use serde::Deserialize;

/// The TS `WidgetSnapshotInput`, owned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    today: TokenToday,
    progress: Progress,
    language: String,
    zone: String,
    now: f64,
    #[serde(default)]
    days: Option<Vec<TokenDay>>,
    #[serde(default)]
    limits: Option<Limits>,
    #[serde(default)]
    hits: Option<f64>,
}

#[derive(Deserialize)]
struct Progress {
    complete: bool,
    percent: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    accounts: Vec<Account>,
    usage: JsMap<AccountUsage>,
    #[serde(default)]
    active_id: Option<String>,
    settings: RelaySettings,
    #[serde(default)]
    rate: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mood {
    #[serde(default)]
    five_hour: Option<f64>,
    #[serde(default)]
    week: Option<f64>,
}

fn locale(language: &str) -> Result<Locale, String> {
    Locale::parse(language).ok_or_else(|| format!("TypeError: not a locale: {language}"))
}

/// Port of `widgetMood` (`shared/widget-snapshot.ts:112`).
pub fn widget_mood(
    state: serde_json::Value,
    active: Option<serde_json::Value>,
) -> Result<String, String> {
    let state: WidgetState = arg(&state)?;
    let active: Option<Mood> = opt_arg(active.as_ref())?;
    let active = active.map(|m| WidgetMoodLimits {
        five_hour: m.five_hour,
        week: m.week,
    });
    Ok(widget_snapshot::widget_mood(state, active)
        .as_str()
        .to_string())
}

/// Port of `widgetCountdown` (`shared/widget-snapshot.ts:294`).
pub fn widget_countdown(at: Option<f64>, now: f64) -> Result<serde_json::Value, String> {
    Ok(widget_snapshot::widget_countdown(at, now).into())
}

/// Port of `buildWidgetSnapshot` (`shared/widget-snapshot.ts:340`).
pub fn build_widget_snapshot(input: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: Input = arg(&input)?;
    let snapshot = widget_snapshot::build_widget_snapshot(&WidgetSnapshotInput {
        today: &input.today,
        progress: WidgetProgress {
            complete: input.progress.complete,
            percent: input.progress.percent,
        },
        language: locale(&input.language)?,
        zone: &input.zone,
        now: input.now,
        days: input.days.as_deref(),
        limits: input.limits.as_ref().map(|l| WidgetLimits {
            accounts: &l.accounts,
            usage: &l.usage,
            active_id: l.active_id.as_deref(),
            settings: &l.settings,
            rate: l.rate,
        }),
        hits: input.hits,
    });
    serde_json::to_value(snapshot).map_err(|e| e.to_string())
}

/// Port of `widgetVisibleKey` (`shared/widget-snapshot.ts:683`).
pub fn widget_visible_key(snapshot: serde_json::Value) -> Result<String, String> {
    let snapshot: WidgetSnapshot = arg(&snapshot)?;
    Ok(widget_snapshot::widget_visible_key(&snapshot))
}
