//! Port of `tests/token-usage-view.test.ts`.

#[path = "common/shared_views.rs"]
mod helpers;

use helpers::{from_json, named, to_json};
use relay_core::shared::token_usage_view::{
    LedgerSnapshot, TokenCounts, TokenRowKind, TokenUsageInput, TokenUsageView,
    build_token_usage_view, token_row_label,
};
use relay_core::shared::types::Account;
use relay_core::shared::types::js::date_parse;
use relay_core::shared::usage_statistics_view::FORMER_KEY;
use relay_i18n::{Args, Locale, translate};
use serde_json::{Value, json};

const ZONE: &str = "Europe/Istanbul";
// Wednesday 2026-10-14 15:00 in Istanbul (UTC+3).
fn now() -> f64 {
    date_parse("2026-10-14T12:00:00.000Z")
}

fn accounts() -> Vec<Account> {
    vec![named("ann", "Ann", "pro"), named("bob", "Bob", "pro")]
}

fn counts5(
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
    responses: f64,
) -> TokenCounts {
    TokenCounts {
        input,
        output,
        cache_write,
        cache_read,
        responses,
        cost: Some(0.0),
        unpriced: Some(0.0),
        cost_estimated: None,
    }
}
fn counts(input: f64) -> TokenCounts {
    counts5(input, 0.0, 0.0, 0.0, 1.0)
}
/// `counts(...)` as the JSON the TS compares.
fn cj(c: TokenCounts) -> Value {
    to_json(&c)
}
/// `{ ...counts(...), estimated }`.
fn cell(c: TokenCounts, estimated: bool) -> Value {
    let mut value = to_json(&c);
    value["estimated"] = json!(estimated);
    value
}

fn ledger_with(days: Value, progress: Value) -> LedgerSnapshot {
    let mut p = json!({ "scannedBytes": 100, "totalBytes": 100, "complete": true });
    for (k, v) in progress.as_object().unwrap() {
        p[k] = v.clone();
    }
    from_json(json!({ "days": days, "progress": p }))
}
fn ledger(days: Value) -> LedgerSnapshot {
    ledger_with(days, json!({}))
}

/// `build(snapshot, extra)`: the TS defaults, each overridable.
struct Build {
    accounts: Vec<Account>,
    range: u32,
    account_id: Option<&'static str>,
    zone: &'static str,
    now: f64,
    exact_since: Option<f64>,
}

impl Default for Build {
    fn default() -> Self {
        Build {
            accounts: accounts(),
            range: 7,
            account_id: None,
            zone: ZONE,
            now: now(),
            exact_since: None,
        }
    }
}

impl Build {
    fn run(&self, ledger: &LedgerSnapshot) -> TokenUsageView {
        build_token_usage_view(&TokenUsageInput {
            ledger,
            accounts: &self.accounts,
            range: self.range,
            account_id: self.account_id,
            zone: self.zone,
            now: self.now,
            exact_since: self.exact_since,
        })
    }
}

fn build(ledger: &LedgerSnapshot) -> TokenUsageView {
    Build::default().run(ledger)
}

fn by_date(view: &TokenUsageView, date: &str) -> Value {
    to_json(&view.days.iter().find(|d| d.date == date).unwrap().by_row)
}

#[test]
fn days_fill_the_whole_range_oldest_first_ending_today_in_the_zone() {
    let view = build(&ledger(json!({})));
    assert_eq!(view.range, 7);
    let dates: Vec<&str> = view.days.iter().map(|d| d.date.as_str()).collect();
    assert_eq!(
        dates,
        [
            "2026-10-08",
            "2026-10-09",
            "2026-10-10",
            "2026-10-11",
            "2026-10-12",
            "2026-10-13",
            "2026-10-14"
        ]
    );
    assert!(view.days.iter().all(|d| d.by_row.is_empty()));
    assert!(view.rows.is_empty());
    assert!(view.models.is_empty());
    assert_eq!(to_json(&view.totals), cj(counts5(0.0, 0.0, 0.0, 0.0, 0.0)));
}

#[test]
fn today_is_the_date_in_the_zone_not_in_utc_and_month_ends_are_crossed() {
    // 21:30 UTC on 2026-10-31 is 00:30 on 2026-11-01 in Istanbul.
    let view = Build {
        now: date_parse("2026-10-31T21:30:00.000Z"),
        range: 30,
        ..Build::default()
    }
    .run(&ledger(json!({})));
    assert_eq!(view.days.len(), 30);
    assert_eq!(view.days[29].date, "2026-11-01");
    assert_eq!(view.days[0].date, "2026-10-03");
    let ninety = Build {
        range: 90,
        ..Build::default()
    }
    .run(&ledger(json!({})));
    assert_eq!(ninety.days.len(), 90);
    assert_eq!(ninety.days[0].date, "2026-07-17");
    assert_eq!(ninety.days[89].date, "2026-10-14");
}

#[test]
fn days_outside_the_range_are_left_out_of_every_total() {
    let view = build(&ledger(json!({
        "2026-10-07": { "acct:ann": { "m": cj(counts(1000.0)) } },
        "2026-10-14": { "acct:ann": { "m": cj(counts(7.0)) } },
        "2026-10-15": { "acct:ann": { "m": cj(counts(500.0)) } },
    })));
    assert_eq!(view.totals.input, 7.0);
    assert_eq!(view.rows[0].totals.input, 7.0);
}

#[test]
fn acct_and_est_buckets_of_one_account_merge_marked_estimated_where_estimated() {
    let view = build(&ledger(json!({
        "2026-10-12": {
            "acct:ann": { "m": cj(counts5(100.0, 10.0, 5.0, 1.0, 2.0)) },
            "est:ann": { "m": cj(counts5(50.0, 5.0, 0.0, 0.0, 1.0)) },
        },
        "2026-10-13": { "acct:ann": { "m": cj(counts5(20.0, 2.0, 0.0, 0.0, 1.0)) } },
        "2026-10-14": { "est:ann": { "m": cj(counts5(1.0, 1.0, 1.0, 1.0, 1.0)) } },
    })));
    assert_eq!(view.rows.len(), 1);
    let row = &view.rows[0];
    assert_eq!(row.key, "ann");
    assert_eq!(row.kind, TokenRowKind::Account);
    assert_eq!(row.account_id.as_deref(), Some("ann"));
    assert_eq!(row.name.as_deref(), Some("Ann"));
    assert!(row.estimated);
    assert_eq!(
        to_json(&row.totals),
        cj(counts5(171.0, 18.0, 6.0, 2.0, 5.0))
    );
    assert_eq!(
        by_date(&view, "2026-10-12")["ann"],
        cell(counts5(150.0, 15.0, 5.0, 1.0, 3.0), true)
    );
    assert_eq!(
        by_date(&view, "2026-10-13")["ann"],
        cell(counts5(20.0, 2.0, 0.0, 0.0, 1.0), false)
    );
    assert_eq!(
        by_date(&view, "2026-10-14")["ann"]["estimated"],
        json!(true)
    );
    assert_eq!(by_date(&view, "2026-10-11"), json!({}));
}

#[test]
fn an_account_with_only_exact_tokens_is_not_estimated() {
    let view = build(&ledger(
        json!({ "2026-10-13": { "acct:bob": { "m": cj(counts(9.0)) } } }),
    ));
    assert!(!view.rows[0].estimated);
    assert_eq!(view.rows[0].name.as_deref(), Some("Bob"));
}

#[test]
fn ids_that_are_not_relay_accounts_share_one_former_row() {
    let view = build(&ledger(json!({
        "2026-10-12": {
            "acct:gone": { "m": cj(counts(10.0)) },
            "est:gone2": { "m": cj(counts(5.0)) },
        },
        "2026-10-13": { "acct:ann": { "m": cj(counts(1.0)) } },
    })));
    let former = view
        .rows
        .iter()
        .find(|r| r.kind == TokenRowKind::Former)
        .expect("former row");
    assert_eq!(former.key, FORMER_KEY);
    assert_eq!(former.name, None);
    assert_eq!(former.account_id, None);
    assert!(former.estimated);
    assert_eq!(former.totals.input, 15.0);
    assert_eq!(
        view.rows
            .iter()
            .filter(|r| r.kind == TokenRowKind::Former)
            .count(),
        1
    );
    assert_eq!(
        to_json(view.days[4].by_row.get(FORMER_KEY).unwrap()),
        cell(counts5(15.0, 0.0, 0.0, 0.0, 2.0), true)
    );
    assert_eq!(
        translate(
            Locale::Tr,
            token_row_label(TokenRowKind::Former).unwrap(),
            &Args::new()
        ),
        "Eski hesap"
    );
}

#[test]
fn terminal_and_unknown_rows_carry_their_labels_and_are_never_estimated() {
    let view = build(&ledger(json!({
        "2026-10-13": {
            "terminal": { "m": cj(counts(40.0)) },
            "unknown": { "m": cj(counts(30.0)) },
        },
    })));
    let terminal = view
        .rows
        .iter()
        .find(|r| r.kind == TokenRowKind::Terminal)
        .unwrap();
    let unknown = view
        .rows
        .iter()
        .find(|r| r.kind == TokenRowKind::Unknown)
        .unwrap();
    assert_eq!(terminal.key, "terminal");
    assert_eq!(terminal.name, None);
    assert_eq!(terminal.account_id, None);
    assert!(!terminal.estimated);
    assert_eq!(unknown.key, "unknown");
    assert_eq!(unknown.name, None);
    assert!(!unknown.estimated);
    let labels: Vec<(String, String)> = [
        TokenRowKind::Terminal,
        TokenRowKind::Unknown,
        TokenRowKind::Former,
    ]
    .into_iter()
    .map(|kind| {
        let id = token_row_label(kind).unwrap();
        (
            translate(Locale::Tr, id, &Args::new()),
            translate(Locale::En, id, &Args::new()),
        )
    })
    .collect();
    let expected: Vec<(String, String)> = [
        ("Relay dışı terminal", "Terminal outside Relay"),
        ("Hesabı bilinmeyen", "Unknown account"),
        ("Eski hesap", "Former account"),
    ]
    .into_iter()
    .map(|(tr, en)| (tr.to_string(), en.to_string()))
    .collect();
    assert_eq!(labels, expected);
}

#[test]
fn rows_sort_by_total_largest_first_with_unknown_and_terminal_last() {
    let view = build(&ledger(json!({
        "2026-10-12": {
            "terminal": { "m": cj(counts(9000.0)) },
            "unknown": { "m": cj(counts(8000.0)) },
            "acct:ann": { "m": cj(counts5(1.0, 1.0, 1.0, 1.0, 1.0)) },
            "acct:bob": { "m": cj(counts(100.0)) },
            "acct:gone": { "m": cj(counts(50.0)) },
        },
    })));
    let keys: Vec<&str> = view.rows.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, ["bob", FORMER_KEY, "ann", "unknown", "terminal"]);
}

#[test]
fn the_account_filter_keeps_one_account_s_row_and_days() {
    let snapshot = ledger(json!({
        "2026-10-12": {
            "acct:ann": { "m": cj(counts(10.0)) },
            "est:ann": { "m": cj(counts(5.0)) },
            "acct:bob": { "m": cj(counts(100.0)) },
            "terminal": { "m": cj(counts(1000.0)) },
            "unknown": { "m": cj(counts(2000.0)) },
            "acct:gone": { "m": cj(counts(3000.0)) },
        },
    }));
    let view = Build {
        account_id: Some("ann"),
        ..Build::default()
    }
    .run(&snapshot);
    let keys: Vec<&str> = view.rows.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys, ["ann"]);
    assert_eq!(
        to_json(&view.days[4].by_row),
        json!({ "ann": cell(counts5(15.0, 0.0, 0.0, 0.0, 2.0), true) })
    );
    assert_eq!(view.totals.input, 15.0);
    assert_eq!(
        to_json(&view.models),
        json!([{ "model": "m", "totals": cj(counts5(15.0, 0.0, 0.0, 0.0, 2.0)) }])
    );
    let none = Build {
        account_id: Some("nobody"),
        ..Build::default()
    }
    .run(&snapshot);
    assert!(none.rows.is_empty());
    assert_eq!(none.totals.input, 0.0);
}

#[test]
fn models_are_totalled_across_rows_and_days_largest_first() {
    let view = build(&ledger(json!({
        "2026-10-12": {
            "acct:ann": {
                "opus": cj(counts5(10.0, 100.0, 0.0, 0.0, 2.0)),
                "haiku": cj(counts5(1.0, 1.0, 0.0, 0.0, 1.0)),
            },
            "terminal": { "opus": cj(counts5(5.0, 5.0, 0.0, 0.0, 1.0)) },
        },
        "2026-10-13": {
            "est:bob": {
                "sonnet": cj(counts5(50.0, 20.0, 10.0, 10.0, 3.0)),
                "haiku": cj(counts5(2.0, 2.0, 0.0, 0.0, 1.0)),
            },
        },
    })));
    assert_eq!(
        to_json(&view.models),
        json!([
            { "model": "opus", "totals": cj(counts5(15.0, 105.0, 0.0, 0.0, 3.0)) },
            { "model": "sonnet", "totals": cj(counts5(50.0, 20.0, 10.0, 10.0, 3.0)) },
            { "model": "haiku", "totals": cj(counts5(3.0, 3.0, 0.0, 0.0, 2.0)) },
        ])
    );
    assert_eq!(
        to_json(&view.totals),
        cj(counts5(68.0, 128.0, 10.0, 10.0, 8.0))
    );
}

#[test]
fn progress_is_the_scanned_share_whole_and_100_once_complete() {
    let progress = |p: Value| to_json(&build(&ledger_with(json!({}), p)).progress);
    let running = progress(json!({ "scannedBytes": 1, "totalBytes": 3, "complete": false }));
    assert_eq!(running, json!({ "percent": 33, "complete": false }));
    // Never shows 100 before the scan has finished.
    let nearly = progress(json!({ "scannedBytes": 999, "totalBytes": 1000, "complete": false }));
    assert_eq!(nearly, json!({ "percent": 99, "complete": false }));
    let none = progress(json!({ "scannedBytes": 0, "totalBytes": 0, "complete": false }));
    assert_eq!(none, json!({ "percent": 0, "complete": false }));
    // A new pass resets the byte counts but the first scan stays done.
    let done = progress(json!({ "scannedBytes": 10, "totalBytes": 400, "complete": true }));
    assert_eq!(done, json!({ "percent": 100, "complete": true }));
    // A ledger that cannot be saved says so.
    let unsaved = progress(json!({ "error": true }));
    assert_eq!(
        unsaved,
        json!({ "percent": 100, "complete": true, "error": true })
    );
}

#[test]
fn exact_since_is_passed_on_as_a_date_in_the_zone() {
    assert_eq!(build(&ledger(json!({}))).exact_since, None);
    // 22:30 UTC on 2026-10-09 is 01:30 on 2026-10-10 in Istanbul.
    let view = Build {
        exact_since: Some(date_parse("2026-10-09T22:30:00.000Z")),
        ..Build::default()
    }
    .run(&ledger(json!({})));
    assert_eq!(view.exact_since.as_deref(), Some("2026-10-10"));
}

#[test]
fn the_view_carries_only_counts_names_and_ids() {
    let view = build(&ledger(
        json!({ "2026-10-13": { "acct:ann": { "m": cj(counts(1.0)) } } }),
    ));
    let mut keys: Vec<String> = to_json(&view)
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "days",
            "models",
            "pricesChecked",
            "progress",
            "range",
            "rows",
            "today",
            "totals",
            "unpricedModels"
        ]
    );
}

fn slot(cost: f64) -> Value {
    json!({ "input": 0, "output": 0, "cacheWrite": 0, "cacheRead": 0, "cost": cost })
}
fn priced(input: f64, cost: f64, extra: Value) -> Value {
    let mut value = cj(counts(input));
    value["cost"] = json!(cost);
    for (k, v) in extra.as_object().unwrap() {
        value[k] = v.clone();
    }
    value
}
fn snapshot(days: Value, progress: Value, slots: Value, slots_since: f64) -> LedgerSnapshot {
    let mut value = to_json(&ledger_with(days, progress));
    value["slots"] = slots;
    value["slotsSince"] = json!(slots_since);
    from_json(value)
}

#[test]
fn costs_and_unpriced_tokens_add_up_across_rows_days_and_models_and_estimated_costs_are_marked() {
    let view = build(&ledger(json!({
        "2026-10-13": {
            "acct:ann": { "claude-opus-5-5": priced(10.0, 1.5, json!({ "costEstimated": true })) },
        },
        "2026-10-14": {
            "acct:ann": { "claude-opus-5-5": priced(10.0, 2.0, json!({})) },
            "acct:bob": { "mystery": priced(5.0, 0.0, json!({ "unpriced": 5 })) },
        },
    })));
    assert_eq!(view.totals.cost, Some(3.5));
    assert_eq!(view.totals.unpriced, Some(5.0));
    assert_eq!(view.totals.cost_estimated, Some(true));
    assert_eq!(
        view.rows
            .iter()
            .find(|r| r.key == "ann")
            .unwrap()
            .totals
            .cost,
        Some(3.5)
    );
    let n = view.days.len();
    assert_eq!(
        view.days[n - 2]
            .by_row
            .get("ann")
            .unwrap()
            .counts
            .cost_estimated,
        Some(true)
    );
    assert_eq!(
        view.days[n - 1]
            .by_row
            .get("ann")
            .unwrap()
            .counts
            .cost_estimated,
        None
    );
    assert_eq!(view.unpriced_models, ["mystery"]);
    assert_eq!(view.prices_checked, "2026-11-11");
}

#[test]
fn today_s_line_runs_to_the_current_quarter_hour_and_compares_with_yesterday_up_to_the_same_one() {
    let snapshot = snapshot(
        json!({ "2026-10-14": { "acct:ann": { "claude-opus-5-5": priced(100.0, 9.0, json!({})) } } }),
        json!({}),
        json!({
            // 15:00 in Istanbul is quarter hour 60.
            "2026-10-14": { "acct:ann": { "4": slot(2.0), "60": slot(1.0) }, "acct:bob": { "10": slot(3.0) } },
            "2026-10-13": {
                "acct:ann": { "0": slot(1.0), "60": slot(1.0), "95": slot(2.0) },
                "acct:bob": { "1": slot(2.0) },
            },
        }),
        date_parse("2026-10-01T00:00:00Z"),
    );
    let today = build(&snapshot).today;
    assert_eq!(today.date, "2026-10-14");
    assert_eq!(today.current_slot, 60.0);
    assert_eq!(today.totals.cost, Some(9.0));
    assert_eq!(today.slots.len(), 96);
    assert_eq!(today.slots[4], Some(2.0));
    assert_eq!(today.slots[10], Some(3.0));
    assert_eq!(today.slots[60], Some(1.0));
    assert_eq!(today.slots[59], Some(0.0));
    assert_eq!(today.slots[61], None);
    // Today 6 against yesterday's 4 up to 15:00 (the 95th slot comes later).
    assert_eq!(today.change, Some(0.5));
    assert_eq!(today.yesterday_average, Some(6.0 / 96.0));
    assert_eq!(today.slots_since, None);
    // The account filter keeps one account's buckets and slots.
    let ann = Build {
        account_id: Some("ann"),
        ..Build::default()
    }
    .run(&snapshot)
    .today;
    assert_eq!(ann.slots[10], Some(0.0));
    assert_eq!(ann.change, Some(3.0 / 2.0 - 1.0));
}

#[test]
fn without_slots_for_all_of_yesterday_there_is_no_change_and_no_dashed_line() {
    let since = date_parse("2026-10-14T05:00:00Z");
    let snap = snapshot(
        json!({}),
        json!({}),
        json!({
            "2026-10-13": { "acct:ann": { "60": slot(1.0) } },
            "2026-10-14": { "acct:ann": { "60": slot(1.0) } },
        }),
        since,
    );
    let today = build(&snap).today;
    assert_eq!(today.change, None);
    assert_eq!(today.yesterday_average, None);
    assert_eq!(today.slots_since, Some(since));
    // Yesterday kept whole but with nothing up to now: no change either.
    let quiet = build(&snapshot(
        json!({}),
        json!({}),
        json!({ "2026-10-13": { "acct:ann": { "90": slot(1.0) } } }),
        0.0,
    ))
    .today;
    assert_eq!(quiet.change, None);
    assert_eq!(quiet.yesterday_average, Some(1.0 / 96.0));
    assert_eq!(quiet.slots_since, None);
}

#[test]
fn while_a_scan_runs_today_has_no_change_and_no_dashed_line_yesterday_may_be_only_partly_read() {
    let snap = snapshot(
        json!({}),
        json!({ "complete": false, "scannedBytes": 10 }),
        json!({
            "2026-10-13": { "acct:ann": { "60": slot(1.0) } },
            "2026-10-14": { "acct:ann": { "60": slot(5.0) } },
        }),
        0.0,
    );
    let today = build(&snap).today;
    assert_eq!(today.change, None);
    assert_eq!(today.yesterday_average, None);
    assert_eq!(today.slots[60], Some(5.0));
}

#[test]
fn a_day_whose_midnight_a_dst_change_skips_starts_at_its_first_hour() {
    // Santiago skipped 2026-09-06 00:00 (clocks went to 01:00).
    let zone = "America/Santiago";
    let now = date_parse("2026-09-07T15:00:00Z");
    let snap = snapshot(
        json!({}),
        json!({}),
        json!({ "2026-09-06": { "acct:ann": { "60": slot(1.0) } }, "2026-09-07": { "acct:ann": { "40": slot(1.0) } } }),
        // Slots began during the 6th, after its first hour.
        date_parse("2026-09-06T12:00:00Z"),
    );
    let today = Build {
        zone,
        now,
        ..Build::default()
    }
    .run(&snap)
    .today;
    assert_eq!(today.change, None);
    assert_eq!(today.yesterday_average, None);
}
