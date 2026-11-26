//! JS bindings for `shared/widget-snapshot.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `widgetMood`.
#[napi(js_name = "widgetMood")]
pub fn widget_mood(state: String, active: String) -> napi::Result<String> {
    run(move || {
        let state = crate::js::from_json(&state)?;
        let active = crate::js::from_json(&active)?;
        let out = port::widget_mood(state, active)?;
        Ok(out)
    })
}

/// `widgetCountdown`.
#[napi(js_name = "widgetCountdown")]
pub fn widget_countdown(at: Option<f64>, now: f64) -> napi::Result<String> {
    run(move || {
        let out = port::widget_countdown(at, now)?;
        crate::js::to_json(&out)
    })
}

/// `buildWidgetSnapshot`.
#[napi(js_name = "buildWidgetSnapshot")]
pub fn build_widget_snapshot(input: String) -> napi::Result<String> {
    run(move || {
        let input = crate::js::from_json(&input)?;
        let out = port::build_widget_snapshot(input)?;
        crate::js::to_json(&out)
    })
}

/// `widgetVisibleKey`.
#[napi(js_name = "widgetVisibleKey")]
pub fn widget_visible_key(snapshot: String) -> napi::Result<String> {
    run(move || {
        let snapshot = crate::js::from_json(&snapshot)?;
        let out = port::widget_visible_key(snapshot)?;
        Ok(out)
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

static S_WIDGET_MOOD_0: wire::Schema = wire::Schema::Dyn;

/// `widgetMood` over the binary wire.
#[napi(js_name = "widgetMoodWire")]
pub fn widget_mood_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let state: serde_json::Value = wire::read_value(r, &S_WIDGET_MOOD_0)?;
        let active: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::widget_mood(state, active)?;
        w.string16(out);
        Ok(())
    })
}

static S_WIDGET_COUNTDOWN_OUT: wire::Schema = wire::Schema::Dyn;

/// `widgetCountdown` over the binary wire.
#[napi(js_name = "widgetCountdownWire")]
pub fn widget_countdown_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let at: Option<f64> = r.opt_js(|r| r.f64())?;
        let now: f64 = r.f64()?;
        let out = &port::widget_countdown(at, now)?;
        wire::write_value(w, out, &S_WIDGET_COUNTDOWN_OUT)?;
        Ok(())
    })
}

static S_BUILD_WIDGET_SNAPSHOT_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_WIDGET_SNAPSHOT_OUT: wire::Schema = wire::Schema::Obj(&[
    ("version", wire::Schema::Num),
    ("generatedAt", wire::Schema::Num),
    ("locale", wire::Schema::Dyn),
    ("date", wire::Schema::Str16),
    ("zone", wire::Schema::Str16),
    ("state", wire::Schema::Str16),
    ("mood", wire::Schema::Str16),
    (
        "totals",
        wire::Schema::Obj(&[
            ("input", wire::Schema::Num),
            ("output", wire::Schema::Num),
            ("cache", wire::Schema::Num),
            ("total", wire::Schema::Num),
        ]),
    ),
    ("cost", wire::Schema::Num),
    ("change", wire::Schema::OptJs(&wire::Schema::Num)),
    (
        "slots",
        wire::Schema::List(&wire::Schema::OptJs(&wire::Schema::Num)),
    ),
    ("yesterdayAverage", wire::Schema::OptJs(&wire::Schema::Num)),
    (
        "active",
        wire::Schema::OptJs(&wire::Schema::Obj(&[("text", wire::Schema::Dyn)])),
    ),
    (
        "accounts",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("suggested", wire::Schema::Bool),
            ("switchable", wire::Schema::Bool),
            ("link", wire::Schema::OptJs(&wire::Schema::Str16)),
            ("text", wire::Schema::Dyn),
        ])),
    ),
    (
        "series",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("key", wire::Schema::Str16),
            ("name", wire::Schema::Str16),
            ("color", wire::Schema::Num),
        ])),
    ),
    (
        "split",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("cost", wire::Schema::Num),
            ("share", wire::Schema::Num),
            ("text", wire::Schema::Obj(&[("cost", wire::Schema::Str16)])),
        ])),
    ),
    (
        "week",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            (
                "days",
                wire::Schema::List(&wire::Schema::Obj(&[
                    ("date", wire::Schema::Str16),
                    ("label", wire::Schema::Str16),
                    ("today", wire::Schema::Bool),
                    ("cost", wire::Schema::Num),
                    ("parts", wire::Schema::List(&wire::Schema::Dyn)),
                ])),
            ),
            ("cost", wire::Schema::Num),
            ("tokens", wire::Schema::Num),
            ("average", wire::Schema::Num),
            ("hits", wire::Schema::OptJs(&wire::Schema::Num)),
            (
                "text",
                wire::Schema::Obj(&[
                    ("title", wire::Schema::Str16),
                    ("cost", wire::Schema::Str16),
                    ("tokens", wire::Schema::Str16),
                    ("average", wire::Schema::Str16),
                    ("busiest", wire::Schema::Str16),
                    ("hits", wire::Schema::Str16),
                    ("activeWeek", wire::Schema::Str16),
                    (
                        "pairs",
                        wire::Schema::List(&wire::Schema::Obj(&[
                            ("label", wire::Schema::Dyn),
                            ("figure", wire::Schema::Dyn),
                        ])),
                    ),
                ]),
            ),
        ])),
    ),
    (
        "text",
        wire::Schema::Obj(&[
            ("title", wire::Schema::Str16),
            ("subtitle", wire::Schema::Str16),
            ("rows", wire::Schema::Dyn),
            ("input", wire::Schema::Str16),
            ("output", wire::Schema::Str16),
            ("cache", wire::Schema::Str16),
            ("total", wire::Schema::Str16),
            ("cost", wire::Schema::Str16),
            ("change", wire::Schema::Str16),
            ("status", wire::Schema::Str16),
            ("empty", wire::Schema::Str16),
            ("stale", wire::Schema::Str16),
            ("costTokens", wire::Schema::Str16),
            ("tokens", wire::Schema::Str16),
            ("apiTitle", wire::Schema::Str16),
            ("others", wire::Schema::Str16),
            ("todayWord", wire::Schema::Str16),
            ("inClaude", wire::Schema::Str16),
            ("suggested", wire::Schema::Str16),
            ("todayLine", wire::Schema::Str16),
            ("allToday", wire::Schema::Str16),
            ("switch", wire::Schema::Str16),
            ("left", wire::Schema::Str16),
            ("noActive", wire::Schema::Str16),
        ]),
    ),
]);

/// `buildWidgetSnapshot` over the binary wire.
#[napi(js_name = "buildWidgetSnapshotWire")]
pub fn build_widget_snapshot_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let input: serde_json::Value = wire::read_value(r, &S_BUILD_WIDGET_SNAPSHOT_0)?;
        let out = &port::build_widget_snapshot(input)?;
        wire::write_value(w, out, &S_BUILD_WIDGET_SNAPSHOT_OUT)?;
        Ok(())
    })
}

static S_WIDGET_VISIBLE_KEY_0: wire::Schema = wire::Schema::Dyn;

/// `widgetVisibleKey` over the binary wire.
#[napi(js_name = "widgetVisibleKeyWire")]
pub fn widget_visible_key_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot: serde_json::Value = wire::read_value(r, &S_WIDGET_VISIBLE_KEY_0)?;
        let out = &port::widget_visible_key(snapshot)?;
        w.string16(out);
        Ok(())
    })
}
