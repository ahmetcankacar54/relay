//! The Rust port of `shared/mascot.ts`, delegating to `relay_core::shared::mascot`.
//!
//! Only argument and result conversion lives here: the JSON the bindings carry becomes the
//! relay-core types, and their results become what the TS returns. A missing `now` is
//! `Date.now()`, read from the pinned clock while rust-anything records and diffs.

#![forbid(unsafe_code)]

mod args;
mod pinned;

use relay_core::shared::mascot::{self, MascotPose};
use relay_core::shared::tray::TraySnapshot;
use serde_json::Value;

use args::{arg, plain};

/// `now = Date.now()`.
fn now_or_clock(now: Option<Value>) -> Result<f64, String> {
    match now.and_then(plain) {
        None => Ok(pinned::now_ms()),
        Some(n) => crate::js::as_number(&n).ok_or_else(|| format!("TypeError: now is {n}")),
    }
}

/// The `MascotInput` (a tray snapshot carries the same fields, and more). An account cast from a
/// partial object (`{ id, name } as Account`, as `menuBarPreview` builds one) gets empty values for
/// the fields the panda never reads.
fn input(value: &Value) -> Result<TraySnapshot, String> {
    let mut value = value.clone();
    if let Some(accounts) = value.get_mut("accounts").and_then(Value::as_array_mut) {
        for account in accounts.iter_mut().filter_map(Value::as_object_mut) {
            account
                .entry("kind")
                .or_insert_with(|| Value::from("personal"));
            for key in ["group", "color", "createdAt"] {
                account.entry(key).or_insert_with(|| Value::from(""));
            }
        }
    }
    arg(value)
}

/// Port of `activeReading` (`shared/mascot.ts:36`): the caller's own reading object, with
/// `status: "ready"` in place of `"loading"`, as the TS spreads it.
pub fn active_reading(
    input_value: serde_json::Value,
    now: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, String> {
    let snapshot = input(&input_value)?;
    let Some(reading) = mascot::active_reading(snapshot.mascot_input(), now_or_clock(now)?) else {
        return Ok(None);
    };
    let id = &reading.account_id;
    let own = snapshot
        .desktop
        .as_ref()
        .and_then(|d| d.active_profile_id.as_deref())
        .and_then(|active| plain(input_value["usage"][active].clone()));
    let mut raw = own.ok_or_else(|| format!("no reading for {id}"))?;
    raw["status"] = Value::from(reading.status.as_str());
    Ok(Some(raw))
}

/// Port of `mascotRest` (`shared/mascot.ts:50`).
pub fn mascot_rest(
    input_value: serde_json::Value,
    now: Option<serde_json::Value>,
) -> Result<Option<String>, String> {
    let snapshot = input(&input_value)?;
    Ok(
        mascot::mascot_rest(snapshot.mascot_input(), now_or_clock(now)?)
            .map(|rest| rest.as_str().to_string()),
    )
}

/// Port of `activeFull` (`shared/mascot.ts:64`).
pub fn active_full(
    input_value: serde_json::Value,
    now: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let snapshot = input(&input_value)?;
    Ok(Value::Bool(mascot::active_full(
        snapshot.mascot_input(),
        now_or_clock(now)?,
    )))
}

/// Port of `mascotPose` (`shared/mascot.ts:69`).
pub fn mascot_pose(
    input_value: serde_json::Value,
    now: Option<serde_json::Value>,
) -> Result<String, String> {
    let snapshot = input(&input_value)?;
    Ok(
        mascot::mascot_pose(snapshot.mascot_input(), now_or_clock(now)?)
            .as_str()
            .to_string(),
    )
}

/// Port of `headFor` (`shared/mascot.ts:107`): a string that is no pose falls to the idle head,
/// as the TS conditional does.
pub fn head_for(pose: String) -> Result<String, String> {
    let head = serde_json::from_value::<MascotPose>(Value::String(pose))
        .map_or("idle", |pose| mascot::head_for(pose).as_str());
    Ok(head.to_string())
}
