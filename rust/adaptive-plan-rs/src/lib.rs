//! JS bindings for `shared/adaptive-plan.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `plannedRate`.
#[napi(js_name = "plannedRate")]
pub fn planned_rate(tempo: String, settings: String, spans: String) -> napi::Result<f64> {
    run(move || {
        let tempo = crate::js::from_json(&tempo)?;
        let settings = crate::js::from_json(&settings)?;
        let spans = crate::js::from_json(&spans)?;
        let out = port::planned_rate(tempo, settings, spans)?;
        Ok(out)
    })
}

/// `paceFactor`.
#[napi(js_name = "paceFactor")]
pub fn pace_factor(observed: Option<f64>, planned: f64) -> napi::Result<f64> {
    run(move || {
        let out = port::pace_factor(observed, planned)?;
        Ok(out)
    })
}

/// `todaysPace`.
#[napi(js_name = "todaysPace")]
pub fn todays_pace(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::todays_pace(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `nextStartCandidates`.
#[napi(js_name = "nextStartCandidates")]
pub fn next_start_candidates(a: String, from: f64, to: f64) -> napi::Result<Vec<f64>> {
    run(move || {
        let a = crate::js::from_json(&a)?;
        let out = port::next_start_candidates(a, from, to)?;
        Ok(out)
    })
}

/// `replanStarts`.
#[napi(js_name = "replanStarts")]
pub fn replan_starts(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::replan_starts(input)?;
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

static S_PLANNED_RATE_0: wire::Schema = wire::Schema::Dyn;
static S_PLANNED_RATE_1: wire::Schema = wire::Schema::Dyn;
static S_PLANNED_RATE_2: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("from", wire::Schema::Num),
    ("to", wire::Schema::Num),
]));

/// `plannedRate` over the binary wire.
#[napi(js_name = "plannedRateWire")]
pub fn planned_rate_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let tempo: serde_json::Value = wire::read_value(r, &S_PLANNED_RATE_0)?;
        let settings: serde_json::Value = wire::read_value(r, &S_PLANNED_RATE_1)?;
        let spans: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_PLANNED_RATE_2.inner()))?;
        let out = &port::planned_rate(tempo, settings, spans)?;
        w.f64(*out);
        Ok(())
    })
}

/// `paceFactor` over the binary wire.
#[napi(js_name = "paceFactorWire")]
pub fn pace_factor_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let observed: Option<f64> = r.opt_js(|r| r.f64())?;
        let planned: f64 = r.f64()?;
        let out = &port::pace_factor(observed, planned)?;
        w.f64(*out);
        Ok(())
    })
}

static S_TODAYS_PACE_0: wire::Schema = wire::Schema::Dyn;
static S_TODAYS_PACE_OUT: wire::Schema = wire::Schema::Obj(&[
    ("observed", wire::Schema::OptJs(&wire::Schema::Num)),
    ("planned", wire::Schema::Num),
    ("factor", wire::Schema::Num),
]);

/// `todaysPace` over the binary wire.
#[napi(js_name = "todaysPaceWire")]
pub fn todays_pace_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: serde_json::Value = wire::read_value(r, &S_TODAYS_PACE_0)?;
        let out = &port::todays_pace(arg0)?;
        wire::write_value(w, out, &S_TODAYS_PACE_OUT)?;
        Ok(())
    })
}

static S_NEXT_START_CANDIDATES_0: wire::Schema = wire::Schema::Dyn;

/// `nextStartCandidates` over the binary wire.
#[napi(js_name = "nextStartCandidatesWire")]
pub fn next_start_candidates_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: serde_json::Value = wire::read_value(r, &S_NEXT_START_CANDIDATES_0)?;
        let from: f64 = r.f64()?;
        let to: f64 = r.f64()?;
        let out = &port::next_start_candidates(a, from, to)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.f64(*x0);
        }
        Ok(())
    })
}

static S_REPLAN_STARTS_0: wire::Schema = wire::Schema::Dyn;
static S_REPLAN_STARTS_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("schedule", wire::Schema::Map16(&wire::Schema::Num)),
    (
        "forecast",
        wire::Schema::Obj(&[
            ("segments", wire::Schema::List(&wire::Schema::Dyn)),
            ("unmet", wire::Schema::Num),
            ("outageMinutes", wire::Schema::Num),
            ("switches", wire::Schema::Num),
            ("exhaustedAt", wire::Schema::Map16(&wire::Schema::Dyn)),
        ]),
    ),
    (
        "defaultForecast",
        wire::Schema::Obj(&[
            ("segments", wire::Schema::List(&wire::Schema::Dyn)),
            ("unmet", wire::Schema::Num),
            ("outageMinutes", wire::Schema::Num),
            ("switches", wire::Schema::Num),
            ("exhaustedAt", wire::Schema::Map16(&wire::Schema::Dyn)),
        ]),
    ),
]));

/// `replanStarts` over the binary wire.
#[napi(js_name = "replanStartsWire")]
pub fn replan_starts_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_REPLAN_STARTS_0)?;
        let out = &port::replan_starts(input)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_REPLAN_STARTS_OUT.inner())?;
            }
            None => w.tag(0),
        }
        Ok(())
    })
}
