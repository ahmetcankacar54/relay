//! The Rust port of `shared/day-plan.ts`, delegating to `relay_core::shared::day_plan`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;
mod segments;

use relay_core::shared::day_plan::{self, PlanContext};
use relay_core::shared::tempo::Tempo;
use relay_core::shared::types::js::JsMap;
use relay_core::shared::types::{Account, PlanningSettings};
use serde::Serialize;
use serde_json::Value;

use args::{arg, opt_arg};

fn out(value: impl Serialize) -> Result<Value, String> {
    let mut value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    segments::mark_outages(&mut value);
    Ok(value)
}

/// Port of `planContext` (`shared/day-plan.ts:57`).
pub fn plan_context(accounts: Vec<Value>, tempo: Value) -> Result<Value, String> {
    let accounts: Vec<Account> = accounts.into_iter().map(arg).collect::<Result<_, _>>()?;
    let tempo: Tempo = arg(tempo)?;
    out(day_plan::plan_context(&accounts, tempo))
}

/// Port of `cyclePhases` (`shared/day-plan.ts:71`).
pub fn cycle_phases(fixed: Vec<Option<f64>>) -> Result<Vec<f64>, String> {
    Ok(day_plan::cycle_phases(&fixed))
}

/// Port of `clearPlanCache` (`shared/day-plan.ts:144`).
pub fn clear_plan_cache() -> Result<Value, String> {
    day_plan::clear_plan_cache();
    Ok(crate::js::undefined())
}

/// Port of `planCacheStats` (`shared/day-plan.ts:150`).
pub fn plan_cache_stats() -> Result<Value, String> {
    out(day_plan::plan_cache_stats())
}

/// Port of `dayPlan` (`shared/day-plan.ts:234`): `liveResets` entries that are `undefined`
/// count as absent, as the TS reads them. A day without work hours returns
/// `{ date, interval: undefined, accounts: [] }`, the key holding `undefined`.
pub fn day_plan(
    date: String,
    settings: Value,
    context: Value,
    live_resets: Option<Value>,
) -> Result<Value, String> {
    let settings: PlanningSettings = arg(settings)?;
    let context: PlanContext = arg(context)?;
    let live: Option<JsMap<f64>> = opt_arg(live_resets)?;
    let mut value = out(day_plan::day_plan(
        &date,
        &settings,
        &context,
        live.as_ref(),
    ))?;
    if let Value::Object(plan) = &mut value
        && !plan.contains_key("interval")
    {
        let accounts = plan.remove("accounts").unwrap_or_default();
        plan.insert("interval".into(), crate::js::undefined());
        plan.insert("accounts".into(), accounts);
    }
    Ok(value)
}

/// Port of `shouldHaveWindow` (`shared/day-plan.ts:308`).
pub fn should_have_window(
    account_id: String,
    now: f64,
    settings: Value,
    context: Value,
) -> Result<Value, String> {
    let settings: PlanningSettings = arg(settings)?;
    let context: PlanContext = arg(context)?;
    Ok(Value::Bool(day_plan::should_have_window(
        &account_id,
        now,
        &settings,
        &context,
    )))
}

/// Port of `nextPlannedStart` (`shared/day-plan.ts:323`).
pub fn next_planned_start(
    account_id: String,
    now: f64,
    settings: Value,
    context: Value,
) -> Result<Value, String> {
    let settings: PlanningSettings = arg(settings)?;
    let context: PlanContext = arg(context)?;
    Ok(
        match day_plan::next_planned_start(&account_id, now, &settings, &context) {
            Some(start) => crate::js::number(start),
            None => crate::js::undefined(),
        },
    )
}
