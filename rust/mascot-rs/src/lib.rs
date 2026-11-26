//! JS bindings for `shared/mascot.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `activeReading`.
#[napi(js_name = "activeReading")]
pub fn active_reading(input: String, now: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let now = crate::js::from_json(&now)?;
        let out = port::active_reading(input, now)?;
        crate::js::to_json(&out)
    })
}

/// `mascotRest`.
#[napi(js_name = "mascotRest")]
pub fn mascot_rest(
    input: String,
    now: String,
) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let now = crate::js::from_json(&now)?;
        let out = port::mascot_rest(input, now)?;
        Ok(out.map_or(
            napi::bindgen_prelude::Either::B(()),
            napi::bindgen_prelude::Either::A,
        ))
    })
}

/// `activeFull`.
#[napi(js_name = "activeFull")]
pub fn active_full(input: String, now: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let now = crate::js::from_json(&now)?;
        let out = port::active_full(input, now)?;
        crate::js::to_json(&out)
    })
}

/// `mascotPose`.
#[napi(js_name = "mascotPose")]
pub fn mascot_pose(input: String, now: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let now = crate::js::from_json(&now)?;
        let out = port::mascot_pose(input, now)?;
        Ok(out)
    })
}

/// `headFor`.
#[napi(js_name = "headFor")]
pub fn head_for(pose: String) -> napi::Result<String> {
    run(move || {
        let out = port::head_for(pose)?;
        Ok(out)
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

static S_ACTIVE_READING_0: wire::Schema = wire::Schema::Dyn;
static S_ACTIVE_READING_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("accountId", wire::Schema::Str16),
    (
        "connectionRenewalRequired",
        wire::Schema::OptJs(&wire::Schema::Bool),
    ),
    ("status", wire::Schema::Str16),
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
    (
        "otherLimitReached",
        wire::Schema::OptJs(&wire::Schema::Bool),
    ),
    (
        "modelWindows",
        wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Obj(&[
            ("key", wire::Schema::Str16),
            ("label", wire::Schema::Str16),
            ("usedPercent", wire::Schema::Num),
            ("resetsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("model", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("weeklyShare", wire::Schema::OptJs(&wire::Schema::Num)),
            ("period", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("source", wire::Schema::Dyn),
            ("readAt", wire::Schema::OptJs(&wire::Schema::Str16)),
        ]))),
    ),
    ("checkedAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("liveAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("stale", wire::Schema::Bool),
    ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("cliSignInEndsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("cliSignInEnded", wire::Schema::OptJs(&wire::Schema::Bool)),
    ("issue", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("retryAt", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "lastKnownResets",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            (
                "fiveHour",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("resetsAt", wire::Schema::Str16),
                    ("checkedAt", wire::Schema::Str16),
                ])),
            ),
            (
                "sevenDay",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("resetsAt", wire::Schema::Str16),
                    ("checkedAt", wire::Schema::Str16),
                ])),
            ),
        ])),
    ),
]));

/// `activeReading` over the binary wire.
#[napi(js_name = "activeReadingWire")]
pub fn active_reading_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_ACTIVE_READING_0)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::active_reading(input, now)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_ACTIVE_READING_OUT.inner())?;
            }
            None => w.tag(0),
        }
        Ok(())
    })
}

static S_MASCOT_REST_0: wire::Schema = wire::Schema::Dyn;

/// `mascotRest` over the binary wire.
#[napi(js_name = "mascotRestWire")]
pub fn mascot_rest_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_MASCOT_REST_0)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::mascot_rest(input, now)?;
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

static S_ACTIVE_FULL_0: wire::Schema = wire::Schema::Dyn;
static S_ACTIVE_FULL_OUT: wire::Schema = wire::Schema::Dyn;

/// `activeFull` over the binary wire.
#[napi(js_name = "activeFullWire")]
pub fn active_full_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_ACTIVE_FULL_0)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::active_full(input, now)?;
        wire::write_value(w, out, &S_ACTIVE_FULL_OUT)?;
        Ok(())
    })
}

static S_MASCOT_POSE_0: wire::Schema = wire::Schema::Dyn;

/// `mascotPose` over the binary wire.
#[napi(js_name = "mascotPoseWire")]
pub fn mascot_pose_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_MASCOT_POSE_0)?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::mascot_pose(input, now)?;
        w.string16(out);
        Ok(())
    })
}

/// `headFor` over the binary wire.
#[napi(js_name = "headForWire")]
pub fn head_for_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let pose: String = r.string16()?;
        let out = &port::head_for(pose)?;
        w.string16(out);
        Ok(())
    })
}
