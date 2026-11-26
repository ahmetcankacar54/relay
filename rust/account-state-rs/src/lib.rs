//! JS bindings for `shared/account-state.ts`: generated from the signatures in `port.rs` by rust-anything.
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

/// `displayedIssue`.
#[napi(js_name = "displayedIssue")]
pub fn displayed_issue(usage: String) -> napi::Result<String> {
    run(move || {
        let usage = crate::js::from_json(&usage)?;
        let out = port::displayed_issue(usage)?;
        crate::js::to_json(&out)
    })
}

/// `readsThroughApp`.
#[napi(js_name = "readsThroughApp")]
pub fn reads_through_app(account: String, usage: String) -> napi::Result<String> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let usage = crate::js::from_json(&usage)?;
        let out = port::reads_through_app(account, usage)?;
        crate::js::to_json(&out)
    })
}

/// `cliNeedsReconnect`.
#[napi(js_name = "cliNeedsReconnect")]
pub fn cli_needs_reconnect(account: String, usage: String) -> napi::Result<String> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let usage = crate::js::from_json(&usage)?;
        let out = port::cli_needs_reconnect(account, usage)?;
        crate::js::to_json(&out)
    })
}

/// `duplicateCliAccount`.
#[napi(js_name = "duplicateCliAccount")]
pub fn duplicate_cli_account(account: String, accounts: String) -> napi::Result<String> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let accounts = crate::js::from_json(&accounts)?;
        let out = port::duplicate_cli_account(account, accounts)?;
        crate::js::to_json(&out)
    })
}

/// `desktopCliMismatch`.
#[napi(js_name = "desktopCliMismatch")]
pub fn desktop_cli_mismatch(account: String) -> napi::Result<String> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let out = port::desktop_cli_mismatch(account)?;
        crate::js::to_json(&out)
    })
}

/// `desktopCliWorkspaceMismatch`.
#[napi(js_name = "desktopCliWorkspaceMismatch")]
pub fn desktop_cli_workspace_mismatch(account: String) -> napi::Result<String> {
    run(move || {
        let account = crate::js::from_json(&account)?;
        let out = port::desktop_cli_workspace_mismatch(account)?;
        crate::js::to_json(&out)
    })
}

/// `pendingAuth`.
#[napi(js_name = "pendingAuth")]
pub fn pending_auth(flow: String) -> napi::Result<String> {
    run(move || {
        let flow = crate::js::from_json(&flow)?;
        let out = port::pending_auth(flow)?;
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

static S_DISPLAYED_ISSUE_OUT: wire::Schema = wire::Schema::Dyn;

/// `displayedIssue` over the binary wire.
#[napi(js_name = "displayedIssueWire")]
pub fn displayed_issue_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::displayed_issue(usage)?;
        wire::write_value(w, out, &S_DISPLAYED_ISSUE_OUT)?;
        Ok(())
    })
}

static S_READS_THROUGH_APP_0: wire::Schema = wire::Schema::Dyn;
static S_READS_THROUGH_APP_OUT: wire::Schema = wire::Schema::Dyn;

/// `readsThroughApp` over the binary wire.
#[napi(js_name = "readsThroughAppWire")]
pub fn reads_through_app_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_READS_THROUGH_APP_0)?;
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::reads_through_app(account, usage)?;
        wire::write_value(w, out, &S_READS_THROUGH_APP_OUT)?;
        Ok(())
    })
}

static S_CLI_NEEDS_RECONNECT_0: wire::Schema = wire::Schema::Dyn;
static S_CLI_NEEDS_RECONNECT_OUT: wire::Schema = wire::Schema::Dyn;

/// `cliNeedsReconnect` over the binary wire.
#[napi(js_name = "cliNeedsReconnectWire")]
pub fn cli_needs_reconnect_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_CLI_NEEDS_RECONNECT_0)?;
        let usage: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::cli_needs_reconnect(account, usage)?;
        wire::write_value(w, out, &S_CLI_NEEDS_RECONNECT_OUT)?;
        Ok(())
    })
}

static S_DUPLICATE_CLI_ACCOUNT_0: wire::Schema = wire::Schema::Dyn;
static S_DUPLICATE_CLI_ACCOUNT_1: wire::Schema = wire::Schema::List(&wire::Schema::Obj(&[
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
static S_DUPLICATE_CLI_ACCOUNT_OUT: wire::Schema = wire::Schema::Dyn;

/// `duplicateCliAccount` over the binary wire.
#[napi(js_name = "duplicateCliAccountWire")]
pub fn duplicate_cli_account_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_DUPLICATE_CLI_ACCOUNT_0)?;
        let accounts: Vec<serde_json::Value> =
            r.list(|r| wire::read_value(r, S_DUPLICATE_CLI_ACCOUNT_1.inner()))?;
        let out = &port::duplicate_cli_account(account, accounts)?;
        wire::write_value(w, out, &S_DUPLICATE_CLI_ACCOUNT_OUT)?;
        Ok(())
    })
}

static S_DESKTOP_CLI_MISMATCH_0: wire::Schema = wire::Schema::Dyn;
static S_DESKTOP_CLI_MISMATCH_OUT: wire::Schema = wire::Schema::Dyn;

/// `desktopCliMismatch` over the binary wire.
#[napi(js_name = "desktopCliMismatchWire")]
pub fn desktop_cli_mismatch_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_DESKTOP_CLI_MISMATCH_0)?;
        let out = &port::desktop_cli_mismatch(account)?;
        wire::write_value(w, out, &S_DESKTOP_CLI_MISMATCH_OUT)?;
        Ok(())
    })
}

static S_DESKTOP_CLI_WORKSPACE_MISMATCH_0: wire::Schema = wire::Schema::Dyn;
static S_DESKTOP_CLI_WORKSPACE_MISMATCH_OUT: wire::Schema = wire::Schema::Dyn;

/// `desktopCliWorkspaceMismatch` over the binary wire.
#[napi(js_name = "desktopCliWorkspaceMismatchWire")]
pub fn desktop_cli_workspace_mismatch_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let account: serde_json::Value = wire::read_value(r, &S_DESKTOP_CLI_WORKSPACE_MISMATCH_0)?;
        let out = &port::desktop_cli_workspace_mismatch(account)?;
        wire::write_value(w, out, &S_DESKTOP_CLI_WORKSPACE_MISMATCH_OUT)?;
        Ok(())
    })
}

static S_PENDING_AUTH_OUT: wire::Schema = wire::Schema::Dyn;

/// `pendingAuth` over the binary wire.
#[napi(js_name = "pendingAuthWire")]
pub fn pending_auth_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let flow: Option<serde_json::Value> = wire::read_dyn_opt(r)?;
        let out = &port::pending_auth(flow)?;
        wire::write_value(w, out, &S_PENDING_AUTH_OUT)?;
        Ok(())
    })
}
