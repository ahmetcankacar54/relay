//! JS bindings for `shared/usage-rollups.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `emptyRollups`.
#[napi(js_name = "emptyRollups")]
pub fn empty_rollups() -> napi::Result<String> {
    run(move || {
        let out = port::empty_rollups()?;
        crate::js::to_json(&out)
    })
}

/// `hourKey`.
#[napi(js_name = "hourKey")]
pub fn hour_key(time: f64) -> napi::Result<String> {
    run(move || {
        let out = port::hour_key(time)?;
        Ok(out)
    })
}

/// `validWindow`.
#[napi(js_name = "validWindow")]
pub fn valid_window(sample: String) -> napi::Result<bool> {
    run(move || {
        let sample = crate::js::from_json(&sample)?;
        let out = port::valid_window(sample)?;
        Ok(out)
    })
}

/// `sameReset`.
#[napi(js_name = "sameReset")]
pub fn same_reset(a: String, b: String) -> napi::Result<bool> {
    run(move || {
        let out = port::same_reset(a, b)?;
        Ok(out)
    })
}

/// `foldSample`.
#[napi(js_name = "foldSample")]
pub fn fold_sample(rollups: String, s: String, now: f64) -> napi::Result<String> {
    run(move || {
        let rollups = crate::js::from_json(&rollups)?;
        let s = crate::js::from_json(&s)?;
        let out = port::fold_sample(rollups, s, now)?;
        crate::js::to_json(&out)
    })
}

/// `foldSamples`.
#[napi(js_name = "foldSamples")]
pub fn fold_samples(samples: String, now: f64) -> napi::Result<String> {
    run(move || {
        let samples = crate::js::from_json(&samples)?;
        let out = port::fold_samples(samples, now)?;
        crate::js::to_json(&out)
    })
}

/// `catchUp`.
#[napi(js_name = "catchUp")]
pub fn catch_up(rollups: String, samples: String, now: f64) -> napi::Result<String> {
    run(move || {
        let rollups = crate::js::from_json(&rollups)?;
        let samples = crate::js::from_json(&samples)?;
        let out = port::catch_up(rollups, samples, now)?;
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

static S_EMPTY_ROLLUPS_OUT: wire::Schema = wire::Schema::Obj(&[
    ("version", wire::Schema::Num),
    (
        "hours",
        wire::Schema::Map16(&wire::Schema::Map16(&wire::Schema::Dyn)),
    ),
    (
        "windows",
        wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Obj(&[
            ("resetAt", wire::Schema::Dyn),
            ("maxPercent", wire::Schema::Dyn),
        ]))),
    ),
    (
        "hits",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("identity", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("at", wire::Schema::Str16),
            ("until", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("resetAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "last",
        wire::Schema::Map16(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            ("identity", wire::Schema::Str16),
            ("checkedAt", wire::Schema::Str16),
            ("fiveHour", wire::Schema::Dyn),
            ("sevenDay", wire::Schema::Dyn),
        ])),
    ),
]);

/// `emptyRollups` over the binary wire.
#[napi(js_name = "emptyRollupsWire")]
pub fn empty_rollups_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::empty_rollups()?;
        wire::write_value(w, out, &S_EMPTY_ROLLUPS_OUT)?;
        Ok(())
    })
}

/// `hourKey` over the binary wire.
#[napi(js_name = "hourKeyWire")]
pub fn hour_key_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let time: f64 = r.f64()?;
        let out = &port::hour_key(time)?;
        w.string16(out);
        Ok(())
    })
}

static S_VALID_WINDOW_0: wire::Schema = wire::Schema::Dyn;

/// `validWindow` over the binary wire.
#[napi(js_name = "validWindowWire")]
pub fn valid_window_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let sample: serde_json::Value = wire::read_value(r, &S_VALID_WINDOW_0)?;
        let out = &port::valid_window(sample)?;
        w.bool(*out);
        Ok(())
    })
}

/// `sameReset` over the binary wire.
#[napi(js_name = "sameResetWire")]
pub fn same_reset_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: String = r.string16()?;
        let b: String = r.string16()?;
        let out = &port::same_reset(a, b)?;
        w.bool(*out);
        Ok(())
    })
}

static S_FOLD_SAMPLE_0: wire::Schema = wire::Schema::Dyn;
static S_FOLD_SAMPLE_1: wire::Schema = wire::Schema::Dyn;
static S_FOLD_SAMPLE_OUT: wire::Schema = wire::Schema::Obj(&[
    ("version", wire::Schema::Num),
    (
        "hours",
        wire::Schema::Map16(&wire::Schema::Map16(&wire::Schema::Dyn)),
    ),
    (
        "windows",
        wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Obj(&[
            ("resetAt", wire::Schema::Dyn),
            ("maxPercent", wire::Schema::Dyn),
        ]))),
    ),
    (
        "hits",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("identity", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("at", wire::Schema::Str16),
            ("until", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("resetAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "last",
        wire::Schema::Map16(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            ("identity", wire::Schema::Str16),
            ("checkedAt", wire::Schema::Str16),
            ("fiveHour", wire::Schema::Dyn),
            ("sevenDay", wire::Schema::Dyn),
        ])),
    ),
]);

/// `foldSample` over the binary wire.
#[napi(js_name = "foldSampleWire")]
pub fn fold_sample_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let rollups: serde_json::Value = wire::read_value(r, &S_FOLD_SAMPLE_0)?;
        let s: serde_json::Value = wire::read_value(r, &S_FOLD_SAMPLE_1)?;
        let now: f64 = r.f64()?;
        let out = &port::fold_sample(rollups, s, now)?;
        wire::write_value(w, out, &S_FOLD_SAMPLE_OUT)?;
        Ok(())
    })
}

static S_FOLD_SAMPLES_0: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("accountId", wire::Schema::Str16),
    ("identity", wire::Schema::Str16),
    ("checkedAt", wire::Schema::Str16),
    (
        "fiveHour",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "sevenDay",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
]));
static S_FOLD_SAMPLES_OUT: wire::Schema = wire::Schema::Obj(&[
    ("version", wire::Schema::Num),
    (
        "hours",
        wire::Schema::Map16(&wire::Schema::Map16(&wire::Schema::Dyn)),
    ),
    (
        "windows",
        wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Obj(&[
            ("resetAt", wire::Schema::Dyn),
            ("maxPercent", wire::Schema::Dyn),
        ]))),
    ),
    (
        "hits",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("identity", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("at", wire::Schema::Str16),
            ("until", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("resetAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "last",
        wire::Schema::Map16(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            ("identity", wire::Schema::Str16),
            ("checkedAt", wire::Schema::Str16),
            ("fiveHour", wire::Schema::Dyn),
            ("sevenDay", wire::Schema::Dyn),
        ])),
    ),
]);

/// `foldSamples` over the binary wire.
#[napi(js_name = "foldSamplesWire")]
pub fn fold_samples_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let samples: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_FOLD_SAMPLES_0.inner()))?;
        let now: f64 = r.f64()?;
        let out = &port::fold_samples(samples, now)?;
        wire::write_value(w, out, &S_FOLD_SAMPLES_OUT)?;
        Ok(())
    })
}

static S_CATCH_UP_0: wire::Schema = wire::Schema::Dyn;
static S_CATCH_UP_1: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("accountId", wire::Schema::Str16),
    ("identity", wire::Schema::Str16),
    ("checkedAt", wire::Schema::Str16),
    (
        "fiveHour",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "sevenDay",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
]));
static S_CATCH_UP_OUT: wire::Schema = wire::Schema::Obj(&[
    ("version", wire::Schema::Num),
    (
        "hours",
        wire::Schema::Map16(&wire::Schema::Map16(&wire::Schema::Dyn)),
    ),
    (
        "windows",
        wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Obj(&[
            ("resetAt", wire::Schema::Dyn),
            ("maxPercent", wire::Schema::Dyn),
        ]))),
    ),
    (
        "hits",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("identity", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("at", wire::Schema::Str16),
            ("until", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("resetAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "last",
        wire::Schema::Map16(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            ("identity", wire::Schema::Str16),
            ("checkedAt", wire::Schema::Str16),
            ("fiveHour", wire::Schema::Dyn),
            ("sevenDay", wire::Schema::Dyn),
        ])),
    ),
]);

/// `catchUp` over the binary wire.
#[napi(js_name = "catchUpWire")]
pub fn catch_up_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let rollups: serde_json::Value = wire::read_value(r, &S_CATCH_UP_0)?;
        let samples: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_CATCH_UP_1.inner()))?;
        let now: f64 = r.f64()?;
        let out = &port::catch_up(rollups, samples, now)?;
        wire::write_value(w, out, &S_CATCH_UP_OUT)?;
        Ok(())
    })
}
