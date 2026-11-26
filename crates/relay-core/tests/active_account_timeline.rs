//! Port of `tests/active-account-timeline.test.ts` (the timeline's own cases).

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use relay_core::active_account_timeline::{
    ACTIVE_TIMELINE_MAX_SEGMENTS, ACTIVE_TIMELINE_RETENTION_MS, ActiveAccount,
    ActiveAccountTimeline, ActiveObservation,
};
use relay_core::shared::types::js::{date_parse, iso};
use serde_json::{Value, json};

const MINUTE: f64 = 60_000.0;
const DAY: f64 = 24.0 * 60.0 * MINUTE;

fn t0() -> f64 {
    date_parse("2026-10-01T08:00:00Z")
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

struct Ids {
    a: String,
    b: String,
    org_a: String,
    org_b: String,
}

fn ids() -> Ids {
    Ids {
        a: uuid(),
        b: uuid(),
        org_a: uuid(),
        org_b: uuid(),
    }
}

#[derive(Clone)]
struct Clock(Arc<Mutex<f64>>);

impl Clock {
    fn set(&self, now: f64) {
        *self.0.lock().unwrap() = now;
    }
    fn now(&self) -> f64 {
        *self.0.lock().unwrap()
    }
}

struct Fixture {
    _root: tempfile::TempDir,
    dir: PathBuf,
    file: PathBuf,
    clock: Clock,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("relay-timeline-")
            .tempdir()
            .unwrap();
        let dir = root.path().to_path_buf();
        Fixture {
            file: dir.join("active-account-timeline.json"),
            dir,
            _root: root,
            clock: Clock(Arc::new(Mutex::new(t0()))),
        }
    }
    fn open(&self) -> ActiveAccountTimeline {
        let clock = self.clock.clone();
        ActiveAccountTimeline::with_clock(&self.file, move || clock.now())
    }
    fn saved(&self) -> Value {
        serde_json::from_str(&fs::read_to_string(&self.file).unwrap()).unwrap()
    }
    fn segments(&self) -> Vec<Value> {
        self.saved()["segments"].as_array().unwrap().clone()
    }
    fn set(&self, now: f64) {
        self.clock.set(now);
    }
}

fn running(account: &str, orgs: &[&str]) -> ActiveObservation {
    ActiveObservation {
        running: true,
        current_account_uuid: Some(account.to_owned()),
        organizations: Some(orgs.iter().map(|o| (*o).to_owned()).collect()),
    }
}

fn stopped(account: Option<&str>, orgs: &[&str]) -> ActiveObservation {
    ActiveObservation {
        running: false,
        current_account_uuid: account.map(str::to_owned),
        organizations: Some(orgs.iter().map(|o| (*o).to_owned()).collect()),
    }
}

fn uuid_at(timeline: &ActiveAccountTimeline, time: f64) -> Option<String> {
    timeline.account_at(time).map(|a| a.account_uuid)
}

#[test]
fn an_open_a_switch_and_a_close_give_the_right_segments_and_answers() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    timeline.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 5.0 * MINUTE);
    timeline.observe(&running(&id.b, &[&id.org_b]));
    f.set(t0() + 9.0 * MINUTE);
    timeline.observe(&stopped(Some(&id.b), &[&id.org_b]));
    assert_eq!(
        f.saved()["segments"],
        json!([
            { "accountUuid": id.a, "orgId": id.org_a, "from": iso(t0()), "to": iso(t0() + 5.0 * MINUTE) },
            { "accountUuid": id.b, "orgId": id.org_b, "from": iso(t0() + 5.0 * MINUTE), "to": iso(t0() + 9.0 * MINUTE) },
        ])
    );
    assert_eq!(
        timeline.account_at(t0() + MINUTE),
        Some(ActiveAccount {
            account_uuid: id.a.clone(),
            org_id: Some(id.org_a.clone()),
            exact: true
        })
    );
    // A segment is from-inclusive and to-exclusive, so the switch instant belongs to the new one.
    assert_eq!(uuid_at(&timeline, t0() + 5.0 * MINUTE), Some(id.b.clone()));
    assert_eq!(uuid_at(&timeline, t0() + 8.0 * MINUTE), Some(id.b.clone()));
    assert_eq!(timeline.account_at(t0() + 9.0 * MINUTE), None);
    assert_eq!(timeline.account_at(t0() + 10.0 * MINUTE), None);
}

#[test]
fn watching_the_same_account_again_keeps_one_segment_and_writes_nothing_new() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    let state = running(&id.a, &[&id.org_a]);
    timeline.observe(&state);
    let written = fs::metadata(&f.file).unwrap().modified().unwrap();
    f.set(t0() + 30_000.0);
    timeline.observe(&state);
    assert_eq!(f.segments().len(), 1);
    assert_eq!(fs::metadata(&f.file).unwrap().modified().unwrap(), written);
    // The open segment answers for any later time.
    assert_eq!(uuid_at(&timeline, t0() + 3.0 * DAY), Some(id.a.clone()));
}

#[test]
fn an_unknown_account_or_a_closed_claude_closes_the_open_segment() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    timeline.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + MINUTE);
    // Running, but nobody signed in.
    timeline.observe(&ActiveObservation {
        running: true,
        current_account_uuid: None,
        organizations: Some(Vec::new()),
    });
    assert_eq!(f.segments()[0]["to"], iso(t0() + MINUTE));
    f.set(t0() + 2.0 * MINUTE);
    timeline.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 3.0 * MINUTE);
    timeline.observe(&stopped(Some(&id.a), &[&id.org_a]));
    let segments = f.segments();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[1]["to"], iso(t0() + 3.0 * MINUTE));
    // Closed twice in a row adds nothing.
    f.set(t0() + 4.0 * MINUTE);
    timeline.observe(&stopped(None, &[]));
    assert_eq!(f.segments().len(), 2);
}

#[test]
fn the_org_is_kept_only_when_there_is_exactly_one() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    timeline.observe(&running(&id.a, &[&id.org_a, &id.org_b]));
    f.set(t0() + MINUTE);
    timeline.observe(&ActiveObservation {
        running: true,
        current_account_uuid: Some(id.b.clone()),
        organizations: None,
    });
    f.set(t0() + 2.0 * MINUTE);
    timeline.observe(&running(&id.a, &[&id.org_a]));
    let segments = f.segments();
    assert!(segments[0].get("orgId").is_none());
    assert!(segments[1].get("orgId").is_none());
    assert_eq!(segments[2]["orgId"], id.org_a);
    assert_eq!(timeline.account_at(t0() + 30_000.0).unwrap().org_id, None);
}

#[test]
fn more_than_10_minutes_between_observations_closes_the_segment_a_minute_after_the_last_one() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    let state = running(&id.a, &[&id.org_a]);
    timeline.observe(&state);
    f.set(t0() + 4.0 * MINUTE);
    timeline.observe(&state);
    // Exactly 10 minutes is not a gap.
    f.set(t0() + 14.0 * MINUTE);
    timeline.observe(&state);
    assert_eq!(f.segments().len(), 1);
    assert!(f.segments()[0].get("to").is_none());
    // 10 minutes and a second is: Relay may have been closed in between.
    f.set(t0() + 14.0 * MINUTE + 10.0 * MINUTE + 1_000.0);
    timeline.observe(&state);
    assert_eq!(
        f.saved()["segments"],
        json!([
            { "accountUuid": id.a, "orgId": id.org_a, "from": iso(t0()), "to": iso(t0() + 15.0 * MINUTE) },
            { "accountUuid": id.a, "orgId": id.org_a, "from": iso(f.clock.now()) },
        ])
    );
    assert_eq!(timeline.account_at(t0() + 20.0 * MINUTE), None);
    assert_eq!(uuid_at(&timeline, f.clock.now()), Some(id.a.clone()));
}

#[test]
fn a_gap_followed_by_a_closed_claude_leaves_only_the_closed_segment() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    timeline.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 3.0 * 60.0 * MINUTE);
    timeline.observe(&stopped(None, &[]));
    assert_eq!(
        f.saved()["segments"],
        json!([{ "accountUuid": id.a, "orgId": id.org_a, "from": iso(t0()), "to": iso(t0() + MINUTE) }])
    );
}

#[test]
fn a_restart_closes_the_segment_the_last_run_left_open_a_minute_after_its_last_look() {
    let (f, id) = (Fixture::new(), ids());
    let mut first = f.open();
    first.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 20_000.0);
    first.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 2.0 * 60.0 * MINUTE);
    let mut second = f.open();
    assert_eq!(
        f.saved()["segments"],
        json!([{ "accountUuid": id.a, "orgId": id.org_a, "from": iso(t0()), "to": iso(t0() + MINUTE) }])
    );
    assert_eq!(second.exact_since(), Some(t0()));
    assert_eq!(uuid_at(&second, t0() + 30_000.0), Some(id.a.clone()));
    assert_eq!(second.account_at(t0() + 90_000.0), None);
    // The new run starts clean: the same account opens a segment of its own.
    second.observe(&running(&id.a, &[&id.org_a]));
    assert_eq!(f.segments().len(), 2);
    assert_eq!(f.segments()[1]["from"], iso(f.clock.now()));
}

#[test]
fn the_last_look_is_saved_while_a_segment_stays_open_so_a_restart_closes_near_the_real_end() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    let state = running(&id.a, &[&id.org_a]);
    timeline.observe(&state);
    // Seen every few seconds: saved about once a minute, not at every look.
    for seconds in (5..60).step_by(5) {
        f.set(t0() + f64::from(seconds) * 1_000.0);
        timeline.observe(&state);
    }
    assert_eq!(f.saved()["lastObservedAt"], iso(t0()));
    f.set(t0() + 5.0 * MINUTE);
    timeline.observe(&state);
    assert_eq!(f.saved()["lastObservedAt"], iso(t0() + 5.0 * MINUTE));
    f.set(t0() + 5.0 * MINUTE + 30_000.0);
    timeline.observe(&state);
    f.set(t0() + 3.0 * 60.0 * MINUTE);
    let restarted = f.open();
    // Closed a minute after the last saved look, which is never before the last real one.
    assert_eq!(f.segments()[0]["to"], iso(t0() + 6.0 * MINUTE));
    assert_eq!(
        uuid_at(&restarted, t0() + 5.0 * MINUTE + 30_000.0),
        Some(id.a.clone())
    );
    assert_eq!(restarted.account_at(t0() + 6.0 * MINUTE), None);
}

#[test]
fn a_restart_a_few_seconds_after_the_last_look_does_not_close_a_segment_in_the_future() {
    let (f, id) = (Fixture::new(), ids());
    let mut first = f.open();
    first.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() + 10_000.0);
    f.open();
    assert_eq!(f.segments()[0]["to"], iso(t0() + 10_000.0));
}

#[test]
fn segments_that_ended_over_120_days_ago_are_dropped_and_at_most_5_000_stay() {
    let (f, id) = (Fixture::new(), ids());
    f.set(t0() + 200.0 * DAY);
    let now = f.clock.now();
    let segment = |from: f64, to: f64| json!({ "accountUuid": id.a, "orgId": id.org_a, "from": iso(from), "to": iso(to) });
    fs::write(
        &f.file,
        json!({
            "version": 1,
            "segments": [
                segment(now - 200.0 * DAY, now - 130.0 * DAY),
                // Ended exactly 120 days ago: kept.
                segment(now - 125.0 * DAY, now - ACTIVE_TIMELINE_RETENTION_MS),
                segment(now - 121.0 * DAY, now - 120.0 * DAY - 1.0),
                segment(now - 10.0 * DAY, now - 9.0 * DAY),
            ],
        })
        .to_string(),
    )
    .unwrap();
    let timeline = f.open();
    let froms: Vec<Value> = f.segments().iter().map(|s| s["from"].clone()).collect();
    assert_eq!(
        froms,
        [json!(iso(now - 125.0 * DAY)), json!(iso(now - 10.0 * DAY))]
    );
    assert_eq!(timeline.exact_since(), Some(now - 125.0 * DAY));

    // The newest 5 000 stay, and the file still fits the private file limit.
    let many: Vec<Value> = (0..ACTIVE_TIMELINE_MAX_SEGMENTS + 100)
        .map(|i| {
            let from = now - 100.0 * DAY + i as f64 * 1_000.0;
            json!({ "accountUuid": uuid(), "orgId": uuid(), "from": iso(from), "to": iso(from + 500.0) })
        })
        .collect();
    fs::write(
        &f.file,
        json!({ "version": 1, "segments": many }).to_string(),
    )
    .unwrap();
    let capped = f.open();
    let kept = f.segments();
    assert_eq!(kept.len(), ACTIVE_TIMELINE_MAX_SEGMENTS);
    assert_eq!(kept[0]["from"], many[100]["from"]);
    assert_eq!(
        capped.exact_since(),
        Some(date_parse(many[100]["from"].as_str().unwrap()))
    );
    assert!(fs::metadata(&f.file).unwrap().len() < 1_048_576);
}

#[test]
fn a_corrupt_or_foreign_file_starts_an_empty_timeline_and_is_replaced_on_the_next_change() {
    let id = ids();
    for content in [
        "{not json".to_owned(),
        json!({ "version": 2, "segments": [] }).to_string(),
        json!({ "version": 1, "segments": "x" }).to_string(),
        json!([1, 2, 3]).to_string(),
        String::new(),
    ] {
        let f = Fixture::new();
        fs::write(&f.file, content).unwrap();
        let mut timeline = f.open();
        assert_eq!(timeline.exact_since(), None);
        assert_eq!(timeline.account_at(t0()), None);
        timeline.observe(&running(&id.a, &[&id.org_a]));
        assert_eq!(f.segments().len(), 1);
        assert_eq!(timeline.exact_since(), Some(t0()));
    }
}

#[test]
fn entries_that_are_not_segments_are_skipped_and_only_the_last_one_may_stay_open() {
    let (f, id) = (Fixture::new(), ids());
    fs::write(
        &f.file,
        json!({
            "version": 1,
            "lastObservedAt": iso(t0() + 30.0 * MINUTE),
            "segments": [
                { "accountUuid": id.a, "from": iso(t0()), "to": iso(t0() + MINUTE) },
                null,
                { "accountUuid": 5, "from": iso(t0()) },
                { "accountUuid": id.a, "from": "yesterday" },
                { "accountUuid": id.a, "orgId": 7, "from": iso(t0() + 2.0 * MINUTE) },
                // Left open, but another segment follows it: it ended when that one began.
                { "accountUuid": id.a, "from": iso(t0() + 10.0 * MINUTE) },
                { "accountUuid": id.b, "orgId": id.org_b, "from": iso(t0() + 20.0 * MINUTE) },
            ],
        })
        .to_string(),
    )
    .unwrap();
    f.set(t0() + 5.0 * 60.0 * MINUTE);
    f.open();
    assert_eq!(
        f.saved()["segments"],
        json!([
            { "accountUuid": id.a, "from": iso(t0()), "to": iso(t0() + MINUTE) },
            { "accountUuid": id.a, "from": iso(t0() + 10.0 * MINUTE), "to": iso(t0() + 20.0 * MINUTE) },
            { "accountUuid": id.b, "orgId": id.org_b, "from": iso(t0() + 20.0 * MINUTE), "to": iso(t0() + 31.0 * MINUTE) },
        ])
    );
}

#[test]
fn the_timeline_file_is_private_to_the_user() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    let mode = || {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&f.file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    };
    timeline.observe(&running(&id.a, &[&id.org_a]));
    mode();
    f.set(t0() + MINUTE);
    timeline.observe(&stopped(None, &[]));
    mode();
    let temporaries: Vec<_> = fs::read_dir(&f.dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert!(temporaries.is_empty());
}

#[test]
fn nothing_is_known_before_the_first_segment_began() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    assert_eq!(timeline.exact_since(), None);
    assert_eq!(timeline.account_at(t0()), None);
    f.set(t0() + 10.0 * MINUTE);
    timeline.observe(&running(&id.a, &[&id.org_a]));
    assert_eq!(timeline.exact_since(), Some(t0() + 10.0 * MINUTE));
    assert_eq!(timeline.account_at(t0() + 10.0 * MINUTE - 1.0), None);
    assert_eq!(timeline.account_at(t0()), None);
    assert!(timeline.account_at(t0() + 10.0 * MINUTE).unwrap().exact);
}

#[test]
fn a_clock_that_steps_back_never_makes_a_segment_end_before_it_began() {
    let (f, id) = (Fixture::new(), ids());
    let mut timeline = f.open();
    timeline.observe(&running(&id.a, &[&id.org_a]));
    f.set(t0() - 5.0 * MINUTE);
    timeline.observe(&stopped(None, &[]));
    let segment = &f.segments()[0];
    assert!(
        date_parse(segment["to"].as_str().unwrap())
            >= date_parse(segment["from"].as_str().unwrap())
    );
}

#[test]
fn a_timeline_that_cannot_be_saved_keeps_working_in_memory() {
    let (f, id) = (Fixture::new(), ids());
    let clock = f.clock.clone();
    let mut timeline = ActiveAccountTimeline::with_clock(
        f.dir.join("missing-folder").join("timeline.json"),
        move || clock.now(),
    );
    timeline.observe(&running(&id.a, &[&id.org_a]));
    assert_eq!(uuid_at(&timeline, t0()), Some(id.a.clone()));
}

/// A small deterministic generator (mulberry32), so a failure names its seed.
fn random(seed: u32) -> impl FnMut() -> f64 {
    let mut seed = seed;
    move || {
        seed = seed.wrapping_add(0x6d2b_79f5);
        let mut t = (seed ^ (seed >> 15)).wrapping_mul(1 | seed);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

#[derive(Clone)]
struct Segment {
    account_uuid: String,
    org_id: Option<String>,
    from: String,
    to: String,
}

impl Segment {
    fn json(&self) -> Value {
        let mut value = json!({ "accountUuid": self.account_uuid });
        if let Some(org) = &self.org_id {
            value["orgId"] = json!(org);
        }
        value["from"] = json!(self.from);
        value["to"] = json!(self.to);
        value
    }
}

/// Closed segments one after another, some touching, some empty, from `start`.
fn chronological(
    next: &mut impl FnMut() -> f64,
    count: usize,
    start: f64,
    id: &Ids,
) -> Vec<Segment> {
    let mut pick = |n: f64| (next() * n).floor();
    let mut segments = Vec::new();
    let mut at = start;
    for _ in 0..count {
        let from = at
            + if pick(3.0) == 0.0 {
                0.0
            } else {
                pick(30.0) * MINUTE + pick(1_000.0)
            };
        let to = from
            + if pick(5.0) == 0.0 {
                0.0
            } else {
                1.0 + pick(60.0) * MINUTE
            };
        let account = if pick(2.0) == 0.0 { &id.a } else { &id.b };
        let org = (pick(2.0) == 0.0).then(|| id.org_a.clone());
        segments.push(Segment {
            account_uuid: account.clone(),
            org_id: org,
            from: iso(from),
            to: iso(to),
        });
        at = to;
    }
    segments
}

/// What the timeline answered before it kept times as numbers: every segment, newest first.
fn linear_account_at(segments: &[Segment], time: f64) -> Option<ActiveAccount> {
    segments.iter().rev().find_map(|segment| {
        (time >= date_parse(&segment.from) && time < date_parse(&segment.to)).then(|| {
            ActiveAccount {
                account_uuid: segment.account_uuid.clone(),
                org_id: segment.org_id.clone(),
                exact: true,
            }
        })
    })
}

fn shuffled<T: Clone>(items: &[T], next: &mut impl FnMut() -> f64) -> Vec<T> {
    let mut copy = items.to_vec();
    for i in (1..copy.len()).rev() {
        let j = (next() * (i + 1) as f64).floor() as usize;
        copy.swap(i, j);
    }
    copy
}

#[test]
fn lookups_agree_with_a_scan_of_every_segment_on_random_timelines_saved_out_of_order() {
    let id = ids();
    for seed in 1..=25 {
        let f = Fixture::new();
        let mut next = random(seed);
        let count = 1 + (next() * 150.0).floor() as usize;
        let segments = chronological(&mut next, count, t0(), &id);
        let first = date_parse(&segments[0].from);
        let last = date_parse(&segments[segments.len() - 1].to);
        let saved: Vec<Value> = shuffled(&segments, &mut next)
            .iter()
            .map(Segment::json)
            .collect();
        fs::write(
            &f.file,
            json!({ "version": 1, "segments": saved }).to_string(),
        )
        .unwrap();
        f.set(last + MINUTE);
        let mut timeline = f.open();
        assert_eq!(timeline.exact_since(), Some(first), "seed {seed}");
        let mut times = vec![first - 1.0];
        for s in &segments {
            let from = date_parse(&s.from);
            let to = date_parse(&s.to);
            times.extend([from - 1.0, from, from + 1.0, to - 1.0, to, to + 1.0]);
        }
        for _ in 0..300 {
            times.push(first - MINUTE + next() * (last - first + 2.0 * MINUTE));
        }
        times.extend([f64::NAN, f64::INFINITY, f64::NEG_INFINITY]);
        for time in times {
            assert_eq!(
                timeline.account_at(time),
                linear_account_at(&segments, time),
                "seed {seed}, time {time}"
            );
        }
        // A segment opened after loading is found too, and closing it ends it.
        f.set(last + 2.0 * MINUTE);
        timeline.observe(&running(&id.b, &[&id.org_b]));
        assert_eq!(uuid_at(&timeline, last + 3.0 * MINUTE), Some(id.b.clone()));
        f.set(last + 4.0 * MINUTE);
        timeline.observe(&stopped(None, &[]));
        assert_eq!(uuid_at(&timeline, last + 3.0 * MINUTE), Some(id.b.clone()));
        assert_eq!(timeline.account_at(last + 4.0 * MINUTE), None);
        assert_eq!(
            timeline.account_at(last - 1.0),
            linear_account_at(&segments, last - 1.0)
        );
    }
}

#[test]
fn _5_000_segments_answer_10_000_lookups_in_under_50_ms() {
    let (f, id) = (Fixture::new(), ids());
    let mut next = random(7);
    let segments = chronological(&mut next, ACTIVE_TIMELINE_MAX_SEGMENTS, t0(), &id);
    let first = date_parse(&segments[0].from);
    let last = date_parse(&segments[segments.len() - 1].to);
    let saved: Vec<Value> = segments.iter().map(Segment::json).collect();
    fs::write(
        &f.file,
        json!({ "version": 1, "segments": saved }).to_string(),
    )
    .unwrap();
    f.set(last + MINUTE);
    let timeline = f.open();
    let times: Vec<f64> = (0..10_000)
        .map(|_| first + next() * (last - first))
        .collect();
    let started = std::time::Instant::now();
    let found = times
        .iter()
        .filter(|time| timeline.account_at(**time).is_some())
        .count();
    let elapsed = started.elapsed();
    assert!(found > 0);
    assert!(elapsed.as_millis() < 50, "took {elapsed:?}");
    for time in &times[..200] {
        assert_eq!(
            timeline.account_at(*time),
            linear_account_at(&segments, *time)
        );
    }
}
