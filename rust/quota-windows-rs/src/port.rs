//! The Rust port of `shared/quota-windows.ts`, delegating to `relay_core::shared::quota_windows`.
//!
//! The TS functions take `Pick<AccountUsage, ...>`: only the picked fields are read here, and the
//! relay-core `AccountUsage` gets them over an otherwise empty reading.

#![forbid(unsafe_code)]

use parity_args::{arg, opt_arg};
use relay_core::shared::quota_windows::{self as qw, ColumnWindow, LimitHeadline};
use relay_core::shared::types::{
    AccountUsage, LimitSource, ModelWindow, UsageSource, UsageStatus, UsageWindow,
};
use serde::Deserialize;
use serde_json::Value;

/// The `AccountUsage` fields the module reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsagePick {
    five_hour: Option<UsageWindow>,
    seven_day: Option<UsageWindow>,
    model_windows: Option<Vec<ModelWindow>>,
    source: Option<UsageSource>,
    checked_at: Option<String>,
}

/// `Pick<UsageWindow, "resetsAt" | "source" | "readAt">`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowPick {
    resets_at: Option<String>,
    source: Option<LimitSource>,
    read_at: Option<String>,
}

fn picked(u: Option<&Value>) -> Result<Option<AccountUsage>, String> {
    Ok(opt_arg::<UsagePick>(u)?.map(|p| AccountUsage {
        five_hour: p.five_hour,
        seven_day: p.seven_day,
        model_windows: p.model_windows,
        source: p.source,
        checked_at: p.checked_at,
        ..AccountUsage::new("", UsageStatus::Idle)
    }))
}

/// A result object whose `usedPercent` crosses as a JS number (NaN included).
fn with_used(value: impl serde::Serialize, used_percent: f64) -> Result<Value, String> {
    let mut value = serde_json::to_value(value).map_err(|e| e.to_string())?;
    if let Some(o) = value.as_object_mut() {
        o.insert("usedPercent".into(), crate::js::number(used_percent));
    }
    Ok(value)
}

fn headline(h: Option<LimitHeadline>) -> Result<Value, String> {
    match h {
        Some(h) => {
            let used = h.used_percent;
            with_used(h, used)
        }
        None => Ok(crate::js::undefined()),
    }
}

fn column(c: Option<ColumnWindow>) -> Result<Value, String> {
    match c {
        Some(c) => {
            let used = c.used_percent();
            with_used(c, used)
        }
        None => Ok(crate::js::undefined()),
    }
}

/// Port of `quotaWindows` (`shared/quota-windows.ts:10`): the windows are returned as the
/// caller's own objects.
pub fn quota_windows(u: Option<Value>) -> Result<Value, String> {
    let typed = picked(u.as_ref())?;
    let Some(windows) = qw::quota_windows(typed.as_ref()) else {
        return Ok(crate::js::undefined());
    };
    let five = typed.as_ref().and_then(|t| t.five_hour.as_ref());
    let raw = |key: &str| u.as_ref().and_then(|u| u.get(key)).cloned();
    Ok(Value::Array(
        windows
            .into_iter()
            .filter_map(|w| match five {
                Some(f) if std::ptr::eq(w, f) => raw("fiveHour"),
                _ => raw("sevenDay"),
            })
            .collect(),
    ))
}

/// Port of `maxUsedPercent` (`shared/quota-windows.ts:17`).
pub fn max_used_percent(u: Option<Value>) -> Result<Value, String> {
    let typed = picked(u.as_ref())?;
    Ok(qw::max_used_percent(typed.as_ref()).map_or_else(crate::js::undefined, crate::js::number))
}

/// Port of `spentModelWindows` (`shared/quota-windows.ts:24`): the windows are returned as the
/// caller's own objects.
pub fn spent_model_windows(u: Option<Value>, now: f64) -> Result<Vec<Value>, String> {
    let typed = picked(u.as_ref())?;
    let all = typed
        .as_ref()
        .and_then(|t| t.model_windows.as_deref())
        .unwrap_or(&[]);
    let raw = u.as_ref().and_then(|u| u.get("modelWindows"));
    Ok(qw::spent_model_windows(typed.as_ref(), now)
        .into_iter()
        .filter_map(|w| all.iter().position(|a| std::ptr::eq(a, w)))
        .filter_map(|i| raw.and_then(|r| r.get(i)).cloned())
        .collect())
}

/// Port of `modelOnlyUsage` (`shared/quota-windows.ts:38`).
pub fn model_only_usage(u: Option<Value>) -> Result<bool, String> {
    Ok(qw::model_only_usage(picked(u.as_ref())?.as_ref()))
}

/// Port of `usedAt` (`shared/quota-windows.ts:44`).
pub fn used_at(window: Value, now: f64) -> Result<f64, String> {
    let window: UsageWindow = arg(&window)?;
    Ok(qw::used_at(
        window.used_percent,
        window.resets_at.as_deref(),
        now,
    ))
}

/// Port of `limitHeadline` (`shared/quota-windows.ts:76`).
pub fn limit_headline(u: Option<Value>, now: f64) -> Result<Value, String> {
    headline(qw::limit_headline(picked(u.as_ref())?.as_ref(), now))
}

/// Port of `fullestByPeriod` (`shared/quota-windows.ts:97`).
pub fn fullest_by_period(u: Option<Value>, now: f64) -> Result<Value, String> {
    let out = qw::fullest_by_period(picked(u.as_ref())?.as_ref(), now);
    let mut record = serde_json::Map::new();
    for (period, h) in out {
        record.insert(period.as_str().into(), headline(Some(h))?);
    }
    Ok(record.into())
}

/// Port of `limitColumns` (`shared/quota-windows.ts:126`).
pub fn limit_columns(u: Option<Value>, now: f64) -> Result<Value, String> {
    let out = qw::limit_columns(picked(u.as_ref())?.as_ref(), now);
    Ok(serde_json::json!({
        "five": column(out.five)?,
        "week": column(out.week)?,
        "pooled": out.pooled,
    }))
}

/// Port of `limitOrigin` (`shared/quota-windows.ts:151`).
pub fn limit_origin(
    window: Option<Value>,
    usage: Option<Value>,
    now: f64,
) -> Result<Value, String> {
    let window = opt_arg::<WindowPick>(window.as_ref())?.map(|w| UsageWindow {
        resets_at: w.resets_at,
        source: w.source,
        read_at: w.read_at,
        ..UsageWindow::default()
    });
    let typed = picked(usage.as_ref())?;
    match qw::limit_origin(window.as_ref(), typed.as_ref(), now) {
        Some(origin) => serde_json::to_value(origin).map_err(|e| e.to_string()),
        None => Ok(crate::js::undefined()),
    }
}
