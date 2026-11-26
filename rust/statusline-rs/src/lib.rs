//! JS bindings for `shared/statusline.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `parseStatuslineInput`.
#[napi(js_name = "parseStatuslineInput")]
pub fn parse_statusline_input(text: Option<String>) -> napi::Result<String> {
    run(move || {
        let out = port::parse_statusline_input(text)?;
        crate::js::to_json(&out)
    })
}

/// `parseStatuslineSnapshot`.
#[napi(js_name = "parseStatuslineSnapshot")]
pub fn parse_statusline_snapshot(text: Option<String>) -> napi::Result<String> {
    run(move || {
        let out = port::parse_statusline_snapshot(text)?;
        crate::js::to_json(&out)
    })
}

/// `claudeSignIn`.
#[napi(js_name = "claudeSignIn")]
pub fn claude_sign_in(text: Option<String>) -> napi::Result<String> {
    run(move || {
        let out = port::claude_sign_in(text)?;
        crate::js::to_json(&out)
    })
}

/// `renderStatuslineLine`.
#[napi(js_name = "renderStatuslineLine")]
pub fn render_statusline_line(
    snapshot_text: String,
    input_text: String,
    config_dir: Option<String>,
    sign_in: String,
    now: f64,
    color: bool,
) -> napi::Result<String> {
    run(move || {
        let sign_in = crate::js::from_json(&sign_in)?;
        let out = port::render_statusline_line(
            snapshot_text,
            input_text,
            config_dir,
            sign_in,
            now,
            color,
        )?;
        Ok(out)
    })
}

/// `statuslineAccountId`.
#[napi(js_name = "statuslineAccountId")]
pub fn statusline_account_id(
    snapshot_text: String,
    input_text: String,
    config_dir: Option<String>,
    sign_in: String,
) -> napi::Result<String> {
    run(move || {
        let sign_in = crate::js::from_json(&sign_in)?;
        let out = port::statusline_account_id(snapshot_text, input_text, config_dir, sign_in)?;
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

static S_PARSE_STATUSLINE_INPUT_OUT: wire::Schema = wire::Schema::Obj(&[
    ("session_id", wire::Schema::OptJs(&wire::Schema::Str16)),
    (
        "rate_limits",
        wire::Schema::OptJs(&wire::Schema::Obj(&[
            (
                "five_hour",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("used_percentage", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("resets_at", wire::Schema::OptJs(&wire::Schema::Num)),
                ])),
            ),
            (
                "seven_day",
                wire::Schema::OptJs(&wire::Schema::Obj(&[
                    ("used_percentage", wire::Schema::OptJs(&wire::Schema::Num)),
                    ("resets_at", wire::Schema::OptJs(&wire::Schema::Num)),
                ])),
            ),
        ])),
    ),
]);

/// `parseStatuslineInput` over the binary wire.
#[napi(js_name = "parseStatuslineInputWire")]
pub fn parse_statusline_input_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::parse_statusline_input(text)?;
        wire::write_value(w, out, &S_PARSE_STATUSLINE_INPUT_OUT)?;
        Ok(())
    })
}

static S_PARSE_STATUSLINE_SNAPSHOT_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("version", wire::Schema::Dyn),
    ("generatedAt", wire::Schema::Num),
    ("formatLocale", wire::Schema::Str16),
    ("profiles", wire::Schema::Str16),
    (
        "desktopAccountId",
        wire::Schema::OptJs(&wire::Schema::Str16),
    ),
    ("terminalFollows", wire::Schema::Bool),
    (
        "accounts",
        wire::Schema::List(&wire::Schema::Obj(&[
            ("id", wire::Schema::Str16),
            ("name", wire::Schema::Str16),
            ("identities", wire::Schema::List(&wire::Schema::Dyn)),
            ("fiveHour", wire::Schema::Dyn),
            ("week", wire::Schema::Dyn),
        ])),
    ),
    (
        "gateway",
        wire::Schema::OptJs(&wire::Schema::Obj(&[(
            "sessions",
            wire::Schema::Map16(&wire::Schema::Str16),
        )])),
    ),
    (
        "text",
        wire::Schema::Obj(&[
            ("fiveHour", wire::Schema::Str16),
            ("week", wire::Schema::Str16),
            ("viaGateway", wire::Schema::Str16),
            ("updatedAgo", wire::Schema::Str16),
        ]),
    ),
]));

/// `parseStatuslineSnapshot` over the binary wire.
#[napi(js_name = "parseStatuslineSnapshotWire")]
pub fn parse_statusline_snapshot_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::parse_statusline_snapshot(text)?;
        wire::write_value(w, out, &S_PARSE_STATUSLINE_SNAPSHOT_OUT)?;
        Ok(())
    })
}

static S_CLAUDE_SIGN_IN_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("accountUuid", wire::Schema::Str16),
    ("orgId", wire::Schema::Str16),
]));

/// `claudeSignIn` over the binary wire.
#[napi(js_name = "claudeSignInWire")]
pub fn claude_sign_in_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let text: Option<String> = r.opt_js(|r| r.string16())?;
        let out = &port::claude_sign_in(text)?;
        wire::write_value(w, out, &S_CLAUDE_SIGN_IN_OUT)?;
        Ok(())
    })
}

static S_RENDER_STATUSLINE_LINE_3: wire::Schema = wire::Schema::Dyn;

/// `renderStatuslineLine` over the binary wire.
#[napi(js_name = "renderStatuslineLineWire")]
pub fn render_statusline_line_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot_text: String = r.string16()?;
        let input_text: String = r.string16()?;
        let config_dir: Option<String> = r.opt_js(|r| r.string16())?;
        let sign_in: Value = wire::read_value(r, &S_RENDER_STATUSLINE_LINE_3)?;
        let now: f64 = r.f64()?;
        let color: bool = r.bool()?;
        let out = &port::render_statusline_line(
            snapshot_text,
            input_text,
            config_dir,
            sign_in,
            now,
            color,
        )?;
        w.string16(out);
        Ok(())
    })
}

static S_STATUSLINE_ACCOUNT_ID_3: wire::Schema = wire::Schema::Dyn;
static S_STATUSLINE_ACCOUNT_ID_OUT: wire::Schema = wire::Schema::OptJs(&wire::Schema::Obj(&[
    ("accountId", wire::Schema::OptJs(&wire::Schema::Str16)),
    ("viaGateway", wire::Schema::Bool),
]));

/// `statuslineAccountId` over the binary wire.
#[napi(js_name = "statuslineAccountIdWire")]
pub fn statusline_account_id_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let snapshot_text: String = r.string16()?;
        let input_text: String = r.string16()?;
        let config_dir: Option<String> = r.opt_js(|r| r.string16())?;
        let sign_in: Value = wire::read_value(r, &S_STATUSLINE_ACCOUNT_ID_3)?;
        let out = &port::statusline_account_id(snapshot_text, input_text, config_dir, sign_in)?;
        match out {
            Some(x0) => {
                w.tag(1);
                wire::write_value(w, x0, S_STATUSLINE_ACCOUNT_ID_OUT.inner())?;
            }
            None => w.tag(0),
        }
        Ok(())
    })
}
