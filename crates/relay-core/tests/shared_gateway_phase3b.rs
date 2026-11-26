//! The `shared/limit-calibration` cases of tests/gateway-phase3b.test.ts. The move-cost, proxy
//! server and page cases belong to relay-gateway and the renderer.

use relay_core::shared::limit_calibration::{
    CalibrationInput, CostSlots, LimitCalibration, SlotCost, SlotStarts, calibrate_limits,
    slot_cost_between,
};
use relay_core::shared::types::UsageWindow;
use relay_core::shared::types::js::{JsMap, date_parse, iso, number_string};
use relay_core::shared::usage_statistics::UsageSample;

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: &str = "2026-11-12";

/// `Date.UTC(2026, 10, 12, hour, minute)`; hours past 23 run into the next day.
fn at(hour: f64, minute: f64) -> f64 {
    date_parse("2026-11-12T00:00:00.000Z") + hour * HOUR + minute * MINUTE
}
fn sample(account_id: &str, time: f64, percent: f64, reset_hour: f64) -> UsageSample {
    UsageSample {
        account_id: account_id.into(),
        identity: account_id.into(),
        checked_at: iso(time),
        five_hour: Some(UsageWindow::new(percent, Some(&iso(at(reset_hour, 0.0))))),
        seven_day: None,
    }
}
/// One cost per quarter hour from `from` to `to` (hours, UTC) for `who`.
fn spend(slots: &mut CostSlots, who: &str, from: f64, to: f64, per_quarter: f64) {
    let by_who = slots.entry_or_insert_with(DAY, JsMap::new);
    let quarters = by_who.entry_or_insert_with(who, JsMap::new);
    let mut q = from * 4.0;
    while q < to * 4.0 {
        quarters.insert(number_string(q), SlotCost { cost: per_quarter });
        q += 1.0;
    }
}
fn cost_between(slots: &CostSlots, who: &[&str], from: f64, to: f64) -> f64 {
    slot_cost_between(slots, who, from, to, "UTC", &mut SlotStarts::new())
}
fn calibrate(samples: &[UsageSample], slots: &CostSlots, now: f64) -> JsMap<LimitCalibration> {
    calibrate_limits(CalibrationInput {
        samples,
        slots,
        zone: "UTC",
        now,
        days: None,
    })
}

#[test]
fn cost_between_two_times_takes_each_quarter_hours_share_that_falls_inside() {
    let mut slots = CostSlots::new();
    spend(&mut slots, "acct:a", 9.0, 10.0, 4.0);
    assert_eq!(
        cost_between(&slots, &["acct:a"], at(9.0, 0.0), at(10.0, 0.0)),
        16.0
    );
    assert_eq!(
        cost_between(&slots, &["acct:a"], at(9.0, 7.0) + 30_000.0, at(9.0, 15.0)),
        4.0 * 0.5
    );
    assert_eq!(
        cost_between(&slots, &["acct:b"], at(9.0, 0.0), at(10.0, 0.0)),
        0.0
    );
}

#[test]
fn an_accounts_dollars_per_percent_come_from_windows_its_own_spending_explains() {
    let mut slots = CostSlots::new();
    let mut samples = Vec::new();
    // Window 1, 00–05: 20 % for $40 (2.0 $/%).
    samples.extend([
        sample("a", at(0.0, 30.0), 10.0, 5.0),
        sample("a", at(4.0, 30.0), 30.0, 5.0),
    ]);
    spend(&mut slots, "acct:a", 0.5, 4.5, 2.5);
    // Window 2, 05–10: 30 % for $66 (2.2 $/%), part of it estimated.
    samples.extend([
        sample("a", at(5.0, 30.0), 0.0, 10.0),
        sample("a", at(9.0, 30.0), 30.0, 10.0),
    ]);
    spend(&mut slots, "est:a", 5.5, 9.5, 4.125);
    // Window 3, 10–15: 25 % while most spending sat in "terminal": left out.
    samples.extend([
        sample("a", at(10.0, 30.0), 0.0, 15.0),
        sample("a", at(14.0, 30.0), 25.0, 15.0),
    ]);
    spend(&mut slots, "acct:a", 10.5, 14.5, 0.5);
    spend(&mut slots, "terminal", 10.5, 14.5, 3.0);
    // Window 4, 15–20: 60 % with $3 in the table (claude.ai chats): far below the others, left out.
    samples.extend([
        sample("a", at(15.0, 30.0), 0.0, 20.0),
        sample("a", at(19.0, 30.0), 60.0, 20.0),
    ]);
    spend(&mut slots, "acct:a", 15.5, 19.5, 0.1875);
    // Window 5, 20–24: 2 % is too small a rise to say anything.
    samples.extend([
        sample("a", at(20.0, 30.0), 0.0, 25.0),
        sample("a", at(23.0, 30.0), 2.0, 25.0),
    ]);
    spend(&mut slots, "acct:a", 20.5, 23.5, 1.0);

    let end = at(23.0, 59.0);
    let result = calibrate(&samples, &slots, end);
    assert_eq!(
        result.get("a"),
        Some(&LimitCalibration {
            account_id: "a".into(),
            dollars_per_percent: 2.12,
            windows: 2,
            percent: 50.0,
            cost: 106.0,
        })
    );

    // One window is not enough.
    assert_eq!(calibrate(&samples[..2], &slots, end).get("a"), None);
    // Readings older than the period are not used.
    assert!(calibrate(&samples, &slots, end + 8.0 * 24.0 * HOUR).is_empty());
}
