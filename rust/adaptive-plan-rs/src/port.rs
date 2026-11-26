//! The Rust port of `shared/adaptive-plan.ts`, delegating to `relay_core::shared::adaptive_plan`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;
mod segments;

use relay_core::shared::adaptive_plan::{self, PaceInput, ReplanInput, Span};
use relay_core::shared::capacity_plan::SimAccount;
use relay_core::shared::day_plan::{DayPlan, PlanContext};
use relay_core::shared::live_forecast::LiveInput;
use relay_core::shared::tempo::Tempo;
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{Account, AccountUsage, PlanningSettings};
use relay_core::shared::usage_statistics::UsageSample;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use args::arg;

fn out(value: impl Serialize) -> Result<Value, String> {
    let mut value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    segments::mark_outages(&mut value);
    Ok(value)
}

/// Port of `plannedRate` (`shared/adaptive-plan.ts:132`).
pub fn planned_rate(tempo: Value, settings: Value, spans: Vec<Value>) -> Result<f64, String> {
    let tempo: Tempo = arg(tempo)?;
    let settings: PlanningSettings = arg(settings)?;
    let spans: Vec<Span> = spans.into_iter().map(arg).collect::<Result<_, _>>()?;
    Ok(adaptive_plan::planned_rate(&tempo, &settings, &spans))
}

/// Port of `paceFactor` (`shared/adaptive-plan.ts:157`).
pub fn pace_factor(observed: Option<f64>, planned: f64) -> Result<f64, String> {
    Ok(adaptive_plan::pace_factor(observed, planned))
}

/// The TS `todaysPace` argument, owned.
#[derive(Deserialize)]
struct PaceArg {
    samples: Vec<UsageSample>,
    accounts: Vec<Account>,
    tempo: Tempo,
    settings: PlanningSettings,
    from: f64,
    to: f64,
}

/// Port of `todaysPace` (`shared/adaptive-plan.ts:182`).
pub fn todays_pace(arg0: Value) -> Result<Value, String> {
    let input: PaceArg = arg(arg0)?;
    out(adaptive_plan::todays_pace(PaceInput {
        samples: &input.samples,
        accounts: &input.accounts,
        tempo: &input.tempo,
        settings: &input.settings,
        from: input.from,
        to: input.to,
    }))
}

/// Port of `nextStartCandidates` (`shared/adaptive-plan.ts:238`).
pub fn next_start_candidates(a: Value, from: f64, to: f64) -> Result<Vec<f64>, String> {
    let a: SimAccount = arg(a)?;
    Ok(adaptive_plan::next_start_candidates(&a, from, to))
}

/// The TS `ReplanInput`, owned (a carried `schedule` is read and ignored, as in the TS).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplanArg {
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
    exact: Option<bool>,
    #[serde(default)]
    schedule: Option<JsMap<f64>>,
    blocked: Vec<String>,
}

/// Port of `replanStarts` (`shared/adaptive-plan.ts:264`).
pub fn replan_starts(input: Value) -> Result<Option<Value>, String> {
    let input: ReplanArg = arg(input)?;
    let replan = adaptive_plan::replan_starts(&ReplanInput {
        live: LiveInput {
            plan: &input.plan,
            settings: &input.settings,
            context: &input.context,
            usage: &input.usage,
            active_id: input.active_id.as_deref(),
            now: input.now,
            factor: input.factor,
            schedule: input.schedule.as_ref(),
            exact: input.exact == Some(true),
        },
        blocked: &input.blocked,
    });
    replan.map(out).transpose()
}
