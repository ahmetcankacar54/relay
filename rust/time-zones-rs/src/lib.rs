//! JS bindings for `shared/time-zones.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `validTimeZone`.
#[napi(js_name = "validTimeZone")]
pub fn valid_time_zone(zone: String) -> napi::Result<bool> {
    run(move || {
        let out = port::valid_time_zone(zone)?;
        Ok(out)
    })
}

/// `timeZoneCity`.
#[napi(js_name = "timeZoneCity")]
pub fn time_zone_city(zone: String) -> napi::Result<String> {
    run(move || {
        let out = port::time_zone_city(zone)?;
        Ok(out)
    })
}

/// `timeZoneOffset`.
#[napi(js_name = "timeZoneOffset")]
pub fn time_zone_offset(zone: String, now: String) -> napi::Result<String> {
    run(move || {
        let now = crate::js::from_json(&now)?;
        let out = port::time_zone_offset(zone, now)?;
        Ok(out)
    })
}

/// `buildTimeZoneCatalog`.
#[napi(js_name = "buildTimeZoneCatalog")]
pub fn build_time_zone_catalog(supported: String) -> napi::Result<Vec<String>> {
    run(move || {
        let supported = crate::js::from_json(&supported)?;
        let out = port::build_time_zone_catalog(supported)?;
        Ok(out)
    })
}

/// `foldTimeZoneSearch`.
#[napi(js_name = "foldTimeZoneSearch")]
pub fn fold_time_zone_search(value: String) -> napi::Result<String> {
    run(move || {
        let out = port::fold_time_zone_search(value)?;
        Ok(out)
    })
}

/// `timeZoneOptions`.
#[napi(js_name = "timeZoneOptions")]
pub fn time_zone_options(current: String, now: String, catalog: String) -> napi::Result<String> {
    run(move || {
        let now = crate::js::from_json(&now)?;
        let catalog = crate::js::from_json(&catalog)?;
        let out = port::time_zone_options(current, now, catalog)?;
        crate::js::to_json(&out)
    })
}

/// `filterTimeZones`.
#[napi(js_name = "filterTimeZones")]
pub fn filter_time_zones(options: String, query: String, now: String) -> napi::Result<String> {
    run(move || {
        let options = crate::js::from_json(&options)?;
        let now = crate::js::from_json(&now)?;
        let out = port::filter_time_zones(options, query, now)?;
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

/// `validTimeZone` over the binary wire.
#[napi(js_name = "validTimeZoneWire")]
pub fn valid_time_zone_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let zone: String = r.string16()?;
        let out = &port::valid_time_zone(zone)?;
        w.bool(*out);
        Ok(())
    })
}

/// `timeZoneCity` over the binary wire.
#[napi(js_name = "timeZoneCityWire")]
pub fn time_zone_city_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let zone: String = r.string16()?;
        let out = &port::time_zone_city(zone)?;
        w.string16(out);
        Ok(())
    })
}

/// `timeZoneOffset` over the binary wire.
#[napi(js_name = "timeZoneOffsetWire")]
pub fn time_zone_offset_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let zone: String = r.string16()?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::time_zone_offset(zone, now)?;
        w.string16(out);
        Ok(())
    })
}

/// `buildTimeZoneCatalog` over the binary wire.
#[napi(js_name = "buildTimeZoneCatalogWire")]
pub fn build_time_zone_catalog_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let supported: Option<Vec<String>> = r.opt_js(|r| r.list(|r| r.string16()))?;
        let out = &port::build_time_zone_catalog(supported)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            w.string16(x0);
        }
        Ok(())
    })
}

/// `foldTimeZoneSearch` over the binary wire.
#[napi(js_name = "foldTimeZoneSearchWire")]
pub fn fold_time_zone_search_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: String = r.string16()?;
        let out = &port::fold_time_zone_search(value)?;
        w.string16(out);
        Ok(())
    })
}

static S_TIME_ZONE_OPTIONS_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("zone", wire::Schema::Str16),
    ("city", wire::Schema::Str16),
    ("offset", wire::Schema::Str16),
    ("common", wire::Schema::Bool),
]));

/// `timeZoneOptions` over the binary wire.
#[napi(js_name = "timeZoneOptionsWire")]
pub fn time_zone_options_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let current: String = r.string16()?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let catalog: Option<Vec<String>> = r.opt_js(|r| r.list(|r| r.string16()))?;
        let out = &port::time_zone_options(current, now, catalog)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_TIME_ZONE_OPTIONS_OUT.inner())?;
        }
        Ok(())
    })
}

static S_FILTER_TIME_ZONES_0: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("zone", wire::Schema::Str16),
    ("city", wire::Schema::Str16),
    ("offset", wire::Schema::Str16),
    ("common", wire::Schema::Bool),
]));
static S_FILTER_TIME_ZONES_OUT: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
    ("zone", wire::Schema::Str16),
    ("city", wire::Schema::Str16),
    ("offset", wire::Schema::Str16),
    ("common", wire::Schema::Bool),
]));

/// `filterTimeZones` over the binary wire.
#[napi(js_name = "filterTimeZonesWire")]
pub fn filter_time_zones_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let options: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_FILTER_TIME_ZONES_0.inner()))?;
        let query: String = r.string16()?;
        let now: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::filter_time_zones(options, query, now)?;
        w.tag(1);
        w.count(out.len());
        for x0 in out.iter() {
            wire::write_value(w, x0, S_FILTER_TIME_ZONES_OUT.inner())?;
        }
        Ok(())
    })
}
