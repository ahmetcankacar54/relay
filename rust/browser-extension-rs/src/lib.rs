//! JS bindings for `shared/browser-extension.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `browserApps`.
#[napi(js_name = "browserApps")]
pub fn browser_apps(platform: Option<String>) -> napi::Result<String> {
    run(move || {
        let out = port::browser_apps(platform)?;
        crate::js::to_json(&out)
    })
}

/// `writesBrowser`.
#[napi(js_name = "writesBrowser")]
pub fn writes_browser(mode: String) -> napi::Result<bool> {
    run(move || {
        let mode = crate::js::from_json(&mode)?;
        let out = port::writes_browser(mode)?;
        Ok(out)
    })
}

/// `localStateProfiles`.
#[napi(js_name = "localStateProfiles")]
pub fn local_state_profiles(local_state: String) -> napi::Result<String> {
    run(move || {
        let local_state = crate::js::from_json(&local_state)?;
        let out = port::local_state_profiles(local_state)?;
        crate::js::to_json(&out)
    })
}

/// `startupRestores`.
#[napi(js_name = "startupRestores")]
pub fn startup_restores(preferences: String) -> napi::Result<bool> {
    run(move || {
        let preferences = crate::js::from_json(&preferences)?;
        let out = port::startup_restores(preferences)?;
        Ok(out)
    })
}

/// `chooseInstance`.
#[napi(js_name = "chooseInstance")]
pub fn choose_instance(instances: String, chosen: String) -> napi::Result<String> {
    run(move || {
        let instances = crate::js::from_json(&instances)?;
        let chosen = crate::js::from_json(&chosen)?;
        let out = port::choose_instance(instances, chosen)?;
        crate::js::to_json(&out)
    })
}

/// `pickInstance`.
#[napi(js_name = "pickInstance")]
pub fn pick_instance(instances: String, chosen: String) -> napi::Result<String> {
    run(move || {
        let instances = crate::js::from_json(&instances)?;
        let chosen = crate::js::from_json(&chosen)?;
        let out = port::pick_instance(instances, chosen)?;
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

static S_BROWSER_APPS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `browserApps` over the binary wire.
#[napi(js_name = "browserAppsWire")]
pub fn browser_apps_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let platform: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::browser_apps(platform)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_BROWSER_APPS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_WRITES_BROWSER_0: wire::Schema = wire::Schema::Dyn;

/// `writesBrowser` over the binary wire.
#[napi(js_name = "writesBrowserWire")]
pub fn writes_browser_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let mode: Value = wire::read_value(r, &S_WRITES_BROWSER_0)?;
        let out = &port::writes_browser(mode)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_LOCAL_STATE_PROFILES_0: wire::Schema = wire::Schema::Dyn;
static S_LOCAL_STATE_PROFILES_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("profile", wire::Schema::Str16),
    ("name", wire::Schema::Str16),
]));

/// `localStateProfiles` over the binary wire.
#[napi(js_name = "localStateProfilesWire")]
pub fn local_state_profiles_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let local_state: Value = wire::read_value(r, &S_LOCAL_STATE_PROFILES_0)?;
        let out = &port::local_state_profiles(local_state)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_LOCAL_STATE_PROFILES_OUT.inner())?;
        }
        Ok(())
    })
}

static S_STARTUP_RESTORES_0: wire::Schema = wire::Schema::Dyn;

/// `startupRestores` over the binary wire.
#[napi(js_name = "startupRestoresWire")]
pub fn startup_restores_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let preferences: Value = wire::read_value(r, &S_STARTUP_RESTORES_0)?;
        let out = &port::startup_restores(preferences)?;
        w.bool(*out);
        Ok(())
    })
}

static S_CHOOSE_INSTANCE_0: wire::Schema = wire::Schema::Dyn;
static S_CHOOSE_INSTANCE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("name", wire::Schema::Str16),
    ("opened", wire::Schema::Bool),
    ("usedAt", wire::Schema::OptJs(&wire::Schema::Num)),
]));

/// `chooseInstance` over the binary wire.
#[napi(js_name = "chooseInstanceWire")]
pub fn choose_instance_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let instances: Value = wire::read_value(r, &S_CHOOSE_INSTANCE_0)?;
        let chosen: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::choose_instance(instances, chosen)?;
        wire::write_value(w, out, &S_CHOOSE_INSTANCE_OUT)?;
        Ok(())
    })
}

static S_PICK_INSTANCE_0: wire::Schema = wire::Schema::Dyn;
static S_PICK_INSTANCE_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    (
        "instance",
        wire::Schema::Obj(&[
            ("name", wire::Schema::Str16),
            ("opened", wire::Schema::Bool),
            ("usedAt", wire::Schema::OptJs(&wire::Schema::Num)),
        ]),
    ),
    ("picked", wire::Schema::Str16),
]));

/// `pickInstance` over the binary wire.
#[napi(js_name = "pickInstanceWire")]
pub fn pick_instance_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let instances: Value = wire::read_value(r, &S_PICK_INSTANCE_0)?;
        let chosen: Option<Value> = wire::read_dyn_opt(r)?;
        let out = &port::pick_instance(instances, chosen)?;
        wire::write_value(w, out, &S_PICK_INSTANCE_OUT)?;
        Ok(())
    })
}
