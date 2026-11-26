//! JS bindings for `shared/tray.ts`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;
pub mod utf16;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!(
            "Rust panic: {}",
            panic_message(&*payload)
        ))),
    }
}

/// `trayAccountName`.
#[napi(js_name = "trayAccountName")]
pub fn tray_account_name(name: String) -> napi::Result<String> {
    run(move || {
        let out = port::tray_account_name(name)?;
        crate::js::to_json(&out)
    })
}

/// `trayUsageLabel`.
#[napi(js_name = "trayUsageLabel")]
pub fn tray_usage_label(
    account_id: String,
    usage: String,
    language: String,
    now: String,
) -> napi::Result<String> {
    run(move || {
        let usage = crate::js::from_json(&usage)?;
        let language = crate::js::from_json(&language)?;
        let now = crate::js::from_json(&now)?;
        let out = port::tray_usage_label(account_id, usage, language, now)?;
        crate::js::to_json(&out)
    })
}

/// `canRequestTraySwitch`.
#[napi(js_name = "canRequestTraySwitch")]
pub fn can_request_tray_switch(snapshot: String, profile_id: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let out = port::can_request_tray_switch(snapshot, profile_id)?;
        crate::js::to_json(&out)
    })
}

/// `unavailableTrayMenu`.
#[napi(js_name = "unavailableTrayMenu")]
pub fn unavailable_tray_menu(language: String) -> napi::Result<String> {
    run(move || {
        let language = crate::js::from_json(&language)?;
        let out = port::unavailable_tray_menu(language)?;
        crate::js::to_json(&out)
    })
}

/// `buildTrayMenu`.
#[napi(js_name = "buildTrayMenu")]
pub fn build_tray_menu(snapshot: String, language: String, now: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let language = crate::js::from_json(&language)?;
        let now = crate::js::from_json(&now)?;
        let out = port::build_tray_menu(snapshot, language, now)?;
        crate::js::to_json(&out)
    })
}

/// `menuBarItems`.
#[napi(js_name = "menuBarItems")]
pub fn menu_bar_items(value: String) -> napi::Result<Vec<String>> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::menu_bar_items(value)?;
        Ok(out)
    })
}

/// `trayTokens`.
#[napi(js_name = "trayTokens")]
pub fn tray_tokens(tokens: f64, language: String) -> napi::Result<String> {
    run(move || {
        let language = crate::js::from_json(&language)?;
        let out = port::tray_tokens(tokens, language)?;
        crate::js::to_json(&out)
    })
}

/// `trayCost`.
#[napi(js_name = "trayCost")]
pub fn tray_cost(cost: f64, language: String, estimated: Option<bool>) -> napi::Result<String> {
    run(move || {
        let language = crate::js::from_json(&language)?;
        let out = port::tray_cost(cost, language, estimated)?;
        crate::js::to_json(&out)
    })
}

/// `trayShortName`.
#[napi(js_name = "trayShortName")]
pub fn tray_short_name(name: String, max: String) -> napi::Result<String> {
    run(move || {
        let max = crate::js::from_json(&max)?;
        let out = port::tray_short_name(name, max)?;
        crate::js::to_json(&out)
    })
}

/// `trayResetClock`.
#[napi(js_name = "trayResetClock")]
pub fn tray_reset_clock(
    resets_at: Option<String>,
    now: f64,
    language: String,
    time_zone: Option<String>,
) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let language = crate::js::from_json(&language)?;
        let out = port::tray_reset_clock(resets_at, now, language, time_zone)?;
        Ok(out.map_or(
            napi::bindgen_prelude::Either::B(()),
            napi::bindgen_prelude::Either::A,
        ))
    })
}

/// `trayCountdown`.
#[napi(js_name = "trayCountdown")]
pub fn tray_countdown(resets_at: Option<String>, now: f64) -> napi::Result<String> {
    run(move || {
        let out = port::tray_countdown(resets_at, now)?;
        crate::js::to_json(&out)
    })
}

/// `trayTooltip`.
#[napi(js_name = "trayTooltip")]
pub fn tray_tooltip(snapshot: String, language: String, now: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let language = crate::js::from_json(&language)?;
        let now = crate::js::from_json(&now)?;
        let out = port::tray_tooltip(snapshot, language, now)?;
        crate::js::to_json(&out)
    })
}

/// `trayTitle`.
#[napi(js_name = "trayTitle")]
pub fn tray_title(snapshot: String, now: String, language: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let now = crate::js::from_json(&now)?;
        let language = crate::js::from_json(&language)?;
        let out = port::tray_title(snapshot, now, language)?;
        crate::js::to_json(&out)
    })
}

/// `menuBarPreview`.
#[napi(js_name = "menuBarPreview")]
pub fn menu_bar_preview(
    items: Vec<String>,
    language: String,
    name: Option<String>,
    now: String,
) -> napi::Result<String> {
    run(move || {
        let language = crate::js::from_json(&language)?;
        let now = crate::js::from_json(&now)?;
        let out = port::menu_bar_preview(items, language, name, now)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

type WireBuffers = (
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint32Array,
);

thread_local! {
    static WIRE: std::cell::RefCell<Option<WireBuffers>> = const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument, result and argument-length buffers `index.cjs` uses.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(
    input: napi::bindgen_prelude::Uint8Array,
    output: napi::bindgen_prelude::Uint8Array,
    len: napi::bindgen_prelude::Uint32Array,
) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output, len)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output, _)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads the argument bytes (`wLen[0]` of them), runs `f`, and writes its result; a negative
/// return is the size of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(
    f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>,
) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output, len)) = guard.as_mut() else {
            return Err(napi::Error::from_reason(
                "rust-anything: the wire buffers are not registered",
            ));
        };
        let len = (len.first().copied().unwrap_or(0) as usize).min(input.len());
        let mut w = wire::Writer(SCRATCH.with(|s| std::mem::take(&mut *s.borrow_mut())));
        w.0.clear();
        let result = run(|| f(&mut wire::Reader::new(&input[..len]), &mut w));
        let keep = |w: wire::Writer| SCRATCH.with(|s| *s.borrow_mut() = w.0);
        match result {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => {
                keep(w);
                return Ok(f64::NAN);
            }
            Err(e) => {
                keep(w);
                let mut m = wire::Writer::default();
                m.string16(&e.reason);
                // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
                let out = unsafe { output.as_mut() };
                if m.0.len() > out.len() {
                    return Err(e);
                }
                out[..m.0.len()].copy_from_slice(&m.0);
                return Ok(f64::INFINITY);
            }
            Ok(()) => {}
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        keep(w);
        Ok(n as f64)
    })
}

static S_TRAY_ACCOUNT_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayAccountName` over the binary wire.
#[napi(js_name = "trayAccountNameWire")]
pub fn tray_account_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: String = r.string16()?;
        let out = &port::tray_account_name(name)?;
        wire::write_value(w, out, &S_TRAY_ACCOUNT_NAME_OUT)?;
        Ok(())
    })
}

static S_TRAY_USAGE_LABEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayUsageLabel` over the binary wire.
#[napi(js_name = "trayUsageLabelWire")]
pub fn tray_usage_label_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account_id: String = r.string16()?;
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::tray_usage_label(account_id, usage, language, now)?;
        wire::write_value(w, out, &S_TRAY_USAGE_LABEL_OUT)?;
        Ok(())
    })
}

static S_CAN_REQUEST_TRAY_SWITCH_0: wire::Schema = wire::Schema::Dyn;
static S_CAN_REQUEST_TRAY_SWITCH_OUT: wire::Schema = wire::Schema::Dyn;

/// `canRequestTraySwitch` over the binary wire.
#[napi(js_name = "canRequestTraySwitchWire")]
pub fn can_request_tray_switch_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: serde_json::Value = wire::read_value(r, &S_CAN_REQUEST_TRAY_SWITCH_0)?;
        let profile_id: String = r.string16()?;
        let out = &port::can_request_tray_switch(snapshot, profile_id)?;
        wire::write_value(w, out, &S_CAN_REQUEST_TRAY_SWITCH_OUT)?;
        Ok(())
    })
}

static S_UNAVAILABLE_TRAY_MENU_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `unavailableTrayMenu` over the binary wire.
#[napi(js_name = "unavailableTrayMenuWire")]
pub fn unavailable_tray_menu_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::unavailable_tray_menu(language)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_UNAVAILABLE_TRAY_MENU_OUT.inner())?;
        }
        Ok(())
    })
}

static S_BUILD_TRAY_MENU_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_TRAY_MENU_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `buildTrayMenu` over the binary wire.
#[napi(js_name = "buildTrayMenuWire")]
pub fn build_tray_menu_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: serde_json::Value = wire::read_value(r, &S_BUILD_TRAY_MENU_0)?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::build_tray_menu(snapshot, language, now)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_BUILD_TRAY_MENU_OUT.inner())?;
        }
        Ok(())
    })
}

static S_MENU_BAR_ITEMS_0: wire::Schema = wire::Schema::Dyn;

/// `menuBarItems` over the binary wire.
#[napi(js_name = "menuBarItemsWire")]
pub fn menu_bar_items_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_MENU_BAR_ITEMS_0)?;
        let out = &port::menu_bar_items(value)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.string16(x0);
        }
        Ok(())
    })
}

static S_TRAY_TOKENS_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayTokens` over the binary wire.
#[napi(js_name = "trayTokensWire")]
pub fn tray_tokens_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tokens: f64 = r.f64()?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::tray_tokens(tokens, language)?;
        wire::write_value(w, out, &S_TRAY_TOKENS_OUT)?;
        Ok(())
    })
}

static S_TRAY_COST_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayCost` over the binary wire.
#[napi(js_name = "trayCostWire")]
pub fn tray_cost_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let cost: f64 = r.f64()?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let estimated: Option<bool> = r.opt_js(|r| r.bool())?;
        let out = &port::tray_cost(cost, language, estimated)?;
        wire::write_value(w, out, &S_TRAY_COST_OUT)?;
        Ok(())
    })
}

static S_TRAY_SHORT_NAME_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayShortName` over the binary wire.
#[napi(js_name = "trayShortNameWire")]
pub fn tray_short_name_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let name: String = r.string16()?;
        let max: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::tray_short_name(name, max)?;
        wire::write_value(w, out, &S_TRAY_SHORT_NAME_OUT)?;
        Ok(())
    })
}

/// `trayResetClock` over the binary wire.
#[napi(js_name = "trayResetClockWire")]
pub fn tray_reset_clock_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let resets_at: Option<String> = r.opt_js(|r| r.string16())?;
        let now: f64 = r.f64()?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let time_zone: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::tray_reset_clock(resets_at, now, language, time_zone)?;
        match out {
            Some(x0) => {
                w.tag(1);
                w.string16(x0);
            }
            None => w.tag(0),
        }
        Ok(())
    })
}

static S_TRAY_COUNTDOWN_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayCountdown` over the binary wire.
#[napi(js_name = "trayCountdownWire")]
pub fn tray_countdown_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let resets_at: Option<String> = r.opt_js(|r| r.string16())?;
        let now: f64 = r.f64()?;
        let out = &port::tray_countdown(resets_at, now)?;
        wire::write_value(w, out, &S_TRAY_COUNTDOWN_OUT)?;
        Ok(())
    })
}

static S_TRAY_TOOLTIP_0: wire::Schema = wire::Schema::Dyn;
static S_TRAY_TOOLTIP_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayTooltip` over the binary wire.
#[napi(js_name = "trayTooltipWire")]
pub fn tray_tooltip_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: serde_json::Value = wire::read_value(r, &S_TRAY_TOOLTIP_0)?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::tray_tooltip(snapshot, language, now)?;
        wire::write_value(w, out, &S_TRAY_TOOLTIP_OUT)?;
        Ok(())
    })
}

static S_TRAY_TITLE_0: wire::Schema = wire::Schema::Dyn;
static S_TRAY_TITLE_OUT: wire::Schema = wire::Schema::Dyn;

/// `trayTitle` over the binary wire.
#[napi(js_name = "trayTitleWire")]
pub fn tray_title_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: serde_json::Value = wire::read_value(r, &S_TRAY_TITLE_0)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::tray_title(snapshot, now, language)?;
        wire::write_value(w, out, &S_TRAY_TITLE_OUT)?;
        Ok(())
    })
}

static S_MENU_BAR_PREVIEW_OUT: wire::Schema = wire::Schema::Dyn;

/// `menuBarPreview` over the binary wire.
#[napi(js_name = "menuBarPreviewWire")]
pub fn menu_bar_preview_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let items: Vec<String> = r.list(|r| r.string16())?;
        let language: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let name: Option<String> = r.opt_js(|r| r.string16())?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::menu_bar_preview(items, language, name, now)?;
        wire::write_value(w, out, &S_MENU_BAR_PREVIEW_OUT)?;
        Ok(())
    })
}
