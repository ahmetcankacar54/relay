//! JS bindings for `shared/lost-found.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `tierOf`.
#[napi(js_name = "tierOf")]
pub fn tier_of(weeks: f64) -> napi::Result<String> {
    run(move || {
        let out = port::tier_of(weeks)?;
        crate::js::to_json(&out)
    })
}

/// `nextTier`.
#[napi(js_name = "nextTier")]
pub fn next_tier(weeks: f64) -> napi::Result<String> {
    run(move || {
        let out = port::next_tier(weeks)?;
        crate::js::to_json(&out)
    })
}

/// `modelFamily`.
#[napi(js_name = "modelFamily")]
pub fn model_family(model: String) -> napi::Result<napi::bindgen_prelude::Either<String, ()>> {
    run(move || {
        let out = port::model_family(model)?;
        Ok(out.map_or(
            napi::bindgen_prelude::Either::B(()),
            napi::bindgen_prelude::Either::A,
        ))
    })
}

/// `addDays`.
#[napi(js_name = "addDays")]
pub fn add_days(date: String, days: f64) -> napi::Result<String> {
    run(move || {
        let out = port::add_days(date, days)?;
        crate::js::to_json(&out)
    })
}

/// `mondayOf`.
#[napi(js_name = "mondayOf")]
pub fn monday_of(date: String) -> napi::Result<String> {
    run(move || {
        let out = port::monday_of(date)?;
        crate::js::to_json(&out)
    })
}

/// `validLostItem`.
#[napi(js_name = "validLostItem")]
pub fn valid_lost_item(value: String) -> napi::Result<bool> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::valid_lost_item(value)?;
        Ok(out)
    })
}

/// `lostFoundWeek`.
#[napi(js_name = "lostFoundWeek")]
pub fn lost_found_week(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::lost_found_week(input)?;
        crate::js::to_json(&out)
    })
}

/// `lostFoundCollection`.
#[napi(js_name = "lostFoundCollection")]
pub fn lost_found_collection(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::lost_found_collection(input)?;
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

/// `tierOf` over the binary wire.
#[napi(js_name = "tierOfWire")]
pub fn tier_of_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let weeks: f64 = r.f64()?;
        let out = &port::tier_of(weeks)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_NEXT_TIER_OUT: wire::Schema = wire::Schema::Dyn;

/// `nextTier` over the binary wire.
#[napi(js_name = "nextTierWire")]
pub fn next_tier_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let weeks: f64 = r.f64()?;
        let out = &port::next_tier(weeks)?;
        wire::write_value(w, out, &S_NEXT_TIER_OUT)?;
        Ok(())
    })
}

/// `modelFamily` over the binary wire.
#[napi(js_name = "modelFamilyWire")]
pub fn model_family_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: String = r.string16()?;
        let out = &port::model_family(model)?;
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

static S_ADD_DAYS_OUT: wire::Schema = wire::Schema::Dyn;

/// `addDays` over the binary wire.
#[napi(js_name = "addDaysWire")]
pub fn add_days_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let date: String = r.string16()?;
        let days: f64 = r.f64()?;
        let out = &port::add_days(date, days)?;
        wire::write_value(w, out, &S_ADD_DAYS_OUT)?;
        Ok(())
    })
}

static S_MONDAY_OF_OUT: wire::Schema = wire::Schema::Dyn;

/// `mondayOf` over the binary wire.
#[napi(js_name = "mondayOfWire")]
pub fn monday_of_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let date: String = r.string16()?;
        let out = &port::monday_of(date)?;
        wire::write_value(w, out, &S_MONDAY_OF_OUT)?;
        Ok(())
    })
}

static S_VALID_LOST_ITEM_0: wire::Schema = wire::Schema::Dyn;

/// `validLostItem` over the binary wire.
#[napi(js_name = "validLostItemWire")]
pub fn valid_lost_item_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: serde_json::Value = wire::read_value(r, &S_VALID_LOST_ITEM_0)?;
        let out = &port::valid_lost_item(value)?;
        wire::write_dyn(w, &serde_json::to_value(out).map_err(|e| e.to_string())?);
        Ok(())
    })
}

static S_LOST_FOUND_WEEK_0: wire::Schema = wire::Schema::Dyn;
static S_LOST_FOUND_WEEK_OUT: wire::Schema = wire::Schema::Obj(&[
    ("start", wire::Schema::Str16),
    ("end", wire::Schema::Str16),
    ("latest", wire::Schema::Str16),
    ("oldest", wire::Schema::Str16),
    ("items", wire::Schema::List(&wire::Schema::Dyn)),
]);

/// `lostFoundWeek` over the binary wire.
#[napi(js_name = "lostFoundWeekWire")]
pub fn lost_found_week_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_LOST_FOUND_WEEK_0)?;
        let out = &port::lost_found_week(input)?;
        wire::write_value(w, out, &S_LOST_FOUND_WEEK_OUT)?;
        Ok(())
    })
}

static S_LOST_FOUND_COLLECTION_0: wire::Schema = wire::Schema::Dyn;
static S_LOST_FOUND_COLLECTION_OUT: wire::Schema = wire::Schema::Obj(&[
    ("latest", wire::Schema::Str16),
    ("oldest", wire::Schema::Str16),
    ("found", wire::Schema::Dyn),
]);

/// `lostFoundCollection` over the binary wire.
#[napi(js_name = "lostFoundCollectionWire")]
pub fn lost_found_collection_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_LOST_FOUND_COLLECTION_0)?;
        let out = &port::lost_found_collection(input)?;
        wire::write_value(w, out, &S_LOST_FOUND_COLLECTION_OUT)?;
        Ok(())
    })
}
