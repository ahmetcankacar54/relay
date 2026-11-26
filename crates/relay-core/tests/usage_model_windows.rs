//! Port of `tests/usage-model-windows.test.ts`.

use relay_core::shared::types::ModelWindow;
use relay_core::usage::parse_usage;
use serde_json::json;

fn window(
    key: &str,
    label: &str,
    model: Option<&str>,
    used: f64,
    resets: Option<&str>,
) -> ModelWindow {
    ModelWindow {
        key: key.into(),
        label: label.into(),
        used_percent: used,
        resets_at: resets.map(str::to_owned),
        model: model.map(str::to_owned),
        weekly_share: None,
        period: None,
        source: None,
        read_at: None,
    }
}

#[test]
fn model_specific_windows_are_exposed_with_readable_labels() {
    let reset = "2026-10-18T06:00:00.000Z";
    let usage = parse_usage(&json!({
        "five_hour": { "utilization": 10, "resets_at": reset },
        "seven_day": { "utilization": 53, "resets_at": reset },
        "seven_day_opus": { "utilization": 7, "resets_at": reset },
        "seven_day_claude_design": { "utilization": 100, "resets_at": reset },
        "seven_day_sonnet": null,
    }))
    .unwrap();
    assert_eq!(
        usage.model_windows,
        Some(vec![
            window(
                "seven_day_claude_design",
                "Claude Design",
                None,
                100.0,
                Some(reset)
            ),
            window("seven_day_opus", "Opus", Some("opus"), 7.0, Some(reset)),
        ])
    );
    assert_eq!(usage.other_limit_reached, Some(true));
    assert_eq!(
        parse_usage(&json!({ "five_hour": { "utilization": 1 } }))
            .unwrap()
            .model_windows,
        None
    );
}

#[test]
fn malformed_model_windows_are_skipped_without_failing_the_usage_read() {
    let usage = parse_usage(&json!({
        "five_hour": { "utilization": 10 },
        "seven_day": { "utilization": 20 },
        "seven_day_x": { "utilization": 105 },
        "seven_day_y": "bad",
        "seven_day_z": { "utilization": 5, "resets_at": "nope" },
        "seven_day_ok": { "utilization": 3 },
    }))
    .unwrap();
    assert_eq!(usage.five_hour.as_ref().map(|w| w.used_percent), Some(10.0));
    assert_eq!(usage.seven_day.as_ref().map(|w| w.used_percent), Some(20.0));
    let windows = usage.model_windows.unwrap();
    assert_eq!(windows, vec![window("seven_day_ok", "Ok", None, 3.0, None)]);
    // `"resetsAt" in window` is false: the key is absent, not undefined.
    let serialized = serde_json::to_value(&windows[0]).unwrap();
    assert!(serialized.get("resetsAt").is_none());
}

#[test]
fn a_weekly_limit_scoped_to_one_model_comes_from_the_answer_s_limits_list_fable_2026_11_14() {
    let reset = "2026-11-15T05:00:00.042595+00:00";
    // The shape the usage endpoint answered with on 2026-11-14; the old fields carry no Fable key.
    let usage = parse_usage(&json!({
        "five_hour": { "utilization": 20, "resets_at": "2026-11-14T01:00:00+00:00" },
        "seven_day": { "utilization": 80, "resets_at": reset },
        "seven_day_opus": null,
        "limits": [
            { "kind": "session", "group": "session", "percent": 20, "resets_at": "2026-11-14T01:00:00+00:00", "scope": null },
            { "kind": "weekly_all", "group": "weekly", "percent": 80, "resets_at": reset, "scope": null },
            { "kind": "weekly_scoped", "group": "weekly", "percent": 100, "severity": "critical", "resets_at": reset, "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null } },
            { "kind": "weekly_scoped", "group": "weekly", "percent": "bad", "scope": { "model": { "display_name": "Broken" } } },
        ],
        "weekly_scoped_shares": [{ "limit_index": 2, "used_percent_of_weekly": 50, "allowance_percent_of_weekly": 50 }],
    }))
    .unwrap();
    let mut fable = window(
        "seven_day_fable",
        "Fable",
        Some("fable"),
        100.0,
        Some("2026-11-15T05:00:00.042Z"),
    );
    fable.weekly_share = Some(50.0);
    assert_eq!(usage.model_windows, Some(vec![fable]));
    assert_eq!(
        usage.other_limit_reached,
        Some(true),
        "a spent Fable week stops Fable work"
    );
    assert_eq!(usage.seven_day.as_ref().map(|w| w.used_percent), Some(80.0));

    let roomy = parse_usage(&json!({
        "five_hour": { "utilization": 0, "resets_at": null },
        "seven_day": { "utilization": 27, "resets_at": reset },
        "limits": [{ "kind": "weekly_scoped", "group": "weekly", "percent": 12, "resets_at": reset, "scope": { "model": { "display_name": "Fable" } } }],
    }))
    .unwrap();
    assert_eq!(
        roomy
            .model_windows
            .as_ref()
            .and_then(|w| w.first())
            .map(|w| w.used_percent),
        Some(12.0)
    );
    assert_eq!(roomy.other_limit_reached, None);
}
