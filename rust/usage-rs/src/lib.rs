//! JS bindings for `shared/usage.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `freshUsage`.
#[napi(js_name = "freshUsage")]
pub fn fresh_usage(u: String, now: String) -> napi::Result<bool> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let now = crate::js::from_json(&now)?;
        let out = port::fresh_usage(u, now)?;
        Ok(out)
    })
}

/// `lastKnownUsage`.
#[napi(js_name = "lastKnownUsage")]
pub fn last_known_usage(u: String, now: String) -> napi::Result<bool> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let now = crate::js::from_json(&now)?;
        let out = port::last_known_usage(u, now)?;
        Ok(out)
    })
}

/// `windowHolds`.
#[napi(js_name = "windowHolds")]
pub fn window_holds(window: String, now: String) -> napi::Result<bool> {
    run(move || {
        let window = crate::js::from_json(&window)?;
        let now = crate::js::from_json(&now)?;
        let out = port::window_holds(window, now)?;
        Ok(out)
    })
}

/// `sourceExhausted`.
#[napi(js_name = "sourceExhausted")]
pub fn source_exhausted(usage: String, now: f64) -> napi::Result<String> {
    run(move || {
        let usage = crate::js::from_json(&usage)?;
        let out = port::source_exhausted(usage, now)?;
        crate::js::to_json(&out)
    })
}

/// `remaining`.
#[napi(js_name = "remaining")]
pub fn remaining(window: String) -> napi::Result<String> {
    run(move || {
        let window = crate::js::from_json(&window)?;
        let out = port::remaining(window)?;
        crate::js::to_json(&out)
    })
}

/// `suggestedAccount`.
#[napi(js_name = "suggestedAccount")]
pub fn suggested_account(
    active: String,
    accounts: String,
    usage: String,
    settings: String,
    now: String,
    rate: Option<f64>,
) -> napi::Result<String> {
    run(move || {
        let active = crate::js::from_json(&active)?;
        let accounts = crate::js::from_json(&accounts)?;
        let usage = crate::js::from_json(&usage)?;
        let settings = crate::js::from_json(&settings)?;
        let now = crate::js::from_json(&now)?;
        let out = port::suggested_account(active, accounts, usage, settings, now, rate)?;
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

/// `freshUsage` over the binary wire.
#[napi(js_name = "freshUsageWire")]
pub fn fresh_usage_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::fresh_usage(u, now)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// `lastKnownUsage` over the binary wire.
#[napi(js_name = "lastKnownUsageWire")]
pub fn last_known_usage_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::last_known_usage(u, now)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

/// `windowHolds` over the binary wire.
#[napi(js_name = "windowHoldsWire")]
pub fn window_holds_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let window: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::window_holds(window, now)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_SOURCE_EXHAUSTED_OUT: wire::Schema = wire::Schema::Dyn;

/// `sourceExhausted` over the binary wire.
#[napi(js_name = "sourceExhaustedWire")]
pub fn source_exhausted_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::source_exhausted(usage, now)?;
        wire::write_value(w, out, &S_SOURCE_EXHAUSTED_OUT)?;
        Ok(())
    })
}

static S_REMAINING_OUT: wire::Schema = wire::Schema::Dyn;

/// `remaining` over the binary wire.
#[napi(js_name = "remainingWire")]
pub fn remaining_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let window: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::remaining(window)?;
        wire::write_value(w, out, &S_REMAINING_OUT)?;
        Ok(())
    })
}

static S_SUGGESTED_ACCOUNT_1: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("id", wire::Schema::Str16),
    ("name", wire::Schema::Str16),
    ("kind", wire::Schema::Str16),
    ("group", wire::Schema::Str16),
    ("color", wire::Schema::Str16),
    ("createdAt", wire::Schema::Str16),
    ("provider", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("cooldownUntil", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "planning",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("plan", wire::Schema::Str16),
            ("capacityWeight", wire::Schema::Num),
        ])),
    ),
    ("switchAtPercent", wire::Schema::OptJs(&wire::Schema::Num)),
    (
        "desktop",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("accountUuid", wire::Schema::Str16),
            ("orgId", wire::Schema::Str16),
            ("savedAt", wire::Schema::Str16),
            ("email", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("rejectedAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "auth",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("loggedIn", wire::Schema::Bool),
            ("email", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("accountUuid", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("orgId", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("orgName", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("subscription", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("plan", wire::Schema::Dyn),
            ("checkedAt", wire::Schema::Str16),
            ("error", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
]));
static S_SUGGESTED_ACCOUNT_2: wire::Schema = wire::Schema::Dyn;
static S_SUGGESTED_ACCOUNT_3: wire::Schema = wire::Schema::Dyn;
static S_SUGGESTED_ACCOUNT_OUT: wire::Schema = wire::Schema::Dyn;

/// `suggestedAccount` over the binary wire.
#[napi(js_name = "suggestedAccountWire")]
pub fn suggested_account_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let active: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let accounts: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_SUGGESTED_ACCOUNT_1.inner()))?;
        let usage: serde_json::Value = wire::read_value(r, &S_SUGGESTED_ACCOUNT_2)?;
        let settings: serde_json::Value = wire::read_value(r, &S_SUGGESTED_ACCOUNT_3)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let rate: Option<f64> = r.opt_js(|r| r.f64())?;
        let out = &port::suggested_account(active, accounts, usage, settings, now, rate)?;
        wire::write_value(w, out, &S_SUGGESTED_ACCOUNT_OUT)?;
        Ok(())
    })
}
