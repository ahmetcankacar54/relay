//! Port of `electron/core/tempo-tracker.ts`: the learned tempo, recomputed once per local day or
//! when what it depends on changes.

use std::sync::Mutex;

use serde_json::json;

use crate::shared::planning::{local_date, plan_capacity};
use crate::shared::tempo::{LearnTempoInput, Tempo, fallback_tempo, learn_tempo, tempo_at};
use crate::shared::types::{Account, PlanningSettings, TempoChoice};
use crate::shared::usage_rollups::UsageRollups;
use crate::shared::usage_statistics::history_identity;

/// Where the tracker reads its inputs.
pub trait TempoSource: Send + Sync {
    /// Whether the rollups can be read (usageHistory.rollupsAvailable).
    fn available(&self) -> bool;
    /// Called only when recomputing: reading the rollups clones them. An error is a rollup
    /// file that cannot be read.
    fn rollups(&self) -> Result<Option<UsageRollups>, String>;
    fn accounts(&self) -> Vec<Account>;
    fn settings(&self) -> PlanningSettings;
    fn now(&self) -> f64 {
        crate::clock::now_ms() as f64
    }
}

/// Learns the tempo once per local day, or again when what it depends on changes.
pub struct TempoTracker<S: TempoSource> {
    source: S,
    cached: Mutex<Option<(String, Tempo)>>,
}

impl<S: TempoSource> TempoTracker<S> {
    pub fn new(source: S) -> Self {
        TempoTracker {
            source,
            cached: Mutex::new(None),
        }
    }

    pub fn source(&self) -> &S {
        &self.source
    }

    pub fn current(&self) -> Result<Tempo, String> {
        let now = self.source.now();
        let settings = self.source.settings();
        let accounts = self.source.accounts();
        let available = self.source.available();
        let key = json!([
            local_date(now, &settings.time_zone),
            settings.tempo.unwrap_or(TempoChoice::Auto),
            settings.time_zone,
            settings.weekday,
            settings.weekend,
            available,
            accounts
                .iter()
                .map(|a| json!([
                    history_identity(a).unwrap_or_default(),
                    a.auth.as_ref().is_some_and(|auth| auth.logged_in),
                    plan_capacity(a),
                ]))
                .collect::<Vec<_>>(),
        ])
        .to_string();
        let mut cached = self.cached.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((known, value)) = cached.as_ref()
            && *known == key
        {
            return Ok(value.clone());
        }
        let rollups = if available {
            self.source.rollups()?
        } else {
            None
        };
        let value = learn_tempo(LearnTempoInput {
            rollups: rollups.as_ref(),
            accounts: &accounts,
            settings: &settings,
            now,
        });
        *cached = Some((key, value.clone()));
        Ok(value)
    }

    /// The current tempo; when learning it fails, the settings' fallback (the keeper still
    /// plans).
    pub fn current_or_fallback(&self) -> Tempo {
        self.current()
            .unwrap_or_else(|_| fallback_tempo(&self.source.settings()))
    }

    /// Pro units per hour at `time` (default now) under the current tempo.
    pub fn rate_at(&self, time: Option<f64>) -> Result<f64, String> {
        let time = time.unwrap_or_else(|| self.source.now());
        Ok(tempo_at(&self.current()?, &self.source.settings(), time))
    }
}
