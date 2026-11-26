//! JS bindings for `shared/relay-link.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `relaySwitchLink`.
#[napi(js_name = "relaySwitchLink")]
pub fn relay_switch_link(account_id: String) -> napi::Result<String> {
    run(move || {
        let out = port::relay_switch_link(account_id)?;
        crate::js::to_json(&out)
    })
}

/// `parseRelayLink`.
#[napi(js_name = "parseRelayLink")]
pub fn parse_relay_link(url: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let url = crate::js::from_json(&url)?;
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::parse_relay_link(url, accounts)?;
        crate::js::to_json(&out)
    })
}

/// `relayLinkArgument`.
#[napi(js_name = "relayLinkArgument")]
pub fn relay_link_argument(argv: Vec<String>) -> napi::Result<String> {
    run(move || {
        let out = port::relay_link_argument(argv)?;
        crate::js::to_json(&out)
    })
}

/// `linkedSwitchAccount`.
#[napi(js_name = "linkedSwitchAccount")]
pub fn linked_switch_account(
    account_id: Option<String>,
    accounts: String,
    active_id: Option<String>,
) -> napi::Result<String> {
    run(move || {
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::linked_switch_account(account_id, accounts, active_id)?;
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

static S_RELAY_SWITCH_LINK_OUT: wire::Schema = wire::Schema::Dyn;

/// `relaySwitchLink` over the binary wire.
#[napi(js_name = "relaySwitchLinkWire")]
pub fn relay_switch_link_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account_id: String = r.string16()?;
        let out = &port::relay_switch_link(account_id)?;
        wire::write_value(w, out, &S_RELAY_SWITCH_LINK_OUT)?;
        Ok(())
    })
}

static S_PARSE_RELAY_LINK_0: wire::Schema = wire::Schema::Dyn;
static S_PARSE_RELAY_LINK_OUT: wire::Schema = wire::Schema::Dyn;

/// `parseRelayLink` over the binary wire.
#[napi(js_name = "parseRelayLinkWire")]
pub fn parse_relay_link_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let url: serde_json::Value = wire::read_value(r, &S_PARSE_RELAY_LINK_0)?;
        let accounts: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::parse_relay_link(url, accounts)?;
        wire::write_value(w, out, &S_PARSE_RELAY_LINK_OUT)?;
        Ok(())
    })
}

static S_RELAY_LINK_ARGUMENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `relayLinkArgument` over the binary wire.
#[napi(js_name = "relayLinkArgumentWire")]
pub fn relay_link_argument_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let argv: Vec<String> = r.list(|r| r.string16())?;
        let out = &port::relay_link_argument(argv)?;
        wire::write_value(w, out, &S_RELAY_LINK_ARGUMENT_OUT)?;
        Ok(())
    })
}

static S_LINKED_SWITCH_ACCOUNT_1: wire::Schema = wire::Schema::Dyn;
static S_LINKED_SWITCH_ACCOUNT_OUT: wire::Schema =
    wire::Schema::OptJs(&wire::Schema::Obj(&[("id", wire::Schema::Str16)]));

/// `linkedSwitchAccount` over the binary wire.
#[napi(js_name = "linkedSwitchAccountWire")]
pub fn linked_switch_account_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account_id: Option<String> = r.opt_js(|r| r.string16())?;
        let accounts: serde_json::Value = wire::read_value(r, &S_LINKED_SWITCH_ACCOUNT_1)?;
        let active_id: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::linked_switch_account(account_id, accounts, active_id)?;
        wire::write_value(w, out, &S_LINKED_SWITCH_ACCOUNT_OUT)?;
        Ok(())
    })
}
