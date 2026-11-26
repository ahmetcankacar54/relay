//! The Rust port of `shared/live-forecast.ts`, delegating to `relay_core::shared::live_forecast`.
//!
//! Only argument and result conversion lives here. `liveSetup` stays in TypeScript here (its
//! result carries the demand function); its port, `live_forecast::live_setup`, is checked by
//! the ported unit tests and through `liveForecast`, which simulates it.

#![forbid(unsafe_code)]

mod args;
mod segments;

use relay_core::shared::day_plan::{DayPlan, PlanContext};
use relay_core::shared::live_forecast::{self, LiveInput};
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{AccountUsage, PlanningSettings};
use serde::Deserialize;
use serde_json::Value;

use args::arg;

/// The TS `LiveInput`, owned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    plan: DayPlan,
    settings: PlanningSettings,
    context: PlanContext,
    usage: JsMap<AccountUsage>,
    #[serde(default)]
    active_id: Option<String>,
    now: f64,
    #[serde(default)]
    factor: Option<f64>,
    #[serde(default)]
    schedule: Option<JsMap<f64>>,
    #[serde(default)]
    exact: Option<bool>,
}

/// Port of `liveForecast` (`shared/live-forecast.ts:197`).
pub fn live_forecast(input: Value) -> Result<Option<Value>, String> {
    let input: Input = arg(input)?;
    let forecast = live_forecast::live_forecast(LiveInput {
        plan: &input.plan,
        settings: &input.settings,
        context: &input.context,
        usage: &input.usage,
        active_id: input.active_id.as_deref(),
        now: input.now,
        factor: input.factor,
        schedule: input.schedule.as_ref(),
        exact: input.exact == Some(true),
    });
    forecast
        .map(|f| {
            let mut value = serde_json::to_value(f).map_err(|e| e.to_string())?;
            segments::mark_outages(&mut value);
            Ok(value)
        })
        .transpose()
}
