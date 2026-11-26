//! JS bindings for `shared/feature-risk.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `needsRiskAck`.
#[napi(js_name = "needsRiskAck")]
pub fn needs_risk_ack(settings: String, id: String) -> napi::Result<bool> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let id = crate::js::from_json(&id)?;
        let out = port::needs_risk_ack(settings, id)?;
        Ok(out)
    })
}

/// `pendingRisks`.
#[napi(js_name = "pendingRisks")]
pub fn pending_risks(settings: String, ids: String) -> napi::Result<String> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let ids = crate::js::from_json(&ids)?;
        let out = port::pending_risks(settings, ids)?;
        crate::js::to_json(&out)
    })
}

/// `acknowledgeRisks`.
#[napi(js_name = "acknowledgeRisks")]
pub fn acknowledge_risks(acks: String, ids: String) -> napi::Result<String> {
    run(move || {
        let acks = crate::js::from_json(&acks)?;
        let ids = crate::js::from_json(&ids)?;
        let out = port::acknowledge_risks(acks, ids)?;
        crate::js::to_json(&out)
    })
}

/// `gatewayRisks`.
#[napi(js_name = "gatewayRisks")]
pub fn gateway_risks(config: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let config = crate::js::from_json(&config)?;
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::gateway_risks(config, accounts)?;
        crate::js::to_json(&out)
    })
}

/// `proxyPatchRisks`.
#[napi(js_name = "proxyPatchRisks")]
pub fn proxy_patch_risks(config: String, patch: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let config = crate::js::from_json(&config)?;
        let patch = crate::js::from_json(&patch)?;
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::proxy_patch_risks(config, patch, accounts)?;
        crate::js::to_json(&out)
    })
}

/// `clientRisks`.
#[napi(js_name = "clientRisks")]
pub fn client_risks(id: String) -> napi::Result<String> {
    run(move || {
        let out = port::client_risks(id)?;
        crate::js::to_json(&out)
    })
}

/// `antigravityAccountRisks`.
#[napi(js_name = "antigravityAccountRisks")]
pub fn antigravity_account_risks(gateway_on: bool) -> napi::Result<String> {
    run(move || {
        let out = port::antigravity_account_risks(gateway_on)?;
        crate::js::to_json(&out)
    })
}

/// `planningRisks`.
#[napi(js_name = "planningRisks")]
pub fn planning_risks(before: String, patch: String) -> napi::Result<String> {
    run(move || {
        let before = crate::js::from_json(&before)?;
        let patch = crate::js::from_json(&patch)?;
        let out = port::planning_risks(before, patch)?;
        crate::js::to_json(&out)
    })
}

/// `meterRisk`.
#[napi(js_name = "meterRisk")]
pub fn meter_risk(provider: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let out = port::meter_risk(provider)?;
        crate::js::to_json(&out)
    })
}

/// `meterRisks`.
#[napi(js_name = "meterRisks")]
pub fn meter_risks(before: String, after: String) -> napi::Result<String> {
    run(move || {
        let before = crate::js::from_json(&before)?;
        let after = crate::js::from_json(&after)?;
        let out = port::meter_risks(before, after)?;
        crate::js::to_json(&out)
    })
}

/// `enabledRisks`.
#[napi(js_name = "enabledRisks")]
pub fn enabled_risks(state: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let out = port::enabled_risks(state)?;
        crate::js::to_json(&out)
    })
}

/// `turnOffSteps`.
#[napi(js_name = "turnOffSteps")]
pub fn turn_off_steps(pending: String, state: String) -> napi::Result<String> {
    run(move || {
        let pending = crate::js::from_json(&pending)?;
        let state = crate::js::from_json(&state)?;
        let out = port::turn_off_steps(pending, state)?;
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

static S_NEEDS_RISK_ACK_0: wire::Schema = wire::Schema::Dyn;
static S_NEEDS_RISK_ACK_1: wire::Schema = wire::Schema::Dyn;

/// `needsRiskAck` over the binary wire.
#[napi(js_name = "needsRiskAckWire")]
pub fn needs_risk_ack_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let settings: Value = wire::read_value(r, &S_NEEDS_RISK_ACK_0)?;
        let id: Value = wire::read_value(r, &S_NEEDS_RISK_ACK_1)?;
        let out = &port::needs_risk_ack(settings, id)?;
        w.bool(*out);
        Ok(())
    })
}

static S_PENDING_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_PENDING_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_PENDING_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `pendingRisks` over the binary wire.
#[napi(js_name = "pendingRisksWire")]
pub fn pending_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let settings: Value = wire::read_value(r, &S_PENDING_RISKS_0)?;
        let ids: Value = wire::read_value(r, &S_PENDING_RISKS_1)?;
        let out = &port::pending_risks(settings, ids)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_PENDING_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_ACKNOWLEDGE_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_ACKNOWLEDGE_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_ACKNOWLEDGE_RISKS_OUT: wire::Schema = wire::Schema::Dyn;

/// `acknowledgeRisks` over the binary wire.
#[napi(js_name = "acknowledgeRisksWire")]
pub fn acknowledge_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let acks: Value = wire::read_value(r, &S_ACKNOWLEDGE_RISKS_0)?;
        let ids: Value = wire::read_value(r, &S_ACKNOWLEDGE_RISKS_1)?;
        let out = &port::acknowledge_risks(acks, ids)?;
        wire::write_value(w, out, &S_ACKNOWLEDGE_RISKS_OUT)?;
        Ok(())
    })
}

static S_GATEWAY_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_GATEWAY_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_GATEWAY_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `gatewayRisks` over the binary wire.
#[napi(js_name = "gatewayRisksWire")]
pub fn gateway_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let config: Value = wire::read_value(r, &S_GATEWAY_RISKS_0)?;
        let accounts: Value = wire::read_value(r, &S_GATEWAY_RISKS_1)?;
        let out = &port::gateway_risks(config, accounts)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_GATEWAY_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_PROXY_PATCH_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_PROXY_PATCH_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_PROXY_PATCH_RISKS_2: wire::Schema = wire::Schema::Dyn;
static S_PROXY_PATCH_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `proxyPatchRisks` over the binary wire.
#[napi(js_name = "proxyPatchRisksWire")]
pub fn proxy_patch_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let config: Value = wire::read_value(r, &S_PROXY_PATCH_RISKS_0)?;
        let patch: Value = wire::read_value(r, &S_PROXY_PATCH_RISKS_1)?;
        let accounts: Value = wire::read_value(r, &S_PROXY_PATCH_RISKS_2)?;
        let out = &port::proxy_patch_risks(config, patch, accounts)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_PROXY_PATCH_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_CLIENT_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `clientRisks` over the binary wire.
#[napi(js_name = "clientRisksWire")]
pub fn client_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let id: String = r.string16()?;
        let out = &port::client_risks(id)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_CLIENT_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_ANTIGRAVITY_ACCOUNT_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `antigravityAccountRisks` over the binary wire.
#[napi(js_name = "antigravityAccountRisksWire")]
pub fn antigravity_account_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let gateway_on: bool = r.bool()?;
        let out = &port::antigravity_account_risks(gateway_on)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_ANTIGRAVITY_ACCOUNT_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_PLANNING_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_PLANNING_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_PLANNING_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `planningRisks` over the binary wire.
#[napi(js_name = "planningRisksWire")]
pub fn planning_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let before: Value = wire::read_value(r, &S_PLANNING_RISKS_0)?;
        let patch: Value = wire::read_value(r, &S_PLANNING_RISKS_1)?;
        let out = &port::planning_risks(before, patch)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_PLANNING_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_METER_RISK_0: wire::Schema = wire::Schema::Dyn;
static S_METER_RISK_OUT: wire::Schema = wire::Schema::Dyn;

/// `meterRisk` over the binary wire.
#[napi(js_name = "meterRiskWire")]
pub fn meter_risk_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_METER_RISK_0)?;
        let out = &port::meter_risk(provider)?;
        wire::write_value(w, out, &S_METER_RISK_OUT)?;
        Ok(())
    })
}

static S_METER_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_METER_RISKS_1: wire::Schema = wire::Schema::Dyn;
static S_METER_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `meterRisks` over the binary wire.
#[napi(js_name = "meterRisksWire")]
pub fn meter_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let before: Value = wire::read_value(r, &S_METER_RISKS_0)?;
        let after: Value = wire::read_value(r, &S_METER_RISKS_1)?;
        let out = &port::meter_risks(before, after)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_METER_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_ENABLED_RISKS_0: wire::Schema = wire::Schema::Dyn;
static S_ENABLED_RISKS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `enabledRisks` over the binary wire.
#[napi(js_name = "enabledRisksWire")]
pub fn enabled_risks_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: Value = wire::read_value(r, &S_ENABLED_RISKS_0)?;
        let out = &port::enabled_risks(state)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_ENABLED_RISKS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_TURN_OFF_STEPS_0: wire::Schema = wire::Schema::Dyn;
static S_TURN_OFF_STEPS_1: wire::Schema = wire::Schema::Dyn;
static S_TURN_OFF_STEPS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Dyn);

/// `turnOffSteps` over the binary wire.
#[napi(js_name = "turnOffStepsWire")]
pub fn turn_off_steps_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let pending: Value = wire::read_value(r, &S_TURN_OFF_STEPS_0)?;
        let state: Value = wire::read_value(r, &S_TURN_OFF_STEPS_1)?;
        let out = &port::turn_off_steps(pending, state)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_TURN_OFF_STEPS_OUT.inner())?;
        }
        Ok(())
    })
}
