//! JS bindings for `shared/history-policy.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `allowedHistoryPair`.
#[napi(js_name = "allowedHistoryPair")]
pub fn allowed_history_pair(
    source: String,
    target: String,
    settings: String,
) -> napi::Result<bool> {
    run(move || {
        let source = crate::js::from_json(&source)?;
        let target = crate::js::from_json(&target)?;
        let settings = crate::js::from_json(&settings)?;
        let out = port::allowed_history_pair(source, target, settings)?;
        Ok(out)
    })
}

/// `historySources`.
#[napi(js_name = "historySources")]
pub fn history_sources(target: String, accounts: String, settings: String) -> napi::Result<String> {
    run(move || {
        let target = crate::js::from_json(&target)?;
        let accounts = crate::js::from_json(&accounts)?;
        let settings = crate::js::from_json(&settings)?;
        let out = port::history_sources(target, accounts, settings)?;
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

static S_ALLOWED_HISTORY_PAIR_0: wire::Schema = wire::Schema::Dyn;
static S_ALLOWED_HISTORY_PAIR_1: wire::Schema = wire::Schema::Dyn;
static S_ALLOWED_HISTORY_PAIR_2: wire::Schema = wire::Schema::Dyn;

/// `allowedHistoryPair` over the binary wire.
#[napi(js_name = "allowedHistoryPairWire")]
pub fn allowed_history_pair_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let source: serde_json::Value = wire::read_value(r, &S_ALLOWED_HISTORY_PAIR_0)?;
        let target: serde_json::Value = wire::read_value(r, &S_ALLOWED_HISTORY_PAIR_1)?;
        let settings: serde_json::Value = wire::read_value(r, &S_ALLOWED_HISTORY_PAIR_2)?;
        let out = &port::allowed_history_pair(source, target, settings)?;
        w.bool(*out);
        Ok(())
    })
}

static S_HISTORY_SOURCES_0: wire::Schema = wire::Schema::Dyn;
static S_HISTORY_SOURCES_1: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
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
static S_HISTORY_SOURCES_2: wire::Schema = wire::Schema::Dyn;
static S_HISTORY_SOURCES_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
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

/// `historySources` over the binary wire.
#[napi(js_name = "historySourcesWire")]
pub fn history_sources_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let target: serde_json::Value = wire::read_value(r, &S_HISTORY_SOURCES_0)?;
        let accounts: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_HISTORY_SOURCES_1.inner()))?;
        let settings: serde_json::Value = wire::read_value(r, &S_HISTORY_SOURCES_2)?;
        let out = &port::history_sources(target, accounts, settings)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_HISTORY_SOURCES_OUT.inner())?;
        }
        Ok(())
    })
}
