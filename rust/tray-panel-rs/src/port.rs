//! The Rust port of `shared/tray-panel.ts`, delegating to `relay_core::shared::tray_panel`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns.

#![forbid(unsafe_code)]

mod args;

use relay_core::shared::tray_panel::{
    self as panel, PanelBlur, PanelHealth, PanelLoadEvent, PanelLoadState, PendingOpen, Point,
    Rect, Size,
};
use serde::Serialize;
use serde_json::Value;

use args::{arg, opt_arg};

fn out(value: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

/// Port of `panelPosition` (`shared/tray-panel.ts:6`).
pub fn panel_position(
    tray: serde_json::Value,
    work_area: serde_json::Value,
    size: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let tray: Rect = arg(tray)?;
    let work_area: Rect = arg(work_area)?;
    let size: Size = arg(size)?;
    let Point { x, y } = panel::panel_position(tray, work_area, size);
    Ok(serde_json::json!({ "x": crate::js::number(x), "y": crate::js::number(y) }))
}

/// Port of `clampPanelHeight` (`shared/tray-panel.ts:13`).
pub fn clamp_panel_height(height: f64, work_area_height: f64) -> Result<serde_json::Value, String> {
    Ok(crate::js::number(panel::clamp_panel_height(
        height,
        work_area_height,
    )))
}

/// Port of `pointerOnTray` (`shared/tray-panel.ts:37`), with the TS default slack of 4.
pub fn pointer_on_tray(
    tray: Option<serde_json::Value>,
    point: serde_json::Value,
    slack: Option<f64>,
) -> Result<serde_json::Value, String> {
    let tray: Option<Rect> = opt_arg(tray)?;
    let point: Point = arg(point)?;
    Ok(Value::Bool(panel::pointer_on_tray(
        tray.as_ref(),
        point,
        slack.unwrap_or(panel::POINTER_SLACK),
    )))
}

/// Port of `panelBlurAction` (`shared/tray-panel.ts:63`).
pub fn panel_blur_action(params: serde_json::Value) -> Result<String, String> {
    let params: PanelBlur = arg(params)?;
    Ok(panel::panel_blur_action(params).as_str().to_string())
}

/// Port of `panelOffSpaceAction` (`shared/tray-panel.ts:87`).
pub fn panel_off_space_action(since_rebuild: f64) -> Result<String, String> {
    Ok(panel::panel_off_space_action(since_rebuild)
        .as_str()
        .to_string())
}

/// Port of `pendingOpenDue` (`shared/tray-panel.ts:91`).
pub fn pending_open_due(
    pending: Option<serde_json::Value>,
    now: f64,
) -> Result<serde_json::Value, String> {
    let pending: Option<PendingOpen> = opt_arg(pending)?;
    Ok(Value::Bool(panel::pending_open_due(pending, now)))
}

/// Port of `trayClickAction` (`shared/tray-panel.ts:95`).
pub fn tray_click_action(panel_usable: bool) -> Result<String, String> {
    Ok(panel::tray_click_action(panel_usable).as_str().to_string())
}

/// Port of `panelLoadState` (`shared/tray-panel.ts:117`).
pub fn panel_load_state(
    prev: serde_json::Value,
    event: String,
) -> Result<serde_json::Value, String> {
    let prev: PanelLoadState = arg(prev)?;
    let event: PanelLoadEvent = arg(Value::String(event))?;
    out(panel::panel_load_state(prev, event))
}

/// Port of `panelRevival` (`shared/tray-panel.ts:145`).
pub fn panel_revival(panel: serde_json::Value) -> Result<Option<String>, String> {
    let panel: PanelHealth = arg(panel)?;
    Ok(panel::panel_revival(panel).map(|r| r.as_str().to_string()))
}

/// Port of `ToggleGuard` (`shared/tray-panel.ts:21`).
pub struct ToggleGuard {
    inner: panel::ToggleGuard,
}

impl ToggleGuard {
    pub fn new() -> Result<Self, String> {
        Ok(ToggleGuard {
            inner: panel::ToggleGuard::new(),
        })
    }

    pub fn should_open(&mut self, now: f64) -> Result<serde_json::Value, String> {
        Ok(Value::Bool(self.inner.should_open(now)))
    }

    /// `byTrayClick` defaults to false; the TS reads it as a condition, so any value counts by its
    /// truthiness.
    pub fn hidden(
        &mut self,
        now: f64,
        by_tray_click: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        self.inner
            .hidden(now, by_tray_click.as_ref().is_some_and(truthy));
        Ok(crate::js::undefined())
    }
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Object(_) => {
            !crate::js::is_undefined(value)
                && crate::js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan())
        }
        Value::Array(_) => true,
    }
}
