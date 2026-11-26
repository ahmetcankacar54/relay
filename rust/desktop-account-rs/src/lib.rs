//! JS bindings for `shared/desktop-account.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `desktopAccountFor`.
#[napi(js_name = "desktopAccountFor")]
pub fn desktop_account_for(known: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let known = crate::js::from_json(&known)?;
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::desktop_account_for(known, accounts)?;
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

static S_DESKTOP_ACCOUNT_FOR_0: wire::Schema = wire::Schema::Dyn;
static S_DESKTOP_ACCOUNT_FOR_1: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
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
static S_DESKTOP_ACCOUNT_FOR_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
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

/// `desktopAccountFor` over the binary wire.
#[napi(js_name = "desktopAccountForWire")]
pub fn desktop_account_for_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let known: Value = wire::read_value(r, &S_DESKTOP_ACCOUNT_FOR_0)?;
        let accounts: Vec<Value> =
            r.list(|r| wire::read_value(r, S_DESKTOP_ACCOUNT_FOR_1.inner()))?;
        let out = &port::desktop_account_for(known, accounts)?;
        wire::write_value(w, out, &S_DESKTOP_ACCOUNT_FOR_OUT)?;
        Ok(())
    })
}
