//! The Rust port of `shared/tempo.ts`, delegating to `relay_core::shared::tempo`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns. `tempoRate` stays in
//! TypeScript here (it returns a function); its port, `tempo::tempo_rate`, is checked by the
//! ported unit tests.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::tempo::{self, LearnTempoInput, Tempo, TempoDays, TempoSource};
use relay_core::shared::types::{Account, PlanningSettings, TempoChoice};
use relay_core::shared::usage_rollups::UsageRollups;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use args::{arg, opt_arg};

fn out(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// The TS `learnTempo` argument, owned.
#[derive(Deserialize)]
struct LearnInput {
    #[serde(default)]
    rollups: Option<UsageRollups>,
    accounts: Vec<Account>,
    settings: PlanningSettings,
    now: f64,
}

/// Port of `presetTempo` (`shared/tempo.ts:28`), with the TS defaults: source `"preset"`, no days.
pub fn preset_tempo(
    choice: serde_json::Value,
    source: Option<serde_json::Value>,
    days: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let choice: TempoChoice = arg(choice)?;
    let source: TempoSource = opt_arg(source)?.unwrap_or(TempoSource::Preset);
    let days: TempoDays = opt_arg(days)?.unwrap_or_default();
    out(tempo::preset_tempo(choice, source, days))
}

/// Port of `fallbackTempo` (`shared/tempo.ts:43`).
pub fn fallback_tempo(settings: serde_json::Value) -> Result<serde_json::Value, String> {
    let settings: PlanningSettings = arg(settings)?;
    out(tempo::fallback_tempo(&settings))
}

/// Port of `learnTempo` (`shared/tempo.ts:62`).
pub fn learn_tempo(arg0: serde_json::Value) -> Result<serde_json::Value, String> {
    let input: LearnInput = arg(arg0)?;
    out(tempo::learn_tempo(LearnTempoInput {
        rollups: input.rollups.as_ref(),
        accounts: &input.accounts,
        settings: &input.settings,
        now: input.now,
    }))
}

/// Port of `tempoAt` (`shared/tempo.ts:226`).
pub fn tempo_at(
    tempo: serde_json::Value,
    settings: serde_json::Value,
    time: f64,
) -> Result<serde_json::Value, String> {
    let tempo: Tempo = arg(tempo)?;
    let settings: PlanningSettings = arg(settings)?;
    Ok(crate::js::number(tempo::tempo_at(&tempo, &settings, time)))
}
