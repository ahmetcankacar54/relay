//! Port of `tests/token-attribution.test.ts`.

use std::collections::HashMap;
use std::time::Instant;

use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{Account, AccountDesktop, AccountKind, UsageWindow};
use relay_core::shared::usage_statistics::{MAX_USAGE_GAP_MS, UsageSample};
use relay_core::token_attribution::{
    Attribution, AttributionDeps, AttributionRow, NEAR_RISE_MS, SampleIndexCache, TimelineAccount,
    attribute, estimate_account_at, index_samples,
};

const MIN: f64 = 60_000.0;

fn t0() -> f64 {
    date_parse("2026-10-18T10:00:00Z")
}

const UUID_A: &str = "11111111-1111-4111-8111-111111111111";
const UUID_B: &str = "22222222-2222-4222-8222-222222222222";
const ORG_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

fn account(id: &str, account_uuid: Option<&str>, org_id: &str) -> Account {
    let mut account = Account::new(id, id);
    account.kind = AccountKind::Personal;
    account.group = String::new();
    account.created_at = iso(t0());
    account.desktop = account_uuid.map(|uuid| AccountDesktop {
        account_uuid: uuid.to_string(),
        org_id: org_id.to_string(),
        saved_at: iso(t0()),
        ..AccountDesktop::default()
    });
    account
}

fn sample(account_id: &str, at: f64, used_percent: f64, resets_at: Option<f64>) -> UsageSample {
    UsageSample {
        account_id: account_id.to_string(),
        identity: serde_json::to_string(&["uuid", &format!("uuid-{account_id}"), "org"]).unwrap(),
        checked_at: iso(at),
        five_hour: Some(UsageWindow {
            used_percent,
            resets_at: resets_at.map(iso),
            source: None,
            read_at: None,
        }),
        seven_day: None,
    }
}

fn s(account_id: &str, at: f64, used_percent: f64) -> UsageSample {
    sample(account_id, at, used_percent, None)
}

fn accounts() -> Vec<Account> {
    vec![
        account("a", Some(UUID_A), ORG_A),
        account("b", Some(UUID_B), ORG_B),
    ]
}

fn no_timeline(_: f64) -> Option<TimelineAccount> {
    None
}

fn timeline_of(
    uuid: &str,
    org_id: Option<&str>,
) -> impl Fn(f64) -> Option<TimelineAccount> + use<> {
    let uuid = uuid.to_string();
    let org_id = org_id.filter(|org| !org.is_empty()).map(str::to_string);
    move |_| {
        Some(TimelineAccount {
            account_uuid: uuid.clone(),
            org_id: org_id.clone(),
        })
    }
}

fn row(time: f64) -> AttributionRow<'static> {
    AttributionRow {
        time,
        ..AttributionRow::default()
    }
}

fn acct(id: &str, estimated: bool) -> Attribution {
    Attribution::Account {
        account_id: id.to_string(),
        estimated,
    }
}

#[test]
fn a_profile_account_id_wins_over_the_entrypoint_the_timeline_and_the_samples() {
    let accounts = accounts();
    let timeline = timeline_of(UUID_A, Some(ORG_A));
    let samples = [s("b", t0(), 10.0), s("b", t0() + 5.0 * MIN, 30.0)];
    let result = attribute(
        &AttributionRow {
            time: t0() + 2.0 * MIN,
            entrypoint: Some("cli"),
            profile_account_id: Some("p"),
            ..AttributionRow::default()
        },
        &AttributionDeps::new(&timeline, &samples, &accounts),
    );
    assert_eq!(result, acct("p", false));
}

#[test]
fn a_terminal_row_while_claude_runs_on_account_a_is_terminal() {
    let accounts = accounts();
    let timeline = timeline_of(UUID_A, Some(ORG_A));
    let result = attribute(
        &AttributionRow {
            time: t0(),
            entrypoint: Some("cli"),
            ..AttributionRow::default()
        },
        &AttributionDeps::new(&timeline, &[], &accounts),
    );
    assert_eq!(result, Attribution::Terminal);
}

#[test]
fn the_claude_desktop_entrypoint_is_not_terminal() {
    let accounts = accounts();
    let timeline = timeline_of(UUID_A, Some(ORG_A));
    let result = attribute(
        &AttributionRow {
            time: t0(),
            entrypoint: Some("claude-desktop"),
            ..AttributionRow::default()
        },
        &AttributionDeps::new(&timeline, &[], &accounts),
    );
    assert_eq!(result, acct("a", false));
}

#[test]
fn the_timeline_s_account_maps_to_the_relay_account_id() {
    let accounts = accounts();
    let timeline = timeline_of(UUID_B, Some(ORG_B));
    let result = attribute(&row(t0()), &AttributionDeps::new(&timeline, &[], &accounts));
    assert_eq!(result, acct("b", false));
}

#[test]
fn the_timeline_match_is_case_insensitive_and_ignores_an_unknown_organization() {
    let accounts = accounts();
    let upper = timeline_of(&UUID_A.to_uppercase(), Some(&ORG_A.to_uppercase()));
    assert_eq!(
        attribute(&row(t0()), &AttributionDeps::new(&upper, &[], &accounts)),
        acct("a", false)
    );
    let no_org = timeline_of(UUID_B, None);
    assert_eq!(
        attribute(&row(t0()), &AttributionDeps::new(&no_org, &[], &accounts)),
        acct("b", false)
    );
}

#[test]
fn a_matching_account_uuid_in_another_organization_does_not_match() {
    let accounts = accounts();
    let timeline = timeline_of(UUID_A, Some(ORG_B));
    let result = attribute(&row(t0()), &AttributionDeps::new(&timeline, &[], &accounts));
    assert_eq!(result, Attribution::Unknown);
}

#[test]
fn a_timeline_account_relay_does_not_know_is_unknown_not_estimated() {
    let accounts = accounts();
    let timeline = timeline_of("99999999-9999-4999-8999-999999999999", None);
    let samples = [s("a", t0(), 10.0), s("a", t0() + 5.0 * MIN, 30.0)];
    let result = attribute(
        &row(t0() + MIN),
        &AttributionDeps::new(&timeline, &samples, &accounts),
    );
    assert_eq!(result, Attribution::Unknown);
}

#[test]
fn without_a_timeline_reading_the_limit_samples_estimate_the_account() {
    let accounts = accounts();
    let samples = [s("a", t0(), 10.0), s("a", t0() + 5.0 * MIN, 30.0)];
    let result = attribute(
        &row(t0() + MIN),
        &AttributionDeps::new(&no_timeline, &samples, &accounts),
    );
    assert_eq!(result, acct("a", true));
}

#[test]
fn with_no_timeline_reading_and_no_estimate_the_row_is_unknown() {
    let accounts = accounts();
    let result = attribute(
        &row(t0() + MIN),
        &AttributionDeps::new(&no_timeline, &[], &accounts),
    );
    assert_eq!(result, Attribution::Unknown);
}

#[test]
fn only_accounts_with_a_claude_app_sign_in_receive_estimates() {
    // "c" has only a usage sign-in: Claude Desktop never had it, so its rows cannot be c's.
    let c = account("c", None, "");
    let samples = vec![
        s("a", t0(), 10.0),
        s("a", t0() + 5.0 * MIN, 12.0),
        s("c", t0(), 10.0),
        s("c", t0() + 5.0 * MIN, 60.0),
    ];
    let row = row(t0() + MIN);
    let with_c: Vec<Account> = accounts().into_iter().chain([c]).collect();
    assert_eq!(
        attribute(&row, &AttributionDeps::new(&no_timeline, &samples, &with_c)),
        acct("a", true)
    );
    let only_c: Vec<UsageSample> = samples
        .iter()
        .filter(|s| s.account_id == "c")
        .cloned()
        .collect();
    assert_eq!(
        attribute(&row, &AttributionDeps::new(&no_timeline, &only_c, &with_c)),
        Attribution::Unknown
    );
    // Once c signs in to the Claude app, the same samples estimate it.
    let signed_in = account("c", Some("33333333-3333-4333-8333-333333333333"), "");
    let with_signed_in: Vec<Account> = accounts().into_iter().chain([signed_in]).collect();
    assert_eq!(
        attribute(
            &row,
            &AttributionDeps::new(&no_timeline, &samples, &with_signed_in)
        ),
        acct("c", true)
    );
}

#[test]
fn the_account_with_the_largest_rise_wins() {
    let samples = [
        s("a", t0(), 10.0),
        s("a", t0() + 5.0 * MIN, 14.0),
        s("b", t0(), 40.0),
        s("b", t0() + 5.0 * MIN, 55.0),
    ];
    assert_eq!(
        estimate_account_at(t0() + 2.0 * MIN, &samples).as_deref(),
        Some("b")
    );
}

#[test]
fn only_the_pair_that_brackets_the_time_counts() {
    let samples = [
        s("a", t0(), 10.0),
        s("a", t0() + 5.0 * MIN, 60.0),
        s("a", t0() + 10.0 * MIN, 61.0),
        s("b", t0(), 10.0),
        s("b", t0() + 5.0 * MIN, 12.0),
        s("b", t0() + 10.0 * MIN, 30.0),
    ];
    assert_eq!(
        estimate_account_at(t0() + 7.0 * MIN, &samples).as_deref(),
        Some("b")
    );
    assert_eq!(
        estimate_account_at(t0() + 2.0 * MIN, &samples).as_deref(),
        Some("a")
    );
}

#[test]
fn samples_are_sorted_by_time_before_pairing() {
    let samples = [s("a", t0() + 5.0 * MIN, 30.0), s("a", t0(), 10.0)];
    assert_eq!(
        estimate_account_at(t0() + MIN, &samples).as_deref(),
        Some("a")
    );
}

#[test]
fn a_reset_between_two_samples_counts_the_rise_from_zero() {
    let samples = [
        // Window reset: 90% -> 8% on a new window ending 5h later.
        sample("a", t0(), 90.0, Some(t0() + MIN)),
        sample(
            "a",
            t0() + 5.0 * MIN,
            8.0,
            Some(t0() + MIN + 5.0 * 60.0 * MIN),
        ),
        // Smaller honest rise on the other account.
        s("b", t0(), 10.0),
        s("b", t0() + 5.0 * MIN, 15.0),
    ];
    assert_eq!(
        estimate_account_at(t0() + 2.0 * MIN, &samples).as_deref(),
        Some("a")
    );
}

#[test]
fn a_lower_percent_without_a_resets_at_still_counts_as_a_reset() {
    let samples = [s("a", t0(), 70.0), s("a", t0() + 5.0 * MIN, 6.0)];
    assert_eq!(
        estimate_account_at(t0() + MIN, &samples).as_deref(),
        Some("a")
    );
}

#[test]
fn a_later_resets_at_by_at_least_an_hour_counts_as_a_reset_even_when_the_percent_is_higher() {
    let samples = [
        sample("a", t0(), 5.0, Some(t0() + MIN)),
        sample("a", t0() + 5.0 * MIN, 9.0, Some(t0() + MIN + 60.0 * MIN)),
        s("b", t0(), 10.0),
        s("b", t0() + 5.0 * MIN, 17.0),
    ];
    // a: reset, so the rise is 9; b: rise 7.
    assert_eq!(
        estimate_account_at(t0() + MIN, &samples).as_deref(),
        Some("a")
    );
    let small_shift = [
        sample("a", t0(), 5.0, Some(t0() + MIN)),
        sample("a", t0() + 5.0 * MIN, 9.0, Some(t0() + MIN + 59.0 * MIN)),
        s("b", t0(), 10.0),
        s("b", t0() + 5.0 * MIN, 17.0),
    ];
    // a: not a reset, rise 4; b: rise 7.
    assert_eq!(
        estimate_account_at(t0() + MIN, &small_shift).as_deref(),
        Some("b")
    );
}

#[test]
fn a_gap_over_35_minutes_gives_no_estimate() {
    let samples = [
        s("a", t0(), 10.0),
        s("a", t0() + MAX_USAGE_GAP_MS + MIN, 60.0),
    ];
    assert_eq!(estimate_account_at(t0() + 10.0 * MIN, &samples), None);
}

#[test]
fn a_gap_of_exactly_35_minutes_still_estimates() {
    let samples = [s("a", t0(), 10.0), s("a", t0() + MAX_USAGE_GAP_MS, 60.0)];
    assert_eq!(
        estimate_account_at(t0() + 10.0 * MIN, &samples).as_deref(),
        Some("a")
    );
}

#[test]
fn no_rise_gives_undefined() {
    let samples = [
        s("a", t0(), 20.0),
        s("a", t0() + 5.0 * MIN, 20.0),
        s("b", t0(), 30.0),
        s("b", t0() + 5.0 * MIN, 30.0),
    ];
    assert_eq!(estimate_account_at(t0() + MIN, &samples), None);
}

#[test]
fn a_time_outside_every_pair_takes_a_rise_up_to_15_minutes_away_and_nothing_farther() {
    let samples = [s("a", t0(), 10.0), s("a", t0() + 5.0 * MIN, 30.0)];
    let at = |time: f64| estimate_account_at(time, &samples);
    assert_eq!(at(t0() - MIN).as_deref(), Some("a"));
    assert_eq!(at(t0() + 5.0 * MIN).as_deref(), Some("a"));
    assert_eq!(at(t0() - NEAR_RISE_MS).as_deref(), Some("a"));
    assert_eq!(at(t0() + 5.0 * MIN + NEAR_RISE_MS).as_deref(), Some("a"));
    assert_eq!(at(t0() - NEAR_RISE_MS - 1.0), None);
    assert_eq!(at(t0() + 5.0 * MIN + NEAR_RISE_MS + 1.0), None);
    let index = index_samples(&samples);
    assert_eq!(index.estimate(t0() - NEAR_RISE_MS).as_deref(), Some("a"));
    assert_eq!(index.estimate(t0() + 5.0 * MIN + NEAR_RISE_MS + 1.0), None);
}

#[test]
fn with_no_rise_around_a_response_the_nearest_rise_within_15_minutes_names_the_account() {
    // Both accounts are flat around T0 + 1 min; a rises 4 minutes later, b 9 minutes later.
    let samples = [
        s("a", t0(), 20.0),
        s("a", t0() + 5.0 * MIN, 20.0),
        s("a", t0() + 10.0 * MIN, 25.0),
        s("b", t0(), 30.0),
        s("b", t0() + 5.0 * MIN, 30.0),
        s("b", t0() + 10.0 * MIN, 30.0),
        s("b", t0() + 15.0 * MIN, 32.0),
    ];
    assert_eq!(
        estimate_account_at(t0() + MIN, &samples).as_deref(),
        Some("a")
    );
    assert_eq!(
        index_samples(&samples).estimate(t0() + MIN).as_deref(),
        Some("a")
    );
    // A rise in a response's own pair still wins over a nearer-looking one elsewhere.
    assert_eq!(
        estimate_account_at(t0() + 12.0 * MIN, &samples).as_deref(),
        Some("b")
    );
    assert_eq!(
        index_samples(&samples)
            .estimate(t0() + 12.0 * MIN)
            .as_deref(),
        Some("b")
    );
}

#[test]
fn between_two_equally_near_rises_the_larger_one_wins() {
    let samples = [
        s("a", t0(), 20.0),
        s("a", t0() + 5.0 * MIN, 20.0),
        s("a", t0() + 10.0 * MIN, 22.0),
        s("b", t0() - 5.0 * MIN, 30.0),
        s("b", t0(), 40.0),
        s("b", t0() + 5.0 * MIN, 40.0),
    ];
    // T0 + 2.5 min: a's rise starts 2.5 minutes later, b's ended 2.5 minutes before.
    assert_eq!(
        estimate_account_at(t0() + 2.5 * MIN, &samples).as_deref(),
        Some("b")
    );
    assert_eq!(
        index_samples(&samples)
            .estimate(t0() + 2.5 * MIN)
            .as_deref(),
        Some("b")
    );
}

#[test]
fn samples_without_a_five_hour_window_or_with_a_bad_timestamp_are_skipped() {
    let no_window = UsageSample {
        account_id: "a".into(),
        identity: "x".into(),
        checked_at: iso(t0() + 5.0 * MIN),
        five_hour: None,
        seven_day: None,
    };
    let bad = UsageSample {
        checked_at: "not a date".into(),
        ..s("a", t0(), 10.0)
    };
    assert_eq!(
        estimate_account_at(t0() + MIN, &[s("a", t0(), 10.0), no_window]),
        None
    );
    assert_eq!(
        estimate_account_at(t0() + MIN, &[bad, s("a", t0() + 5.0 * MIN, 30.0)]),
        None
    );
}

#[test]
fn the_estimate_does_not_mutate_its_input() {
    let samples = [s("a", t0() + 5.0 * MIN, 30.0), s("a", t0(), 10.0)];
    let before = serde_json::to_string(&samples).unwrap();
    estimate_account_at(t0() + MIN, &samples);
    assert_eq!(serde_json::to_string(&samples).unwrap(), before);
}

/// A small deterministic generator, so a failure names its seed.
fn random(mut seed: i32) -> impl FnMut() -> f64 {
    move || {
        seed = seed.wrapping_add(0x6d2b79f5);
        let s = seed as u32;
        let mut t = (s ^ (s >> 15)).wrapping_mul(1 | s);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

#[test]
fn the_indexed_estimate_agrees_with_the_plain_one_on_random_samples() {
    for seed in 1..=40 {
        let mut next = random(seed);
        let pick = |n: usize, next: &mut dyn FnMut() -> f64| (next() * n as f64).floor() as usize;
        let mut samples = Vec::new();
        for _ in 0..120 {
            let account_id = ["a", "b", "c"][pick(3, &mut next)];
            // Coarse times so equal times and long gaps both occur.
            let at = t0()
                + pick(60, &mut next) as f64 * 5.0 * MIN
                + if next() < 0.2 { 31.0 * MIN } else { 0.0 };
            let percent = pick(5, &mut next) as f64 * 10.0;
            let resets_at = if next() < 0.3 {
                None
            } else {
                Some(t0() + pick(4, &mut next) as f64 * 2.0 * 60.0 * MIN)
            };
            let mut value = sample(account_id, at, percent, resets_at);
            if next() < 0.05 {
                value.five_hour = None;
            }
            if next() < 0.03 {
                value.checked_at = "not a date".into();
            }
            samples.push(value);
        }
        let index = index_samples(&samples);
        for i in 0..400 {
            let time = if i % 4 == 0 {
                let parsed = date_parse(&samples[pick(samples.len(), &mut next)].checked_at);
                if parsed.is_nan() || parsed == 0.0 {
                    t0()
                } else {
                    parsed
                }
            } else {
                t0() - 30.0 * MIN + (next() * 330.0 * 5.0 * MIN) / 5.0
            };
            assert_eq!(
                index.estimate(time),
                estimate_account_at(time, &samples),
                "seed {seed}, time {time}"
            );
        }
        for time in [
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            t0() - 1.0,
            t0() + 1e12,
        ] {
            assert_eq!(index.estimate(time), estimate_account_at(time, &samples));
        }
    }
}

#[test]
fn attribution_over_50k_samples_handles_10k_rows_in_under_a_second() {
    let samples: Vec<UsageSample> = (0..50_000)
        .map(|i| {
            s(
                ["a", "b", "c", "d", "e"][i % 5],
                t0() + (i / 5) as f64 * MIN,
                ((i / 5) % 100) as f64,
            )
        })
        .collect();
    let accounts = accounts();
    let cache = SampleIndexCache::new();
    let deps = AttributionDeps {
        index: Some(&cache),
        ..AttributionDeps::new(&no_timeline, &samples, &accounts)
    };
    let started = Instant::now();
    let mut estimated = 0;
    for i in 0..10_000 {
        let result = attribute(&row(t0() + i as f64 * 60_000.0 + 30_000.0), &deps);
        if matches!(result, Attribution::Account { .. }) {
            estimated += 1;
        }
    }
    let elapsed = started.elapsed();
    assert!(estimated > 0);
    assert!(elapsed.as_millis() < 1000, "took {elapsed:?}");
}

#[test]
fn a_separate_window_s_session_goes_to_its_own_account_whatever_the_main_claude_has_open() {
    let owners: HashMap<&str, &str> =
        HashMap::from([("33333333-3333-4333-8333-333333333333", UUID_B)]);
    let accounts = accounts();
    let timeline = timeline_of(UUID_A, Some(ORG_A));
    let window_owner = |id: &str, _: f64| owners.get(id).map(|owner| owner.to_string());
    let deps = AttributionDeps {
        window_owner: Some(&window_owner),
        ..AttributionDeps::new(&timeline, &[], &accounts)
    };
    let in_session = |session_id| AttributionRow {
        time: t0(),
        entrypoint: Some("claude-desktop"),
        session_id: Some(session_id),
        ..AttributionRow::default()
    };
    assert_eq!(
        attribute(&in_session("33333333-3333-4333-8333-333333333333"), &deps),
        acct("b", false)
    );
    // Another session follows the main Claude, as before.
    assert_eq!(
        attribute(&in_session("44444444-4444-4444-8444-444444444444"), &deps),
        acct("a", false)
    );
}
