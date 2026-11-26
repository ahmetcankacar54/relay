//! JS bindings for `shared/token-usage-view.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `classify`.
#[napi(js_name = "classify")]
pub fn classify(who: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::classify(who, accounts)?;
        crate::js::to_json(&out)
    })
}

/// `buildTokenUsageView`.
#[napi(js_name = "buildTokenUsageView")]
pub fn build_token_usage_view(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::build_token_usage_view(input)?;
        crate::js::to_json(&out)
    })
}

/// `buildTokenToday`.
#[napi(js_name = "buildTokenToday")]
pub fn build_token_today(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::build_token_today(input)?;
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

static S_CLASSIFY_1: wire::Schema = wire::Schema::Dyn;
static S_CLASSIFY_OUT: wire::Schema = wire::Schema::Obj(&[
    ("key", wire::Schema::Str16),
    ("kind", wire::Schema::Dyn),
    ("accountId", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("name", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("estimated", wire::Schema::Bool),
]);

/// `classify` over the binary wire.
#[napi(js_name = "classifyWire")]
pub fn classify_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let who: String = r.string16()?;
        let accounts: serde_json::Value = wire::read_value(r, &S_CLASSIFY_1)?;
        let out = &port::classify(who, accounts)?;
        wire::write_value(w, out, &S_CLASSIFY_OUT)?;
        Ok(())
    })
}

static S_BUILD_TOKEN_USAGE_VIEW_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_TOKEN_USAGE_VIEW_OUT: wire::Schema = wire::Schema::Obj(&[
    ("range", wire::Schema::Num),
    (
        "days",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("date", wire::Schema::Str16),
            ("byRow", wire::Schema::Map16(&wire::Schema::Dyn)),
        ])),
    ),
    (
        "rows",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("key", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("accountId", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("name", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("estimated", wire::Schema::Bool),
            (
                "totals",
                wire::Schema::Obj(&[
                    ("input", wire::Schema::Dyn),
                    ("output", wire::Schema::Dyn),
                    ("cacheWrite", wire::Schema::Dyn),
                    ("cacheRead", wire::Schema::Dyn),
                    ("responses", wire::Schema::Dyn),
                    ("cost", wire::Schema::Dyn),
                    ("unpriced", wire::Schema::Dyn),
                    ("costEstimated", wire::Schema::Dyn),
                ]),
            ),
        ])),
    ),
    (
        "totals",
        wire::Schema::Obj(&[
            ("input", wire::Schema::Num),
            ("output", wire::Schema::Num),
            ("cacheWrite", wire::Schema::Num),
            ("cacheRead", wire::Schema::Num),
            ("responses", wire::Schema::Num),
            ("cost", wire::Schema::OptJs(&wire::Schema::Num)),
            ("unpriced", wire::Schema::OptJs(&wire::Schema::Num)),
            ("costEstimated", wire::Schema::OptJs(&wire::Schema::Bool)),
        ]),
    ),
    (
        "models",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("model", wire::Schema::Str16),
            (
                "totals",
                wire::Schema::Obj(&[
                    ("input", wire::Schema::Num),
                    ("output", wire::Schema::Num),
                    ("cacheWrite", wire::Schema::Num),
                    ("cacheRead", wire::Schema::Num),
                    ("responses", wire::Schema::Num),
                    ("cost", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("unpriced", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("costEstimated", wire::Schema::OptJs(&wire::Schema::Bool)),
                ]),
            ),
        ])),
    ),
    (
        "progress",
        wire::Schema::Obj(&[
            ("percent", wire::Schema::Num),
            ("complete", wire::Schema::Bool),
            ("error", wire::Schema::OptJs(&wire::Schema::Bool)),
        ]),
    ),
    ("exactSince", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "today",
        wire::Schema::Obj(&[
            ("date", wire::Schema::Str16),
            (
                "totals",
                wire::Schema::Obj(&[
                    ("input", wire::Schema::Num),
                    ("output", wire::Schema::Num),
                    ("cacheWrite", wire::Schema::Num),
                    ("cacheRead", wire::Schema::Num),
                    ("responses", wire::Schema::Num),
                    ("cost", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("unpriced", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("costEstimated", wire::Schema::OptJs(&wire::Schema::Bool)),
                ]),
            ),
            (
                "slots",
                wire::Schema::List(&wire::Schema::OptJs(&wire::Schema::Num)),
            ),
            ("currentSlot", wire::Schema::Num),
            ("change", wire::Schema::OptJs(&wire::Schema::Num)),
            ("yesterdayAverage", wire::Schema::OptJs(&wire::Schema::Num)),
            ("slotsSince", wire::Schema::OptJs(&wire::Schema::Num)),
        ]),
    ),
    ("unpricedModels", wire::Schema::List(&wire::Schema::Str16)),
    ("pricesChecked", wire::Schema::Str16),
]);

/// `buildTokenUsageView` over the binary wire.
#[napi(js_name = "buildTokenUsageViewWire")]
pub fn build_token_usage_view_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_BUILD_TOKEN_USAGE_VIEW_0)?;
        let out = &port::build_token_usage_view(input)?;
        wire::write_value(w, out, &S_BUILD_TOKEN_USAGE_VIEW_OUT)?;
        Ok(())
    })
}

static S_BUILD_TOKEN_TODAY_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_TOKEN_TODAY_OUT: wire::Schema = wire::Schema::Obj(&[
    ("date", wire::Schema::Str16),
    (
        "totals",
        wire::Schema::Obj(&[
            ("input", wire::Schema::Num),
            ("output", wire::Schema::Num),
            ("cacheWrite", wire::Schema::Num),
            ("cacheRead", wire::Schema::Num),
            ("responses", wire::Schema::Num),
            ("cost", wire::Schema::OptJs(&wire::Schema::Num)),
            ("unpriced", wire::Schema::OptJs(&wire::Schema::Num)),
            ("costEstimated", wire::Schema::OptJs(&wire::Schema::Bool)),
        ]),
    ),
    (
        "slots",
        wire::Schema::List(&wire::Schema::OptJs(&wire::Schema::Num)),
    ),
    ("currentSlot", wire::Schema::Num),
    ("change", wire::Schema::OptJs(&wire::Schema::Num)),
    ("yesterdayAverage", wire::Schema::OptJs(&wire::Schema::Num)),
    ("slotsSince", wire::Schema::OptJs(&wire::Schema::Num)),
]);

/// `buildTokenToday` over the binary wire.
#[napi(js_name = "buildTokenTodayWire")]
pub fn build_token_today_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_BUILD_TOKEN_TODAY_0)?;
        let out = &port::build_token_today(input)?;
        wire::write_value(w, out, &S_BUILD_TOKEN_TODAY_OUT)?;
        Ok(())
    })
}
