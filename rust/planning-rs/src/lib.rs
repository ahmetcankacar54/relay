//! JS bindings for `shared/planning.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `localDate`.
#[napi(js_name = "localDate")]
pub fn local_date(time: f64, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::local_date(time, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `localSlot`.
#[napi(js_name = "localSlot")]
pub fn local_slot(time: f64, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::local_slot(time, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `localHour`.
#[napi(js_name = "localHour")]
pub fn local_hour(time: f64, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::local_hour(time, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `wallTime`.
#[napi(js_name = "wallTime")]
pub fn wall_time(date: String, clock: String, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::wall_time(date, clock, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `wallTimeOrNext`.
#[napi(js_name = "wallTimeOrNext")]
pub fn wall_time_or_next(date: String, clock: String, time_zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::wall_time_or_next(date, clock, time_zone)?;
        crate::js::to_json(&out)
    })
}

/// `systemTimeZone`.
#[napi(js_name = "systemTimeZone")]
pub fn system_time_zone() -> napi::Result<String> {
    run(move || {
        let out = port::system_time_zone()?;
        crate::js::to_json(&out)
    })
}

/// `defaultPlanning`.
#[napi(js_name = "defaultPlanning")]
pub fn default_planning() -> napi::Result<String> {
    run(move || {
        let out = port::default_planning()?;
        crate::js::to_json(&out)
    })
}

/// `planningIdentity`.
#[napi(js_name = "planningIdentity")]
pub fn planning_identity(a: String) -> napi::Result<String> {
    run(move || {
        let a = crate::js::from_json(&a)?;
        let out = port::planning_identity(a)?;
        crate::js::to_json(&out)
    })
}

/// `planCapacity`.
#[napi(js_name = "planCapacity")]
pub fn plan_capacity(a: String) -> napi::Result<String> {
    run(move || {
        let a = crate::js::from_json(&a)?;
        let out = port::plan_capacity(a)?;
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

static S_LOCAL_DATE_OUT: wire::Schema = wire::Schema::Dyn;

/// `localDate` over the binary wire.
#[napi(js_name = "localDateWire")]
pub fn local_date_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let time: f64 = r.f64()?;
        let time_zone: String = r.string16()?;
        let out = &port::local_date(time, time_zone)?;
        wire::write_value(w, out, &S_LOCAL_DATE_OUT)?;
        Ok(())
    })
}

static S_LOCAL_SLOT_OUT: wire::Schema = wire::Schema::Dyn;

/// `localSlot` over the binary wire.
#[napi(js_name = "localSlotWire")]
pub fn local_slot_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let time: f64 = r.f64()?;
        let time_zone: String = r.string16()?;
        let out = &port::local_slot(time, time_zone)?;
        wire::write_value(w, out, &S_LOCAL_SLOT_OUT)?;
        Ok(())
    })
}

static S_LOCAL_HOUR_OUT: wire::Schema = wire::Schema::Dyn;

/// `localHour` over the binary wire.
#[napi(js_name = "localHourWire")]
pub fn local_hour_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let time: f64 = r.f64()?;
        let time_zone: String = r.string16()?;
        let out = &port::local_hour(time, time_zone)?;
        wire::write_value(w, out, &S_LOCAL_HOUR_OUT)?;
        Ok(())
    })
}

static S_WALL_TIME_OUT: wire::Schema = wire::Schema::Dyn;

/// `wallTime` over the binary wire.
#[napi(js_name = "wallTimeWire")]
pub fn wall_time_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let date: String = r.string16()?;
        let clock: String = r.string16()?;
        let time_zone: String = r.string16()?;
        let out = &port::wall_time(date, clock, time_zone)?;
        wire::write_value(w, out, &S_WALL_TIME_OUT)?;
        Ok(())
    })
}

static S_WALL_TIME_OR_NEXT_OUT: wire::Schema = wire::Schema::Dyn;

/// `wallTimeOrNext` over the binary wire.
#[napi(js_name = "wallTimeOrNextWire")]
pub fn wall_time_or_next_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let date: String = r.string16()?;
        let clock: String = r.string16()?;
        let time_zone: String = r.string16()?;
        let out = &port::wall_time_or_next(date, clock, time_zone)?;
        wire::write_value(w, out, &S_WALL_TIME_OR_NEXT_OUT)?;
        Ok(())
    })
}

static S_SYSTEM_TIME_ZONE_OUT: wire::Schema = wire::Schema::Dyn;

/// `systemTimeZone` over the binary wire.
#[napi(js_name = "systemTimeZoneWire")]
pub fn system_time_zone_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::system_time_zone()?;
        wire::write_value(w, out, &S_SYSTEM_TIME_ZONE_OUT)?;
        Ok(())
    })
}

static S_DEFAULT_PLANNING_OUT: wire::Schema = wire::Schema::Obj(&[
    ("autoStart", wire::Schema::Bool),
    ("timeZone", wire::Schema::Str16),
    (
        "weekday",
        wire::Schema::Obj(&[
            ("enabled", wire::Schema::Bool),
            ("start", wire::Schema::Str16),
            ("end", wire::Schema::Str16),
        ]),
    ),
    (
        "weekend",
        wire::Schema::Obj(&[
            ("enabled", wire::Schema::Bool),
            ("start", wire::Schema::Str16),
            ("end", wire::Schema::Str16),
        ]),
    ),
    (
        "accounts",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("id", wire::Schema::Str16),
            ("firstStart", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    ("tempo", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("adaptive", wire::Schema::OptJs(&wire::Schema::Bool)),
]);

/// `defaultPlanning` over the binary wire.
#[napi(js_name = "defaultPlanningWire")]
pub fn default_planning_wire() -> napi::Result<f64> {
    wire_io(|_r, w| {
        let out = &port::default_planning()?;
        wire::write_value(w, out, &S_DEFAULT_PLANNING_OUT)?;
        Ok(())
    })
}

static S_PLANNING_IDENTITY_0: wire::Schema = wire::Schema::Dyn;
static S_PLANNING_IDENTITY_OUT: wire::Schema = wire::Schema::Dyn;

/// `planningIdentity` over the binary wire.
#[napi(js_name = "planningIdentityWire")]
pub fn planning_identity_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: serde_json::Value = wire::read_value(r, &S_PLANNING_IDENTITY_0)?;
        let out = &port::planning_identity(a)?;
        wire::write_value(w, out, &S_PLANNING_IDENTITY_OUT)?;
        Ok(())
    })
}

static S_PLAN_CAPACITY_0: wire::Schema = wire::Schema::Dyn;
static S_PLAN_CAPACITY_OUT: wire::Schema = wire::Schema::Dyn;

/// `planCapacity` over the binary wire.
#[napi(js_name = "planCapacityWire")]
pub fn plan_capacity_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let a: serde_json::Value = wire::read_value(r, &S_PLAN_CAPACITY_0)?;
        let out = &port::plan_capacity(a)?;
        wire::write_value(w, out, &S_PLAN_CAPACITY_OUT)?;
        Ok(())
    })
}
