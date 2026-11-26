//! JS bindings for `shared/continuation-target-ranking.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `switchAtPercent`.
#[napi(js_name = "switchAtPercent")]
pub fn switch_at_percent(account: String, fallback: f64) -> napi::Result<f64> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let out = port::switch_at_percent(account, fallback)?;
        Ok(out)
    })
}

/// `continuationTargetScore`.
#[napi(js_name = "continuationTargetScore")]
pub fn continuation_target_score(account: String, usage: String) -> napi::Result<f64> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let usage = crate::js::from_json(&usage)?;
        let out = port::continuation_target_score(account, usage)?;
        Ok(out)
    })
}

/// `rankContinuationTargets`.
#[napi(js_name = "rankContinuationTargets")]
pub fn rank_continuation_targets(candidates: String, context: String) -> napi::Result<String> {
    run(move || {
        let candidates = crate::js::from_json(&candidates)?;
        let context = crate::js::from_json(&context)?;
        let out = port::rank_continuation_targets(candidates, context)?;
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

static S_SWITCH_AT_PERCENT_0: wire::Schema = wire::Schema::Dyn;

/// `switchAtPercent` over the binary wire.
#[napi(js_name = "switchAtPercentWire")]
pub fn switch_at_percent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_SWITCH_AT_PERCENT_0)?;
        let fallback: f64 = r.f64()?;
        let out = &port::switch_at_percent(account, fallback)?;
        w.f64(*out);
        Ok(())
    })
}

static S_CONTINUATION_TARGET_SCORE_0: wire::Schema = wire::Schema::Dyn;

/// `continuationTargetScore` over the binary wire.
#[napi(js_name = "continuationTargetScoreWire")]
pub fn continuation_target_score_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_CONTINUATION_TARGET_SCORE_0)?;
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::continuation_target_score(account, usage)?;
        w.f64(*out);
        Ok(())
    })
}

static S_RANK_CONTINUATION_TARGETS_0: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    (
        "account",
        wire::Schema::Obj(&[
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
                    ("plan", wire::Schema::Dyn),
                    ("capacityWeight", wire::Schema::Dyn),
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
        ]),
    ),
    (
        "usage",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            (
                "connectionRenewalRequired",
                wire::Schema::OptJs(&wire::Schema::Bool),
            ),
            ("status", wire::Schema::Str16),
            ("fiveHour", wire::Schema::Dyn),
            ("sevenDay", wire::Schema::Dyn),
            (
                "otherLimitReached",
                wire::Schema::OptJs(&wire::Schema::Bool),
            ),
            (
                "modelWindows",
                wire::Schema::OptJs(&wire::Schema::List(&wire::Schema::Dyn)),
            ),
            ("checkedAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("liveAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("stale", wire::Schema::Bool),
            ("source", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("cliSignInEndsAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("cliSignInEnded", wire::Schema::OptJs(&wire::Schema::Bool)),
            ("issue", wire::Schema::Dyn),
            ("retryAt", wire::Schema::OptJs(&wire::Schema::Str16)),
            (
                "lastKnownResets",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("fiveHour", wire::Schema::Dyn),
                    ("sevenDay", wire::Schema::Dyn),
                ])),
            ),
        ])),
    ),
]));
static S_RANK_CONTINUATION_TARGETS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("score", wire::Schema::Num),
    ("remainingPercent", wire::Schema::Num),
]));

/// `rankContinuationTargets` over the binary wire.
#[napi(js_name = "rankContinuationTargetsWire")]
pub fn rank_continuation_targets_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let candidates: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_RANK_CONTINUATION_TARGETS_0.inner()))?;
        let context: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::rank_continuation_targets(candidates, context)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_RANK_CONTINUATION_TARGETS_OUT.inner())?;
        }
        Ok(())
    })
}
