//! Replays the cases rust-anything recorded from `shared/` TS modules that no longer exist (their
//! parity crates were `rust/<unit>-rs`, deleted with the TS at the Tauri cutover). Each case in
//! `tests/cases/<unit>.jsonl.gz` is one call the TS original answered; it runs here through the
//! same delegation the crate's `src/port.rs` used (the `<unit>.rs` modules), with the arguments and
//! results crossing as the napi bindings carried them, and passes as `rust-anything diff` passed
//! it: an equal result, or both sides throwing (error messages were never part of the contract).

mod adaptive_plan;
mod args;
mod extension_auth;
#[allow(dead_code)]
mod js;
mod limit_calibration;
#[allow(dead_code)]
mod parity_args;
mod statusline;
mod tray_panel;
#[allow(dead_code)]
mod utf16;
mod widget_snapshot;

use std::io::{BufRead, BufReader};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;

use serde_json::{Map, Value};

type Outcome = Result<Value, String>;

// ---- the recorded values, as the bindings carried them

fn marker<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    value.as_object().filter(|o| o.len() == 1)?.get(name)
}

fn undefined() -> Value {
    js::undefined()
}

fn nullish(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.is_null() || js::is_undefined(v))
}

/// A JS number from its recorded form (`{"$num": "NaN"}` for what JSON cannot hold).
fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        _ => match marker(value, "$num")?.as_str()? {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            text => text.parse().ok(),
        },
    }
}

/// A JS number as the recordings write it.
fn number(n: f64) -> Value {
    js::number(n)
}

/// What a recorded value becomes once decoded into JS and encoded again (by `index.cjs` for an
/// argument, by the harness for a result): markers in their canonical form, and `$object` (a plain
/// object that looks like a marker) unwrapped.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        Value::Object(o) if o.len() == 1 => {
            let (key, inner) = o.iter().next().unwrap();
            match key.as_str() {
                "$num" => number(number_of(value).unwrap_or(f64::NAN)),
                "$object" => match inner {
                    Value::Object(fields) => Value::Object(
                        fields.iter().map(|(k, v)| (k.clone(), canonical(v))).collect(),
                    ),
                    other => other.clone(),
                },
                "$utf16" => js::string_units(value)
                    .map_or_else(|| value.clone(), |units| js::utf16_string(&units)),
                "$map" => {
                    let entries = inner.as_array().map(|entries| {
                        entries
                            .iter()
                            .map(|pair| match pair {
                                Value::Array(kv) => Value::Array(kv.iter().map(canonical).collect()),
                                other => other.clone(),
                            })
                            .collect()
                    });
                    entries.map_or_else(|| value.clone(), |e| serde_json::json!({ "$map": Value::Array(e) }))
                }
                "$set" => inner.as_array().map_or_else(
                    || value.clone(),
                    |items| serde_json::json!({ "$set": items.iter().map(canonical).collect::<Vec<_>>() }),
                ),
                "$undefined" | "$bigint" | "$date" | "$bytes" | "$buffer" => value.clone(),
                _ => Value::Object(
                    o.iter().map(|(k, v)| (k.clone(), canonical(v))).collect(),
                ),
            }
        }
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, v)| (k.clone(), canonical(v))).collect())
        }
        other => other.clone(),
    }
}

/// `JSON.stringify(a) === JSON.stringify(b)` for encoded values: key order counts, and a number
/// is its value however JSON spelled it.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| same(x, y))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((kx, vx), (ky, vy))| kx == ky && same(vx, vy))
        }
        _ => a == b,
    }
}

// ---- arguments, as napi converts them

/// The arguments of one call, read the way each binding parameter takes them.
struct Args<'a>(&'a [Value]);

impl Args<'_> {
    fn raw(&self, i: usize) -> Option<&Value> {
        self.0.get(i)
    }

    /// A structured argument: JSON text from `index.cjs` (`undefined` when omitted).
    fn json(&self, i: usize) -> Value {
        self.raw(i).map_or_else(undefined, canonical)
    }

    /// A structured argument read as `Option<Value>`: JSON `null` is `None`.
    fn json_opt(&self, i: usize) -> Option<Value> {
        Some(self.json(i)).filter(|v| !v.is_null())
    }

    /// A structured argument read as `Vec<Value>`: anything but an array is a `TypeError`.
    fn json_list(&self, i: usize) -> Result<Vec<Value>, String> {
        match self.json(i) {
            Value::Array(items) => Ok(items),
            _ => Err("TypeError: invalid type, expected a sequence".into()),
        }
    }

    fn f64(&self, i: usize) -> Result<f64, String> {
        self.raw(i)
            .and_then(number_of)
            .ok_or_else(|| format!("argument {} is not a number", i + 1))
    }

    fn f64_opt(&self, i: usize) -> Result<Option<f64>, String> {
        if nullish(self.raw(i)) {
            return Ok(None);
        }
        self.f64(i).map(Some)
    }

    fn string(&self, i: usize) -> Result<String, String> {
        match self.raw(i) {
            Some(Value::String(s)) => Ok(s.clone()),
            _ => Err(format!("argument {} is not a string", i + 1)),
        }
    }

    fn string_opt(&self, i: usize) -> Result<Option<String>, String> {
        if nullish(self.raw(i)) {
            return Ok(None);
        }
        self.string(i).map(Some)
    }

    fn strings(&self, i: usize) -> Result<Vec<String>, String> {
        match self.raw(i) {
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect::<Option<_>>()
                .ok_or_else(|| format!("argument {} is not an array of strings", i + 1)),
            _ => Err(format!("argument {} is not an array", i + 1)),
        }
    }

    fn bool(&self, i: usize) -> Result<bool, String> {
        self.raw(i)
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("argument {} is not a boolean", i + 1))
    }
}

// ---- results, as the harness encoded them

/// A structured result: JSON decoded by `index.cjs`, then encoded.
fn json(out: Result<impl serde::Serialize, String>) -> Outcome {
    let value = serde_json::to_value(out?).map_err(|e| e.to_string())?;
    Ok(canonical(&value))
}

/// An optional structured result: `None` is `undefined`, as the binary wire returned it.
fn json_opt(out: Result<Option<Value>, String>) -> Outcome {
    out?.map_or_else(|| Ok(undefined()), |value| json(Ok(value)))
}

fn num(out: Result<f64, String>) -> Outcome {
    out.map(number)
}

fn plain(out: Result<impl Into<Value>, String>) -> Outcome {
    out.map(Into::into)
}

// ---- the units

fn adaptive_plan(name: &str, a: &Args) -> Option<Outcome> {
    use adaptive_plan as p;
    Some(match name {
        "plannedRate" => (|| num(p::planned_rate(a.json(0), a.json(1), a.json_list(2)?)))(),
        "paceFactor" => (|| num(p::pace_factor(a.f64_opt(0)?, a.f64(1)?)))(),
        "todaysPace" => json(p::todays_pace(a.json(0))),
        "nextStartCandidates" => (|| {
            let out = p::next_start_candidates(a.json(0), a.f64(1)?, a.f64(2)?)?;
            Ok(Value::Array(out.into_iter().map(number).collect()))
        })(),
        "replanStarts" => json_opt(p::replan_starts(a.json(0))),
        _ => return None,
    })
}

fn extension_auth(name: &str, a: &Args) -> Option<Outcome> {
    use extension_auth as p;
    Some(match name {
        "isAccountUuid" => plain(p::is_account_uuid(a.json(0))),
        "withoutFailure" => json(p::without_failure(a.json(0))),
        "sessionExpired" => plain(p::session_expired(a.json(0))),
        "isSignInEntry" => (|| plain(p::is_sign_in_entry(a.string(0)?, a.string(1)?)))(),
        "holdsToken" => plain(p::holds_token(a.json(0))),
        "namedAccount" => json(p::named_account(a.json(0), a.json(1))),
        "namesOtherAccount" => plain(p::names_other_account(a.json(0), a.json(1))),
        "pickSignIn" => json(p::pick_sign_in(a.json(0), a.json(1))),
        "sameSignIn" => plain(p::same_sign_in(a.json(0), a.json(1))),
        _ => return None,
    })
}

fn limit_calibration(name: &str, a: &Args) -> Option<Outcome> {
    use limit_calibration as p;
    Some(match name {
        "slotCostBetween" => (|| {
            num(p::slot_cost_between(
                a.json(0),
                a.strings(1)?,
                a.f64(2)?,
                a.f64(3)?,
                a.string(4)?,
                a.json_opt(5),
            ))
        })(),
        "calibrateLimits" => json(p::calibrate_limits(a.json(0))),
        _ => return None,
    })
}

fn statusline(name: &str, a: &Args) -> Option<Outcome> {
    use statusline as p;
    Some(match name {
        "parseStatuslineInput" => (|| json(p::parse_statusline_input(a.string_opt(0)?)))(),
        "parseStatuslineSnapshot" => (|| json(p::parse_statusline_snapshot(a.string_opt(0)?)))(),
        "claudeSignIn" => (|| json(p::claude_sign_in(a.string_opt(0)?)))(),
        "renderStatuslineLine" => (|| {
            plain(p::render_statusline_line(
                a.string(0)?,
                a.string(1)?,
                a.string_opt(2)?,
                a.json(3),
                a.f64(4)?,
                a.bool(5)?,
            ))
        })(),
        "statuslineAccountId" => (|| {
            json_opt(p::statusline_account_id(
                a.string(0)?,
                a.string(1)?,
                a.string_opt(2)?,
                a.json(3),
            ))
        })(),
        _ => return None,
    })
}

fn tray_panel(name: &str, a: &Args) -> Option<Outcome> {
    use tray_panel as p;
    Some(match name {
        "panelPosition" => json(p::panel_position(a.json(0), a.json(1), a.json(2))),
        "clampPanelHeight" => (|| json(p::clamp_panel_height(a.f64(0)?, a.f64(1)?)))(),
        "pointerOnTray" => (|| json(p::pointer_on_tray(a.json_opt(0), a.json(1), a.f64_opt(2)?)))(),
        "panelBlurAction" => plain(p::panel_blur_action(a.json(0))),
        "panelOffSpaceAction" => (|| plain(p::panel_off_space_action(a.f64(0)?)))(),
        "pendingOpenDue" => (|| json(p::pending_open_due(a.json_opt(0), a.f64(1)?)))(),
        "trayClickAction" => (|| plain(p::tray_click_action(a.bool(0)?)))(),
        "panelLoadState" => (|| json(p::panel_load_state(a.json(0), a.string(1)?)))(),
        "panelRevival" => {
            p::panel_revival(a.json(0)).map(|out| out.map_or_else(undefined, Value::String))
        }
        _ => return None,
    })
}

/// `new ToggleGuard()`, then each recorded call on it.
fn toggle_guard(calls: &[Value]) -> Vec<Outcome> {
    let mut guard = match tray_panel::ToggleGuard::new() {
        Ok(guard) => guard,
        Err(e) => return vec![Err(e)],
    };
    let mut results = vec![Ok(Value::Bool(true))];
    for call in calls {
        let args = call["args"].as_array().map_or(&[][..], Vec::as_slice);
        let a = Args(args);
        results.push(match call["method"].as_str() {
            Some("shouldOpen") => (|| json(guard.should_open(a.f64(0)?)))(),
            Some("hidden") => (|| json(guard.hidden(a.f64(0)?, a.json_opt(1))))(),
            other => panic!("ToggleGuard has no method {other:?}"),
        });
    }
    results
}

fn widget_snapshot(name: &str, a: &Args) -> Option<Outcome> {
    use widget_snapshot as p;
    Some(match name {
        "widgetMood" => plain(p::widget_mood(a.json(0), a.json_opt(1))),
        "widgetCountdown" => (|| json(p::widget_countdown(a.f64_opt(0)?, a.f64(1)?)))(),
        "buildWidgetSnapshot" => json(p::build_widget_snapshot(a.json(0))),
        "widgetVisibleKey" => plain(p::widget_visible_key(a.json(0))),
        _ => return None,
    })
}

// ---- the replay

type Unit = fn(&str, &Args) -> Option<Outcome>;

/// Whether `got` passes for a recorded `{ok}` or `{error}`: an equal result, or both throwing.
fn agrees(want: &Map<String, Value>, got: &Result<Outcome, String>) -> bool {
    match got {
        Err(_) => false,
        Ok(Err(_)) => want.contains_key("error"),
        Ok(Ok(value)) => want.get("ok").is_some_and(|ok| same(ok, value)),
    }
}

/// Runs `f`, a panic counting as a failure (`rust-anything diff` never let one pass).
fn guarded<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f)).map_err(|_| "Rust panic".to_string())
}

fn replay(unit: &str, call: Unit) {
    let file = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/cases")
        .join(format!("{unit}.jsonl.gz"));
    let reader = BufReader::new(flate2::read::GzDecoder::new(
        std::fs::File::open(&file).unwrap_or_else(|e| panic!("{}: {e}", file.display())),
    ));
    let (mut total, mut failures) = (0, Vec::new());
    for line in reader.lines() {
        let line = line.unwrap();
        if line.is_empty() {
            continue;
        }
        total += 1;
        let case: Map<String, Value> = serde_json::from_str(&line).unwrap();
        let pass = if let Some(class) = case.get("class").and_then(Value::as_str) {
            assert_eq!(class, "ToggleGuard", "{unit}: unknown class");
            let calls = case["calls"].as_array().unwrap();
            let want = case["results"].as_array().unwrap();
            match guarded(|| toggle_guard(calls)) {
                Ok(got) => {
                    want.len() == got.len()
                        && want
                            .iter()
                            .zip(got)
                            .all(|(w, g)| agrees(w.as_object().unwrap(), &Ok(g)))
                }
                Err(_) => false,
            }
        } else {
            let name = case["fn"].as_str().unwrap();
            let args = case["args"].as_array().unwrap();
            let got = guarded(|| call(name, &Args(args)))
                .map(|out| out.unwrap_or_else(|| panic!("{unit}: no function {name}")));
            agrees(&case, &got)
        };
        if !pass && failures.len() < 10 {
            failures.push(line);
        }
        if !pass && failures.len() >= 10 {
            break;
        }
    }
    assert!(total > 0, "{unit}: no cases");
    assert!(
        failures.is_empty(),
        "{unit}: cases that do not replay:\n{}",
        failures.join("\n")
    );
}

#[test]
fn adaptive_plan_cases() {
    replay("adaptive-plan", adaptive_plan);
}

#[test]
fn extension_auth_cases() {
    replay("extension-auth", extension_auth);
}

#[test]
fn limit_calibration_cases() {
    replay("limit-calibration", limit_calibration);
}

#[test]
fn statusline_cases() {
    replay("statusline", statusline);
}

#[test]
fn tray_panel_cases() {
    replay("tray-panel", tray_panel);
}

#[test]
fn widget_snapshot_cases() {
    replay("widget-snapshot", widget_snapshot);
}
