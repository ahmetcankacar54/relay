//! JS bindings for `shared/quota-windows.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `quotaWindows`.
#[napi(js_name = "quotaWindows")]
pub fn quota_windows(u: String) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::quota_windows(u)?;
        crate::js::to_json(&out)
    })
}

/// `maxUsedPercent`.
#[napi(js_name = "maxUsedPercent")]
pub fn max_used_percent(u: String) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::max_used_percent(u)?;
        crate::js::to_json(&out)
    })
}

/// `spentModelWindows`.
#[napi(js_name = "spentModelWindows")]
pub fn spent_model_windows(u: String, now: f64) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::spent_model_windows(u, now)?;
        crate::js::to_json(&out)
    })
}

/// `modelOnlyUsage`.
#[napi(js_name = "modelOnlyUsage")]
pub fn model_only_usage(u: String) -> napi::Result<bool> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::model_only_usage(u)?;
        Ok(out)
    })
}

/// `usedAt`.
#[napi(js_name = "usedAt")]
pub fn used_at(window: String, now: f64) -> napi::Result<f64> {
    run(move || {
        let window = crate::js::from_json(&window)?;
        let out = port::used_at(window, now)?;
        Ok(out)
    })
}

/// `limitHeadline`.
#[napi(js_name = "limitHeadline")]
pub fn limit_headline(u: String, now: f64) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::limit_headline(u, now)?;
        crate::js::to_json(&out)
    })
}

/// `fullestByPeriod`.
#[napi(js_name = "fullestByPeriod")]
pub fn fullest_by_period(u: String, now: f64) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::fullest_by_period(u, now)?;
        crate::js::to_json(&out)
    })
}

/// `limitColumns`.
#[napi(js_name = "limitColumns")]
pub fn limit_columns(u: String, now: f64) -> napi::Result<String> {
    run(move || {
        let u = crate::js::from_json(&u)?;
        let out = port::limit_columns(u, now)?;
        crate::js::to_json(&out)
    })
}

/// `limitOrigin`.
#[napi(js_name = "limitOrigin")]
pub fn limit_origin(window: String, usage: String, now: f64) -> napi::Result<String> {
    run(move || {
        let window = crate::js::from_json(&window)?;
        let usage = crate::js::from_json(&usage)?;
        let out = port::limit_origin(window, usage, now)?;
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

static S_QUOTA_WINDOWS_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Obj(&[
        ("usedPercent", wire::Schema::Num),
        ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
        ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ])));

/// `quotaWindows` over the binary wire.
#[napi(js_name = "quotaWindowsWire")]
pub fn quota_windows_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::quota_windows(u)?;
        wire::write_value(w, out, &S_QUOTA_WINDOWS_OUT)?;
        Ok(())
    })
}

static S_MAX_USED_PERCENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `maxUsedPercent` over the binary wire.
#[napi(js_name = "maxUsedPercentWire")]
pub fn max_used_percent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::max_used_percent(u)?;
        wire::write_value(w, out, &S_MAX_USED_PERCENT_OUT)?;
        Ok(())
    })
}

static S_SPENT_MODEL_WINDOWS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("key", wire::Schema::Str16),
    ("label", wire::Schema::Str16),
    ("usedPercent", wire::Schema::Num),
    ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("model", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("weeklyShare", wire::Schema::OptJs(&wire::Schema::Num)),
    ("period", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `spentModelWindows` over the binary wire.
#[napi(js_name = "spentModelWindowsWire")]
pub fn spent_model_windows_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::spent_model_windows(u, now)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_SPENT_MODEL_WINDOWS_OUT.inner())?;
        }
        Ok(())
    })
}

/// `modelOnlyUsage` over the binary wire.
#[napi(js_name = "modelOnlyUsageWire")]
pub fn model_only_usage_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::model_only_usage(u)?;
        w.bool(*out);
        Ok(())
    })
}

static S_USED_AT_0: wire::Schema = wire::Schema::Dyn;

/// `usedAt` over the binary wire.
#[napi(js_name = "usedAtWire")]
pub fn used_at_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let window: Value = wire::read_value(r, &S_USED_AT_0)?;
        let now: f64 = r.f64()?;
        let out = &port::used_at(window, now)?;
        w.f64(*out);
        Ok(())
    })
}

static S_LIMIT_HEADLINE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("key", wire::Schema::Str16),
    ("label", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("usedPercent", wire::Schema::Num),
    ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("model", wire::Schema::Bool),
    ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `limitHeadline` over the binary wire.
#[napi(js_name = "limitHeadlineWire")]
pub fn limit_headline_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::limit_headline(u, now)?;
        wire::write_value(w, out, &S_LIMIT_HEADLINE_OUT)?;
        Ok(())
    })
}

static S_FULLEST_BY_PERIOD_OUT: wire::Schema = wire::Schema::Dyn;

/// `fullestByPeriod` over the binary wire.
#[napi(js_name = "fullestByPeriodWire")]
pub fn fullest_by_period_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::fullest_by_period(u, now)?;
        wire::write_value(w, out, &S_FULLEST_BY_PERIOD_OUT)?;
        Ok(())
    })
}

static S_LIMIT_COLUMNS_OUT: wire::Schema = wire::Schema::Obj(&[
    (
        "five",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("label", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "week",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("label", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    ("pooled", wire::Schema::Bool),
]);

/// `limitColumns` over the binary wire.
#[napi(js_name = "limitColumnsWire")]
pub fn limit_columns_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let u: Option<Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::limit_columns(u, now)?;
        wire::write_value(w, out, &S_LIMIT_COLUMNS_OUT)?;
        Ok(())
    })
}

static S_LIMIT_ORIGIN_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("source", wire::Schema::Str16),
    ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
]));

/// `limitOrigin` over the binary wire.
#[napi(js_name = "limitOriginWire")]
pub fn limit_origin_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let window: Option<Value> = wire::read_dyn_opt(r)?;
        let usage: Option<Value> = wire::read_dyn_opt(r)?;
        let now: f64 = r.f64()?;
        let out = &port::limit_origin(window, usage, now)?;
        wire::write_value(w, out, &S_LIMIT_ORIGIN_OUT)?;
        Ok(())
    })
}
