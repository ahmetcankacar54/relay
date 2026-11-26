//! JS bindings for `shared/usage-statistics-view.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `inWorkHours`.
#[napi(js_name = "inWorkHours")]
pub fn in_work_hours(weekday: f64, hour: f64, hours: String) -> napi::Result<bool> {
    run(move || {
        let hours = crate::js::from_json(&hours)?;
        let out = port::in_work_hours(weekday, hour, hours)?;
        Ok(out)
    })
}

/// `buildStatisticsView`.
#[napi(js_name = "buildStatisticsView")]
pub fn build_statistics_view(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::build_statistics_view(input)?;
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

static S_IN_WORK_HOURS_2: wire::Schema = wire::Schema::Dyn;

/// `inWorkHours` over the binary wire.
#[napi(js_name = "inWorkHoursWire")]
pub fn in_work_hours_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let weekday: f64 = r.f64()?;
        let hour: f64 = r.f64()?;
        let hours: serde_json::Value = wire::read_value(r, &S_IN_WORK_HOURS_2)?;
        let out = &port::in_work_hours(weekday, hour, hours)?;
        w.bool(*out);
        Ok(())
    })
}

static S_BUILD_STATISTICS_VIEW_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_STATISTICS_VIEW_OUT: wire::Schema = wire::Schema::Obj(&[
    ("range", wire::Schema::Num),
    ("status", wire::Schema::Str16),
    ("coveragePercent", wire::Schema::Num),
    (
        "totals",
        wire::Schema::Obj(&[
            ("proUnits", wire::Schema::Num),
            ("periods", wire::Schema::OptJs(&wire::Schema::Num)),
            ("previousProUnits", wire::Schema::OptJs(&wire::Schema::Num)),
            ("windows", wire::Schema::Num),
            (
                "hits",
                wire::Schema::Obj(&[
                    ("fiveHour", wire::Schema::Num),
                    ("weekly", wire::Schema::Num),
                ]),
            ),
            (
                "busiest",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("weekday", wire::Schema::Num),
                    ("hour", wire::Schema::Num),
                    ("workShare", wire::Schema::Num),
                ])),
            ),
            (
                "busiestWindow",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("start", wire::Schema::Num),
                    ("end", wire::Schema::Num),
                ])),
            ),
        ]),
    ),
    (
        "accounts",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("former", wire::Schema::OptJs(&wire::Schema::Bool)),
            ("name", wire::Schema::Str16),
            ("plan", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("proUnits", wire::Schema::Num),
            ("periods", wire::Schema::OptJs(&wire::Schema::Num)),
            ("share", wire::Schema::Num),
            ("averageFill", wire::Schema::OptJs(&wire::Schema::Num)),
            ("idleDays", wire::Schema::Num),
        ])),
    ),
    (
        "daily",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("date", wire::Schema::Str16),
            ("byAccount", wire::Schema::Map16(&wire::Schema::Num)),
            (
                "periods",
                wire::Schema::OptJs(&wire::Schema::Map16(&wire::Schema::Num)),
            ),
        ])),
    ),
    (
        "heatmap",
        wire::Schema::List(&wire::Schema::List(&wire::Schema::Num)),
    ),
    (
        "hits",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("accountId", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("former", wire::Schema::OptJs(&wire::Schema::Bool)),
            ("name", wire::Schema::Str16),
            ("kind", wire::Schema::Str16),
            ("at", wire::Schema::Str16),
            ("until", wire::Schema::OptJs(&wire::Schema::Str16)),
        ])),
    ),
    (
        "insight",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            ("id", wire::Schema::Dyn),
            ("params", wire::Schema::Map16(&wire::Schema::Dyn)),
        ])),
    ),
]);

/// `buildStatisticsView` over the binary wire.
#[napi(js_name = "buildStatisticsViewWire")]
pub fn build_statistics_view_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_BUILD_STATISTICS_VIEW_0)?;
        let out = &port::build_statistics_view(input)?;
        wire::write_value(w, out, &S_BUILD_STATISTICS_VIEW_OUT)?;
        Ok(())
    })
}
