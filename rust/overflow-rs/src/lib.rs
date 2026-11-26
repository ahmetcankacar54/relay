//! JS bindings for `shared/overflow.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `overflowFamily`.
#[napi(js_name = "overflowFamily")]
pub fn overflow_family(model: String) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let out = port::overflow_family(model)?;
        Ok(out.map_or(
            napi::bindgen_prelude::Either::B(()),
            napi::bindgen_prelude::Either::A,
        ))
    })
}

/// `overflowModel`.
#[napi(js_name = "overflowModel")]
pub fn overflow_model(upstream: String, requested: String) -> napi::Result<String> {
    run(move || {
        let upstream = crate::js::from_json(&upstream)?;
        let out = port::overflow_model(upstream, requested)?;
        Ok(out)
    })
}

/// `deepseekPeak`.
#[napi(js_name = "deepseekPeak")]
pub fn deepseek_peak(at: f64) -> napi::Result<bool> {
    run(move || {
        let out = port::deepseek_peak(at)?;
        Ok(out)
    })
}

/// `presetRates`.
#[napi(js_name = "presetRates")]
pub fn preset_rates(preset_id: String, model: String, at: f64) -> napi::Result<String> {
    run(move || {
        let preset_id = crate::js::from_json(&preset_id)?;
        let out = port::preset_rates(preset_id, model, at)?;
        crate::js::to_json(&out)
    })
}

/// `overflowCost`.
#[napi(js_name = "overflowCost")]
pub fn overflow_cost(
    upstream: String,
    model: String,
    tokens: String,
    at: f64,
    fetched: String,
) -> napi::Result<String> {
    run(move || {
        let upstream = crate::js::from_json(&upstream)?;
        let tokens = crate::js::from_json(&tokens)?;
        let fetched = crate::js::from_json(&fetched)?;
        let out = port::overflow_cost(upstream, model, tokens, at, fetched)?;
        crate::js::to_json(&out)
    })
}

/// `keyHint`.
#[napi(js_name = "keyHint")]
pub fn key_hint(key: String) -> napi::Result<String> {
    run(move || {
        let out = port::key_hint(key)?;
        crate::js::to_json(&out)
    })
}

/// `localDayBounds`.
#[napi(js_name = "localDayBounds")]
pub fn local_day_bounds(at: f64, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::local_day_bounds(at, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `spentToday`.
#[napi(js_name = "spentToday")]
pub fn spent_today(costs: String, now: f64, time_zone: String) -> napi::Result<String> {
    run(move || {
        let costs = crate::js::from_json(&costs)?;
        let out = port::spent_today(costs, now, time_zone)?;
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

/// `overflowFamily` over the binary wire.
#[napi(js_name = "overflowFamilyWire")]
pub fn overflow_family_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: String = r.string16()?;
        let out = &port::overflow_family(model)?;
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

static S_OVERFLOW_MODEL_0: wire::Schema = wire::Schema::Dyn;

/// `overflowModel` over the binary wire.
#[napi(js_name = "overflowModelWire")]
pub fn overflow_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let upstream: Value = wire::read_value(r, &S_OVERFLOW_MODEL_0)?;
        let requested: String = r.string16()?;
        let out = &port::overflow_model(upstream, requested)?;
        w.string16(out);
        Ok(())
    })
}

/// `deepseekPeak` over the binary wire.
#[napi(js_name = "deepseekPeakWire")]
pub fn deepseek_peak_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let at: f64 = r.f64()?;
        let out = &port::deepseek_peak(at)?;
        w.bool(*out);
        Ok(())
    })
}

static S_PRESET_RATES_0: wire::Schema = wire::Schema::Dyn;
static S_PRESET_RATES_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("input", wire::Schema::Num),
    ("output", wire::Schema::Num),
    ("cacheRead", wire::Schema::OptJs(&wire::Schema::Num)),
    ("cacheWrite", wire::Schema::OptJs(&wire::Schema::Num)),
]));

/// `presetRates` over the binary wire.
#[napi(js_name = "presetRatesWire")]
pub fn preset_rates_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let preset_id: Value = wire::read_value(r, &S_PRESET_RATES_0)?;
        let model: String = r.string16()?;
        let at: f64 = r.f64()?;
        let out = &port::preset_rates(preset_id, model, at)?;
        wire::write_value(w, out, &S_PRESET_RATES_OUT)?;
        Ok(())
    })
}

static S_OVERFLOW_COST_0: wire::Schema = wire::Schema::Dyn;
static S_OVERFLOW_COST_2: wire::Schema = wire::Schema::Dyn;
static S_OVERFLOW_COST_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Num);

/// `overflowCost` over the binary wire.
#[napi(js_name = "overflowCostWire")]
pub fn overflow_cost_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let upstream: Value = wire::read_value(r, &S_OVERFLOW_COST_0)?;
        let model: String = r.string16()?;
        let tokens: Value = wire::read_value(r, &S_OVERFLOW_COST_2)?;
        let at: f64 = r.f64()?;
        let fetched: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::overflow_cost(upstream, model, tokens, at, fetched)?;
        wire::write_value(w, out, &S_OVERFLOW_COST_OUT)?;
        Ok(())
    })
}

static S_KEY_HINT_OUT: wire::Schema = wire::Schema::Str16;

/// `keyHint` over the binary wire.
#[napi(js_name = "keyHintWire")]
pub fn key_hint_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let key: String = r.string16()?;
        let out = &port::key_hint(key)?;
        wire::write_value(w, out, &S_KEY_HINT_OUT)?;
        Ok(())
    })
}

static S_LOCAL_DAY_BOUNDS_OUT: wire::Schema =
    wire::Schema::Obj(&[("start", wire::Schema::Num), ("end", wire::Schema::Num)]);

/// `localDayBounds` over the binary wire.
#[napi(js_name = "localDayBoundsWire")]
pub fn local_day_bounds_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let at: f64 = r.f64()?;
        let time_zone: String = r.string16()?;
        let out = &port::local_day_bounds(at, time_zone)?;
        wire::write_value(w, out, &S_LOCAL_DAY_BOUNDS_OUT)?;
        Ok(())
    })
}

static S_SPENT_TODAY_0: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("at", wire::Schema::Num),
    ("cost", wire::Schema::Num),
]));
static S_SPENT_TODAY_OUT: wire::Schema = wire::Schema::Num;

/// `spentToday` over the binary wire.
#[napi(js_name = "spentTodayWire")]
pub fn spent_today_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let costs: Vec<Value> = r.list(|r| wire::read_value(r, S_SPENT_TODAY_0.inner()))?;
        let now: f64 = r.f64()?;
        let time_zone: String = r.string16()?;
        let out = &port::spent_today(costs, now, time_zone)?;
        wire::write_value(w, out, &S_SPENT_TODAY_OUT)?;
        Ok(())
    })
}
