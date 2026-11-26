//! JS bindings for `shared/day-plan.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `planContext`.
#[napi(js_name = "planContext")]
pub fn plan_context(accounts: String, tempo: String) -> napi::Result<String> {
    run(move || {
        let accounts = crate::js::from_json(&accounts)?;
        let tempo = crate::js::from_json(&tempo)?;
        let out = port::plan_context(accounts, tempo)?;
        crate::js::to_json(&out)
    })
}

/// `cyclePhases`.
#[napi(js_name = "cyclePhases")]
pub fn cycle_phases(fixed: String) -> napi::Result<Vec<f64>> {
    run(move || {
        let fixed = crate::js::from_json(&fixed)?;
        let out = port::cycle_phases(fixed)?;
        Ok(out)
    })
}

/// `clearPlanCache`.
#[napi(js_name = "clearPlanCache")]
pub fn clear_plan_cache() -> napi::Result<String> {
    run(move || {
        let out = port::clear_plan_cache()?;
        crate::js::to_json(&out)
    })
}

/// `planCacheStats`.
#[napi(js_name = "planCacheStats")]
pub fn plan_cache_stats() -> napi::Result<String> {
    run(move || {
        let out = port::plan_cache_stats()?;
        crate::js::to_json(&out)
    })
}

/// `dayPlan`.
#[napi(js_name = "dayPlan")]
pub fn day_plan(
    date: String,
    settings: String,
    context: String,
    live_resets: String,
) -> napi::Result<String> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let context = crate::js::from_json(&context)?;
        let live_resets = crate::js::from_json(&live_resets)?;
        let out = port::day_plan(date, settings, context, live_resets)?;
        crate::js::to_json(&out)
    })
}

/// `shouldHaveWindow`.
#[napi(js_name = "shouldHaveWindow")]
pub fn should_have_window(
    account_id: String,
    now: f64,
    settings: String,
    context: String,
) -> napi::Result<String> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let context = crate::js::from_json(&context)?;
        let out = port::should_have_window(account_id, now, settings, context)?;
        crate::js::to_json(&out)
    })
}

/// `nextPlannedStart`.
#[napi(js_name = "nextPlannedStart")]
pub fn next_planned_start(
    account_id: String,
    now: f64,
    settings: String,
    context: String,
) -> napi::Result<String> {
    run(move || {
        let settings = crate::js::from_json(&settings)?;
        let context = crate::js::from_json(&context)?;
        let out = port::next_planned_start(account_id, now, settings, context)?;
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

static S_PLAN_CONTEXT_0: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
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
static S_PLAN_CONTEXT_1: wire::Schema = wire::Schema::Dyn;
static S_PLAN_CONTEXT_OUT: wire::Schema = wire::Schema::Obj(&[
    ("capacities", wire::Schema::Map16(&wire::Schema::Num)),
    (
        "tempo",
        wire::Schema::Obj(&[
            ("source", wire::Schema::Str16),
            ("weekday", wire::Schema::List(&wire::Schema::Num)),
            ("weekend", wire::Schema::List(&wire::Schema::Num)),
            (
                "rate",
                wire::Schema::Obj(&[
                    ("weekday", wire::Schema::Num),
                    ("weekend", wire::Schema::Num),
                ]),
            ),
            (
                "days",
                wire::Schema::Obj(&[
                    ("weekday", wire::Schema::Num),
                    ("weekend", wire::Schema::Num),
                ]),
            ),
        ]),
    ),
]);

/// `planContext` over the binary wire.
#[napi(js_name = "planContextWire")]
pub fn plan_context_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let accounts: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_PLAN_CONTEXT_0.inner()))?;
        let tempo: serde_json::Value = wire::read_value(r, &S_PLAN_CONTEXT_1)?;
        let out = &port::plan_context(accounts, tempo)?;
        wire::write_value(w, out, &S_PLAN_CONTEXT_OUT)?;
        Ok(())
    })
}

/// `cyclePhases` over the binary wire.
#[napi(js_name = "cyclePhasesWire")]
pub fn cycle_phases_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let fixed: Vec<Option<f64>> = r.list(|r| r.opt_js(|r| r.f64()))?;
        let out = &port::cycle_phases(fixed)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.f64(*x0);
        }
        Ok(())
    })
}

static S_CLEAR_PLAN_CACHE_OUT: wire::Schema = wire::Schema::Dyn;

/// `clearPlanCache` over the binary wire.
#[napi(js_name = "clearPlanCacheWire")]
pub fn clear_plan_cache_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::clear_plan_cache()?;
        wire::write_value(w, out, &S_CLEAR_PLAN_CACHE_OUT)?;
        Ok(())
    })
}

static S_PLAN_CACHE_STATS_OUT: wire::Schema = wire::Schema::Dyn;

/// `planCacheStats` over the binary wire.
#[napi(js_name = "planCacheStatsWire")]
pub fn plan_cache_stats_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::plan_cache_stats()?;
        wire::write_value(w, out, &S_PLAN_CACHE_STATS_OUT)?;
        Ok(())
    })
}

static S_DAY_PLAN_1: wire::Schema = wire::Schema::Dyn;
static S_DAY_PLAN_2: wire::Schema = wire::Schema::Dyn;
static S_DAY_PLAN_OUT: wire::Schema = wire::Schema::Obj(&[
    ("date", wire::Schema::Str16),
    (
        "interval",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("date", wire::Schema::Str16),
            ("start", wire::Schema::Num),
            ("end", wire::Schema::Num),
            ("weekend", wire::Schema::Bool),
        ])),
    ),
    (
        "accounts",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::Str16),
            ("firstStart", wire::Schema::Num),
            ("evenStart", wire::Schema::Num),
            ("manual", wire::Schema::Bool),
            ("windows", wire::Schema::List(&wire::Schema::Dyn)),
            ("activeFrom", wire::Schema::Num),
            ("activeUntil", wire::Schema::Num),
        ])),
    ),
    (
        "forecast",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            (
                "segments",
                wire::Schema::List(&wire::Schema::Obj(&[
                    ("accountId", wire::Schema::Dyn),
                    ("from", wire::Schema::Dyn),
                    ("to", wire::Schema::Dyn),
                ])),
            ),
            ("unmet", wire::Schema::Num),
            ("outageMinutes", wire::Schema::Num),
            ("switches", wire::Schema::Num),
            (
                "exhaustedAt",
                wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Dyn)),
            ),
        ])),
    ),
    (
        "evenForecast",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            (
                "segments",
                wire::Schema::List(&wire::Schema::Obj(&[
                    ("accountId", wire::Schema::Dyn),
                    ("from", wire::Schema::Dyn),
                    ("to", wire::Schema::Dyn),
                ])),
            ),
            ("unmet", wire::Schema::Num),
            ("outageMinutes", wire::Schema::Num),
            ("switches", wire::Schema::Num),
            (
                "exhaustedAt",
                wire::Schema::Map16(&wire::Schema::List(&wire::Schema::Dyn)),
            ),
        ])),
    ),
]);

/// `dayPlan` over the binary wire.
#[napi(js_name = "dayPlanWire")]
pub fn day_plan_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let date: String = r.string16()?;
        let settings: serde_json::Value = wire::read_value(r, &S_DAY_PLAN_1)?;
        let context: serde_json::Value = wire::read_value(r, &S_DAY_PLAN_2)?;
        let live_resets: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::day_plan(date, settings, context, live_resets)?;
        wire::write_value(w, out, &S_DAY_PLAN_OUT)?;
        Ok(())
    })
}

static S_SHOULD_HAVE_WINDOW_2: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_HAVE_WINDOW_3: wire::Schema = wire::Schema::Dyn;
static S_SHOULD_HAVE_WINDOW_OUT: wire::Schema = wire::Schema::Dyn;

/// `shouldHaveWindow` over the binary wire.
#[napi(js_name = "shouldHaveWindowWire")]
pub fn should_have_window_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account_id: String = r.string16()?;
        let now: f64 = r.f64()?;
        let settings: serde_json::Value = wire::read_value(r, &S_SHOULD_HAVE_WINDOW_2)?;
        let context: serde_json::Value = wire::read_value(r, &S_SHOULD_HAVE_WINDOW_3)?;
        let out = &port::should_have_window(account_id, now, settings, context)?;
        wire::write_value(w, out, &S_SHOULD_HAVE_WINDOW_OUT)?;
        Ok(())
    })
}

static S_NEXT_PLANNED_START_2: wire::Schema = wire::Schema::Dyn;
static S_NEXT_PLANNED_START_3: wire::Schema = wire::Schema::Dyn;
static S_NEXT_PLANNED_START_OUT: wire::Schema = wire::Schema::Dyn;

/// `nextPlannedStart` over the binary wire.
#[napi(js_name = "nextPlannedStartWire")]
pub fn next_planned_start_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account_id: String = r.string16()?;
        let now: f64 = r.f64()?;
        let settings: serde_json::Value = wire::read_value(r, &S_NEXT_PLANNED_START_2)?;
        let context: serde_json::Value = wire::read_value(r, &S_NEXT_PLANNED_START_3)?;
        let out = &port::next_planned_start(account_id, now, settings, context)?;
        wire::write_value(w, out, &S_NEXT_PLANNED_START_OUT)?;
        Ok(())
    })
}
