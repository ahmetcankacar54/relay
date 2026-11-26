//! Port of `shared/quota-windows.ts`: the limit windows a provider reported and the figure each
//! account shows.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::types::js::{date_parse, ser_num};
use super::types::{AccountUsage, LimitSource, ModelWindow, ModelWindowPeriod, UsageWindow};

/// Quota windows the provider reported: the five hours, then the week when there is one. The
/// five-hour window is required before an account can be judged; model windows are left out.
pub fn quota_windows(u: Option<&AccountUsage>) -> Option<Vec<&UsageWindow>> {
    let u = u?;
    let five = u.five_hour.as_ref()?;
    Some(match &u.seven_day {
        Some(week) => vec![five, week],
        None => vec![five],
    })
}

/// Highest utilization across the reported windows (the binding limit).
pub fn max_used_percent(u: Option<&AccountUsage>) -> Option<f64> {
    quota_windows(u).map(|windows| super::types::js::max(windows.iter().map(|w| w.used_percent)))
}

/// The model windows used up and not yet reset (Fable's week, an Antigravity model).
pub fn spent_model_windows(u: Option<&AccountUsage>, now: f64) -> Vec<&ModelWindow> {
    model_windows(u)
        .iter()
        .filter(|w| {
            w.used_percent >= 100.0
                && w.resets_at
                    .as_deref()
                    .is_none_or(|r| r.is_empty() || date_parse(r) > now)
        })
        .collect()
}

fn model_windows(u: Option<&AccountUsage>) -> &[ModelWindow] {
    u.and_then(|u| u.model_windows.as_deref()).unwrap_or(&[])
}

/// Usage made only of model limits (Antigravity).
pub fn model_only_usage(u: Option<&AccountUsage>) -> bool {
    let models = model_windows(u);
    !models.is_empty() && models.iter().all(|w| w.key.starts_with("antigravity_"))
}

/// How full a window is now: one whose reset has passed is empty again.
pub fn used_at(used_percent: f64, resets_at: Option<&str>, now: f64) -> f64 {
    let reset = resets_at
        .filter(|r| !r.is_empty())
        .map_or(f64::NAN, date_parse);
    if reset.is_finite() && reset <= now {
        0.0
    } else {
        used_percent
    }
}

/// The limit an account's figure shows: the one that stops it first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitHeadline {
    /// "five_hour", "seven_day", or a model window's key.
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(serialize_with = "ser_num")]
    pub used_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<String>,
    /// A model's own limit: only requests for that model stop when it is spent.
    pub model: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<LimitSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

fn empty_to_none(value: &Option<String>) -> Option<String> {
    value.clone().filter(|v| !v.is_empty())
}

fn window_headline(key: &str, w: &UsageWindow, now: f64) -> LimitHeadline {
    LimitHeadline {
        key: key.into(),
        label: None,
        used_percent: used_at(w.used_percent, w.resets_at.as_deref(), now),
        resets_at: w.resets_at.clone(),
        model: false,
        source: w.source,
        read_at: empty_to_none(&w.read_at),
    }
}

/// The limit that stops the account first, as its one figure: the fuller of the five-hour and
/// weekly windows (the five hours on a tie), or for model-only usage the fullest model.
pub fn limit_headline(u: Option<&AccountUsage>, now: f64) -> Option<LimitHeadline> {
    let mut candidates: Vec<LimitHeadline> = if model_only_usage(u) {
        model_windows(u)
            .iter()
            .map(|w| LimitHeadline {
                key: w.key.clone(),
                label: Some(w.label.clone()),
                used_percent: used_at(w.used_percent, w.resets_at.as_deref(), now),
                resets_at: w.resets_at.clone(),
                model: true,
                source: w.source,
                read_at: empty_to_none(&w.read_at),
            })
            .collect()
    } else {
        let u = u?;
        let mut list = Vec::new();
        if let Some(w) = &u.five_hour {
            list.push(window_headline("five_hour", w, now));
        }
        if let Some(w) = &u.seven_day {
            list.push(window_headline("seven_day", w, now));
        }
        list
    };
    let reset_ms = |h: &LimitHeadline| {
        let ms = date_parse(h.resets_at.as_deref().unwrap_or(""));
        if ms.is_finite() { ms } else { f64::INFINITY }
    };
    super::types::js::sort_by(&mut candidates, |a, b| {
        let by_used = b.used_percent - a.used_percent;
        if by_used != 0.0 && !by_used.is_nan() {
            by_used
        } else {
            reset_ms(a) - reset_ms(b)
        }
    });
    candidates.into_iter().next()
}

/// The fullest model window of each length (Antigravity pools as five hours and a week), keyed
/// `five_hour`/`seven_day` in the order the windows first name them, as the TS record is.
pub type FullestByPeriod = IndexMap<ModelWindowPeriod, LimitHeadline>;

/// The fullest model window of each length; windows of unknown length are left out.
pub fn fullest_by_period(u: Option<&AccountUsage>, now: f64) -> FullestByPeriod {
    let mut out = FullestByPeriod::new();
    for w in model_windows(u) {
        let Some(period) = w.period else { continue };
        let used = used_at(w.used_percent, w.resets_at.as_deref(), now);
        if out.get(&period).is_none_or(|seen| used > seen.used_percent) {
            out.insert(
                period,
                LimitHeadline {
                    key: w.key.clone(),
                    label: Some(w.label.clone()),
                    used_percent: used,
                    resets_at: empty_to_none(&w.resets_at),
                    model: true,
                    source: w.source,
                    read_at: empty_to_none(&w.read_at),
                },
            );
        }
    }
    out
}

/// A window as a list column shows it: the account's own window, or for pooled usage the pool's
/// headline (with its name), each written as the TS object it is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ColumnWindow {
    Pool(LimitHeadline),
    Window(UsageWindow),
}

impl ColumnWindow {
    pub fn used_percent(&self) -> f64 {
        match self {
            ColumnWindow::Pool(h) => h.used_percent,
            ColumnWindow::Window(w) => w.used_percent,
        }
    }
    pub fn resets_at(&self) -> Option<&str> {
        match self {
            ColumnWindow::Pool(h) => h.resets_at.as_deref(),
            ColumnWindow::Window(w) => w.resets_at.as_deref(),
        }
    }
    /// The pool's name; an account's own window has none.
    pub fn label(&self) -> Option<&str> {
        match self {
            ColumnWindow::Pool(h) => h.label.as_deref(),
            ColumnWindow::Window(_) => None,
        }
    }
    pub fn source(&self) -> Option<LimitSource> {
        match self {
            ColumnWindow::Pool(h) => h.source,
            ColumnWindow::Window(w) => w.source,
        }
    }
    pub fn read_at(&self) -> Option<&str> {
        match self {
            ColumnWindow::Pool(h) => h.read_at.as_deref(),
            ColumnWindow::Window(w) => w.read_at.as_deref(),
        }
    }
}

/// An account's two list columns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LimitColumns {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five: Option<ColumnWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<ColumnWindow>,
    pub pooled: bool,
}

/// An account's two list columns, its five hours and its week; for pooled usage each column is
/// its fullest pool of that length, and pools of unknown length fill the first with the fullest.
pub fn limit_columns(u: Option<&AccountUsage>, now: f64) -> LimitColumns {
    if !model_only_usage(u) {
        return LimitColumns {
            five: u
                .and_then(|u| u.five_hour.clone())
                .map(ColumnWindow::Window),
            week: u
                .and_then(|u| u.seven_day.clone())
                .map(ColumnWindow::Window),
            pooled: false,
        };
    }
    let mut by_period = fullest_by_period(u, now);
    let week = by_period.shift_remove(&ModelWindowPeriod::SevenDay);
    let five = match by_period.shift_remove(&ModelWindowPeriod::FiveHour) {
        Some(h) => Some(h),
        None if week.is_some() => None,
        None => limit_headline(u, now),
    };
    LimitColumns {
        five: five.map(ColumnWindow::Pool),
        week: week.map(ColumnWindow::Pool),
        pooled: true,
    }
}

/// Where a shown limit figure came from and when it was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitOrigin {
    pub source: LimitSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
}

/// Where a limit row's figure came from, for its tooltip: a passed reset is Relay's estimate;
/// an untagged window takes its source from the account's sign-in.
pub fn limit_origin(
    window: Option<&UsageWindow>,
    usage: Option<&AccountUsage>,
    now: f64,
) -> Option<LimitOrigin> {
    let window = window?;
    let read_at = window
        .read_at
        .clone()
        .or_else(|| usage.and_then(|u| u.checked_at.clone()));
    let reset = date_parse(window.resets_at.as_deref().unwrap_or(""));
    let source = if reset.is_finite() && reset <= now {
        Some(LimitSource::Estimate)
    } else {
        window.source.or(match usage.and_then(|u| u.source) {
            Some(super::types::UsageSource::Desktop) => Some(LimitSource::AppSession),
            Some(super::types::UsageSource::Cli) => Some(LimitSource::Official),
            None => None,
        })
    }?;
    Some(LimitOrigin {
        source,
        read_at: read_at.filter(|r| !r.is_empty()),
    })
}
