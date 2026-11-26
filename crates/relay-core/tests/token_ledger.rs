//! Port of `tests/token-ledger.test.ts`.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use relay_core::fs_util::set_times;
use relay_core::shared::types::js::{date_parse, iso};
use relay_core::shared::types::{Account, AccountDesktop};
use relay_core::token_attribution::{
    Attribution, AttributionDeps, AttributionRow, TimelineAccount, attribute,
};
use relay_core::token_ledger::{
    AttributeFn, LastTick, LedgerProgress, TOKEN_FIRST_SCAN_TICK_MS, TOKEN_TICK_MS, TickResult,
    TokenCounts, TokenLedger, TokenLedgerOptions, TokenRoot, token_tick_delay,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

fn now0() -> f64 {
    date_parse("2026-10-18T12:00:00Z")
}
const DAY: f64 = 86_400_000.0;
const ZONE: &str = "Europe/Istanbul";
const MODEL: &str = "claude-opus-4-1";
const CHUNK: usize = 1024 * 1024;
/// Appears in every fixture row's text and must never reach the ledger file.
const PHRASE: &str = "periwinkle-anchovy-telescope-4417";

fn temp_dir() -> TempDir {
    tempfile::Builder::new()
        .prefix("relay-token-ledger-")
        .tempdir()
        .unwrap()
}

/// An assistant row.
#[derive(Clone)]
struct Fx {
    id: String,
    req: Option<String>,
    at: Option<String>,
    entrypoint: Option<String>,
    model: Option<String>,
    usage: Vec<(String, Value)>,
    pad: usize,
}

fn a(id: &str) -> Fx {
    Fx {
        id: id.to_string(),
        req: None,
        at: None,
        entrypoint: None,
        model: None,
        usage: Vec::new(),
        pad: 0,
    }
}

impl Fx {
    fn req(mut self, req: &str) -> Self {
        self.req = Some(req.to_string());
        self
    }
    fn at(mut self, at: &str) -> Self {
        self.at = Some(at.to_string());
        self
    }
    fn entry(mut self, entrypoint: &str) -> Self {
        self.entrypoint = Some(entrypoint.to_string());
        self
    }
    fn model(mut self, model: &str) -> Self {
        self.model = Some(model.to_string());
        self
    }
    fn usage(mut self, usage: Value) -> Self {
        for (key, value) in usage.as_object().unwrap() {
            self.usage.push((key.clone(), value.clone()));
        }
        self
    }
    fn pad(mut self, pad: usize) -> Self {
        self.pad = pad;
        self
    }
    fn value(&self) -> Value {
        let mut usage = json!({
            "input_tokens": 1,
            "output_tokens": 2,
            "cache_creation_input_tokens": 3,
            "cache_read_input_tokens": 4,
            "service_tier": "standard",
        });
        for (key, value) in &self.usage {
            usage[key] = value.clone();
        }
        json!({
            "parentUuid": null,
            "isSidechain": false,
            "userType": "external",
            "cwd": "/tmp/fixture-project",
            "sessionId": "fixture-session",
            "entrypoint": self.entrypoint.clone().unwrap_or("claude-desktop".into()),
            "type": "assistant",
            "timestamp": self.at.clone().unwrap_or("2026-10-18T09:00:00.000Z".into()),
            "requestId": self.req.clone().unwrap_or(format!("req_{}", self.id)),
            "message": {
                "id": self.id,
                "type": "message",
                "role": "assistant",
                "model": self.model.clone().unwrap_or(MODEL.into()),
                "content": [{ "type": "text", "text": format!("{PHRASE} {}", "x".repeat(self.pad)) }],
                "usage": usage,
            },
            "uuid": format!("{}-row", self.id),
        })
    }
    fn line(&self) -> String {
        serde_json::to_string(&self.value()).unwrap() + "\n"
    }
}

fn user() -> String {
    serde_json::to_string(&json!({
        "type": "user",
        "timestamp": "2026-10-18T08:59:00.000Z",
        "message": { "role": "user", "content": format!("{PHRASE} tell me about \"usage\"") },
        // Passes the substring prefilter but is not an assistant row.
        "toolUseResult": {
            "agentType": "assistant",
            "usage": { "input_tokens": 999, "output_tokens": 999 },
        },
    }))
    .unwrap()
        + "\n"
}

fn write(file: &Path, text: &str) {
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, text).unwrap();
}

fn append(file: &Path, text: &str) {
    fs::OpenOptions::new()
        .append(true)
        .open(file)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn size(file: &Path) -> f64 {
    fs::metadata(file).unwrap().len() as f64
}

fn at_ms(ms: f64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms as u64)
}

fn acct(id: &str) -> Attribution {
    Attribution::Account {
        account_id: id.to_string(),
        estimated: false,
    }
}

fn desktop_account(account_id: &str) -> AttributeFn {
    let account_id = account_id.to_string();
    Box::new(move |row: &AttributionRow<'_>| {
        if let Some(profile) = row.profile_account_id.filter(|p| !p.is_empty()) {
            return acct(profile);
        }
        if row
            .entrypoint
            .is_some_and(|e| !e.is_empty() && e != "claude-desktop")
        {
            return Attribution::Terminal;
        }
        acct(&account_id)
    })
}

#[derive(Default)]
struct Opts {
    budget_ms: Option<f64>,
    now: Option<Box<dyn FnMut() -> f64 + Send>>,
    attribute: Option<AttributeFn>,
    zone: Option<Box<dyn FnMut() -> String + Send>>,
    max_bytes: Option<u64>,
}

fn roots(dir: &Path) -> Vec<TokenRoot> {
    vec![TokenRoot {
        dir: dir.to_path_buf(),
        profile_account_id: None,
    }]
}

fn ledger_for(dir: &Path, roots: &[TokenRoot], options: Opts) -> TokenLedger {
    TokenLedger::new(TokenLedgerOptions {
        file: dir.join("token-ledger.json"),
        roots: roots.to_vec(),
        attribute: options.attribute.unwrap_or_else(|| desktop_account("a1")),
        zone: options
            .zone
            .unwrap_or_else(|| Box::new(|| ZONE.to_string())),
        now: Some(options.now.unwrap_or_else(|| Box::new(now0))),
        budget_ms: options.budget_ms,
        max_age_days: None,
        max_bytes: options.max_bytes,
    })
}

fn plain(dir: &Path, root: &Path) -> TokenLedger {
    ledger_for(dir, &roots(root), Opts::default())
}

/// A fake clock shared by `now` and `attribute`.
#[derive(Clone)]
struct Clock(Arc<Mutex<f64>>);

impl Clock {
    fn new(at: f64) -> Self {
        Clock(Arc::new(Mutex::new(at)))
    }
    fn get(&self) -> f64 {
        *self.0.lock().unwrap()
    }
    fn set(&self, at: f64) {
        *self.0.lock().unwrap() = at;
    }
    fn add(&self, ms: f64) {
        *self.0.lock().unwrap() += ms;
    }
    fn now(&self) -> Box<dyn FnMut() -> f64 + Send> {
        let clock = self.clone();
        Box::new(move || clock.get())
    }
    /// Every counted response moves the clock by `ms`.
    fn costly(&self, ms: f64) -> AttributeFn {
        let clock = self.clone();
        Box::new(move |_: &AttributionRow<'_>| {
            clock.add(ms);
            acct("a1")
        })
    }
}

/// A zone the test can change.
#[derive(Clone)]
struct Zone(Arc<Mutex<String>>);

impl Zone {
    fn new() -> Self {
        Zone(Arc::new(Mutex::new(ZONE.to_string())))
    }
    fn set(&self, zone: &str) {
        *self.0.lock().unwrap() = zone.to_string();
    }
    fn get(&self) -> Box<dyn FnMut() -> String + Send> {
        let zone = self.clone();
        Box::new(move || zone.0.lock().unwrap().clone())
    }
}

#[derive(Debug, PartialEq, Default)]
struct Sum {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
    responses: f64,
}

fn sum(input: f64, output: f64, cache_write: f64, cache_read: f64, responses: f64) -> Sum {
    Sum {
        input,
        output,
        cache_write,
        cache_read,
        responses,
    }
}

fn totals_of(ledger: &TokenLedger, who: Option<&str>) -> Sum {
    let mut total = Sum::default();
    for by_who in ledger.snapshot().days.values() {
        for (key, by_model) in by_who.iter() {
            if who.is_some_and(|who| who != key) {
                continue;
            }
            for counts in by_model.values() {
                total.input += counts.input;
                total.output += counts.output;
                total.cache_write += counts.cache_write;
                total.cache_read += counts.cache_read;
                total.responses += counts.responses;
            }
        }
    }
    total
}

fn totals(ledger: &TokenLedger) -> Sum {
    totals_of(ledger, None)
}

fn done(complete: bool) -> TickResult {
    TickResult { complete }
}

fn progress(scanned: f64, total: f64, complete: bool) -> LedgerProgress {
    LedgerProgress {
        scanned_bytes: scanned,
        total_bytes: total,
        complete,
        error: None,
    }
}

fn day_keys(ledger: &TokenLedger) -> Vec<String> {
    ledger.snapshot().days.keys().cloned().collect()
}

fn counts_at(ledger: &TokenLedger, date: &str, who: &str, model: &str) -> TokenCounts {
    ledger
        .snapshot()
        .days
        .get(date)
        .unwrap()
        .get(who)
        .unwrap()
        .get(model)
        .unwrap()
        .clone()
}

fn read_dir_sorted(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn read_json(file: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}

#[cfg(unix)]
fn mode(file: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(file).unwrap().permissions().mode() & 0o777
}

#[cfg(unix)]
fn chmod(file: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(file, fs::Permissions::from_mode(mode)).unwrap();
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() == 0 }
}

fn symlink_file(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(target, link).unwrap();
}

fn symlink_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link).unwrap();
}

/// The key a transcript has in the ledger: the first 16 bytes of the SHA-256 of its path.
fn key_of(file: &Path) -> String {
    Sha256::digest(file.to_string_lossy().as_bytes())[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn counts_a_streamed_response_once_each_response_once_subagents_and_never_tool_results() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let session = root.join("-tmp-fixture-project").join("s1.jsonl");
    let streamed = a("msg_A").usage(json!({ "input_tokens": 100 }));
    write(
        &session,
        &(user()
            + &streamed.line()
            + &streamed.line()
            + &streamed.line()
            + &streamed.line()
            + &a("msg_B").usage(json!({ "input_tokens": 200 })).line()
            // An assistant row without usage does not count.
            + &serde_json::to_string(&json!({
                "type": "assistant",
                "timestamp": "2026-10-18T09:00:00.000Z",
                "message": { "id": "msg_C", "usage": "none", "content": PHRASE },
            }))
            .unwrap()
            + "\n"),
    );
    let subagent = root
        .join("-tmp-fixture-project")
        .join("s1")
        .join("subagents")
        .join("agent-1.jsonl");
    write(
        &subagent,
        &a("msg_D").usage(json!({ "input_tokens": 300 })).line(),
    );
    write(
        &root
            .join("-tmp-fixture-project")
            .join("s1")
            .join("tool-results")
            .join("t.jsonl"),
        &a("msg_E").usage(json!({ "input_tokens": 4000 })).line(),
    );
    write(
        &root
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("too-deep.jsonl"),
        &a("msg_F").usage(json!({ "input_tokens": 50_000 })).line(),
    );
    let outside = dir.join("outside.jsonl");
    write(
        &outside,
        &a("msg_G").usage(json!({ "input_tokens": 600_000 })).line(),
    );
    symlink_file(
        &outside,
        &root.join("-tmp-fixture-project").join("link.jsonl"),
    );

    let mut ledger = plain(dir, &root);
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_eq!(totals(&ledger), sum(600.0, 6.0, 9.0, 12.0, 3.0));
    let sizes = size(&session) + size(&subagent);
    assert_eq!(ledger.snapshot().progress, progress(sizes, sizes, true));
}

#[test]
fn missing_or_non_finite_usage_counts_as_zero_and_a_missing_model_is_unknown() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let mut row = a("msg_A")
        .usage(json!({ "input_tokens": "12", "output_tokens": null, "cache_read_input_tokens": 7 }))
        .value();
    row["message"]
        .as_object_mut()
        .unwrap()
        .shift_remove("model");
    row["message"]["usage"]
        .as_object_mut()
        .unwrap()
        .shift_remove("cache_creation_input_tokens");
    write(
        &root.join("p").join("s.jsonl"),
        &(serde_json::to_string(&row).unwrap() + "\n"),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(
        counts_at(&ledger, "2026-10-18", "acct:a1", "unknown"),
        TokenCounts {
            input: 0.0,
            output: 0.0,
            cache_write: 0.0,
            cache_read: 7.0,
            responses: 1.0,
            cost: Some(0.0),
            unpriced: Some(7.0),
            cost_estimated: None,
        }
    );
}

#[test]
fn appended_and_completed_lines_count_on_a_later_tick_and_a_restart_does_not_re_count() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("s.jsonl");
    write(&file, &a("msg_A").line());
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 1.0);

    append(&file, &a("msg_B").line());
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_eq!(totals(&ledger).responses, 2.0);

    let line = a("msg_C").usage(json!({ "output_tokens": 1000 })).line();
    let half = line.len() / 2;
    append(&file, &line[..half]);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 2.0);
    let snap = ledger.snapshot();
    assert!(snap.progress.scanned_bytes < snap.progress.total_bytes);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 2.0);
    append(&file, &line[half..]);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 3.0);
    assert_eq!(totals(&ledger).output, 1004.0);

    // The first row of a streamed response, then a restart, then its next row.
    append(&file, &a("msg_D").line());
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 4.0);

    let mut restarted = plain(dir, &root);
    assert_eq!(totals(&restarted).responses, 4.0);
    assert_eq!(restarted.tick().unwrap(), done(true));
    assert_eq!(totals(&restarted).responses, 4.0);
    append(&file, &a("msg_D").line());
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 4.0);
    append(&file, &a("msg_E").line());
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 5.0);
    assert_eq!(
        restarted.snapshot().progress,
        progress(size(&file), size(&file), true)
    );
}

#[test]
fn a_shrunk_file_and_a_replaced_file_are_never_read_again_and_keep_their_counted_tokens() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let shrunk = root.join("p").join("shrunk.jsonl");
    let replaced = root.join("p").join("replaced.jsonl");
    let kept = root.join("p").join("kept.jsonl");
    write(&shrunk, &(a("msg_A").line() + &a("msg_B").line()));
    write(&replaced, &a("msg_C").line());
    write(&kept, &a("msg_D").line());
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 4.0);

    // Same inode, truncated and rewritten shorter.
    fs::write(&shrunk, a("msg_A").line()).unwrap();
    // A new inode with the old content and more.
    let temporary = dir.join("replacement.jsonl");
    fs::write(&temporary, a("msg_C").line() + &a("msg_X").line()).unwrap();
    let before = relay_core::fs_util::FileId::of_path(&replaced).unwrap();
    fs::rename(&temporary, &replaced).unwrap();
    assert_ne!(
        relay_core::fs_util::FileId::of_path(&replaced).unwrap(),
        before
    );

    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_eq!(totals(&ledger).responses, 4.0);

    append(&shrunk, &a("msg_Y").line().repeat(3));
    append(&replaced, &a("msg_Z").line());
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 4.0);

    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 4.0);
    // Only the healthy file is in the progress totals.
    assert_eq!(
        restarted.snapshot().progress,
        progress(size(&kept), size(&kept), true)
    );
}

/// Rewrite the saved state of `file` as a ledger kept before the volume was mounted again would
/// hold it.
fn remount(dir: &Path, file: &Path, patch: Value) {
    let saved = dir.join("token-ledger.json");
    let mut value = read_json(&saved);
    let state = value["files"].get_mut(key_of(file)).expect("a saved state");
    state["dev"] = json!(state["dev"].as_f64().unwrap() + 1.0);
    for (key, field) in patch.as_object().unwrap() {
        state[key] = field.clone();
    }
    fs::write(&saved, serde_json::to_string(&value).unwrap()).unwrap();
}

#[test]
fn a_file_whose_volume_got_a_new_device_number_as_after_a_restart_is_read_on_from_its_offset() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("session.jsonl");
    write(&file, &a("msg_A").line());
    plain(dir, &root).tick().unwrap();

    remount(dir, &file, json!({}));
    append(&file, &a("msg_B").line());
    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 2.0);
    assert_eq!(restarted.snapshot().progress.scanned_bytes, size(&file));

    // The new device number is kept: a later append is read without a second look at it.
    append(&file, &a("msg_C").line());
    let mut again = plain(dir, &root);
    again.tick().unwrap();
    assert_eq!(totals(&again).responses, 3.0);
}

#[test]
fn a_file_an_older_ledger_broke_over_a_new_device_number_alone_is_read_again_once() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("session.jsonl");
    write(&file, &(a("msg_A").line() + &a("msg_B").line()));
    plain(dir, &root).tick().unwrap();

    remount(dir, &file, json!({ "broken": true }));
    append(&file, &(a("msg_C").line() + &a("msg_D").line()));
    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    // The two rows read before it broke are not counted again.
    assert_eq!(totals(&restarted).responses, 4.0);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 4.0);
}

#[test]
fn a_file_broken_on_its_own_volume_stays_broken() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("session.jsonl");
    write(&file, &a("msg_A").line());
    plain(dir, &root).tick().unwrap();

    // Broken without a device change (shrunk, then grown again): nothing is read from it.
    let saved = dir.join("token-ledger.json");
    let mut value = read_json(&saved);
    value["files"][key_of(&file)]["broken"] = json!(true);
    fs::write(&saved, serde_json::to_string(&value).unwrap()).unwrap();
    append(&file, &a("msg_B").line());
    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 1.0);
}

#[test]
fn a_large_first_scan_spreads_over_budgeted_ticks_survives_a_restart_and_counts_each_response_once()
{
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let files = [
        root.join("p").join("one.jsonl"),
        root.join("p").join("two.jsonl"),
    ];
    let mut expected = 0.0;
    let mut longest = 0;
    let mut shortest = usize::MAX;
    for (index, file) in files.iter().enumerate() {
        let mut rows: Vec<String> = Vec::new();
        let mut size = 0.0;
        while size < 1.6 * CHUNK as f64 {
            let row = a(&format!("msg_{index}_{}", rows.len())).pad(1500).line();
            size += row.len() as f64 * 2.0;
            longest = longest.max(row.len());
            shortest = shortest.min(row.len());
            rows.push(row.clone());
            rows.push(row);
        }
        expected += rows.len() as f64 / 2.0;
        write(file, &rows.concat());
    }

    // Fake clock: each counted response costs 0.05 ms, so a 1 ms budget runs out within the
    // first chunk of every tick.
    let clock = Clock::new(now0());
    let options = || Opts {
        budget_ms: Some(1.0),
        now: Some(clock.now()),
        attribute: Some(clock.costly(0.05)),
        ..Opts::default()
    };
    let mut ledger = ledger_for(dir, &roots(&root), options());
    let first = ledger.tick().unwrap();
    assert!(!first.complete);
    let mut scanned = ledger.snapshot().progress.scanned_bytes;
    assert!(
        scanned > 0.0 && scanned <= CHUNK as f64,
        "first tick read {scanned}"
    );

    let mut ticks = 1;
    let mut complete = false;
    while !complete {
        if ticks == 2 {
            ledger = ledger_for(dir, &roots(&root), options());
        }
        let started = clock.get();
        complete = ledger.tick().unwrap().complete;
        ticks += 1;
        let now = ledger.snapshot().progress.scanned_bytes;
        assert!(
            now - scanned <= (CHUNK + longest) as f64,
            "tick {ticks} read {} bytes",
            now - scanned
        );
        // At most one chunk's responses (each written twice) past the budget.
        let per_chunk = (CHUNK as f64 / (2.0 * shortest as f64)).ceil() + 1.0;
        assert!(
            clock.get() - started <= 1.0 + per_chunk * 0.05,
            "tick {ticks} took {} ms",
            clock.get() - started
        );
        scanned = now;
        assert!(ticks < 20, "the scan never completed");
    }
    assert!(ticks >= 4, "only {ticks} ticks");
    assert_eq!(totals(&ledger).responses, expected);
    assert_eq!(totals(&ledger).input, expected);
    let total: f64 = files.iter().map(|file| size(file)).sum();
    assert_eq!(ledger.snapshot().progress, progress(total, total, true));
}

#[test]
fn _23_59_59_and_00_00_01_land_on_different_dates_and_attribution_maps_to_who_keys() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let profiles = dir.join("profiles").join("a2").join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_A").at("2026-10-17T23:59:59+03:00").line()
            + &a("msg_B").at("2026-10-18T00:00:01+03:00").line()
            + &a("msg_C").entry("cli").model("claude-sonnet-4-5").line()),
    );
    write(
        &profiles.join("p").join("s.jsonl"),
        &a("msg_D").entry("cli").line(),
    );
    let uuid = "11111111-1111-4111-8111-111111111111";
    let mut account = Account::new("a1", "a1");
    account.group = String::new();
    account.created_at = iso(now0());
    account.desktop = Some(AccountDesktop {
        account_uuid: uuid.to_string(),
        org_id: String::new(),
        saved_at: iso(now0()),
        ..AccountDesktop::default()
    });
    let accounts = vec![account];
    let timeline = move |_: f64| {
        Some(TimelineAccount {
            account_uuid: uuid.to_string(),
            org_id: None,
        })
    };
    let mut ledger = ledger_for(
        dir,
        &[
            TokenRoot {
                dir: root.clone(),
                profile_account_id: None,
            },
            TokenRoot {
                dir: profiles.clone(),
                profile_account_id: Some("a2".into()),
            },
        ],
        Opts {
            attribute: Some(Box::new(move |row: &AttributionRow<'_>| {
                attribute(row, &AttributionDeps::new(&timeline, &[], &accounts))
            })),
            ..Opts::default()
        },
    );
    ledger.tick().unwrap();
    let days = ledger.snapshot().days;
    let one = |date: &str, who: &str, model: &str| {
        days.get(date)
            .and_then(|d| d.get(who))
            .and_then(|w| w.get(model))
            .map(|c| c.responses)
    };
    assert_eq!(one("2026-10-17", "acct:a1", MODEL), Some(1.0));
    assert_eq!(one("2026-10-18", "acct:a1", MODEL), Some(1.0));
    assert_eq!(
        one("2026-10-18", "terminal", "claude-sonnet-4-5"),
        Some(1.0)
    );
    assert_eq!(one("2026-10-18", "acct:a2", MODEL), Some(1.0));
    let mut dates: Vec<&String> = days.keys().collect();
    dates.sort();
    assert_eq!(dates, ["2026-10-17", "2026-10-18"]);
    assert_eq!(
        days.get("2026-10-17").unwrap().keys().collect::<Vec<_>>(),
        ["acct:a1"]
    );

    let dir2 = temp_dir();
    let dir2 = dir2.path();
    let root2 = dir2.join("projects");
    write(
        &root2.join("p").join("s.jsonl"),
        &(a("msg_E").entry("estimated").line() + &a("msg_F").entry("unknown").line()),
    );
    let mut mapped = ledger_for(
        dir2,
        &roots(&root2),
        Opts {
            attribute: Some(Box::new(|row: &AttributionRow<'_>| {
                if row.entrypoint == Some("estimated") {
                    Attribution::Account {
                        account_id: "a3".into(),
                        estimated: true,
                    }
                } else {
                    Attribution::Unknown
                }
            })),
            ..Opts::default()
        },
    );
    mapped.tick().unwrap();
    let snap = mapped.snapshot();
    let mut whos: Vec<&String> = snap.days.get("2026-10-18").unwrap().keys().collect();
    whos.sort();
    assert_eq!(whos, ["est:a3", "unknown"]);
}

#[test]
fn files_untouched_for_90_days_are_skipped_on_first_sight_and_days_older_than_120_days_are_dropped()
{
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let old = root.join("p").join("old.jsonl");
    let recent = root.join("p").join("recent.jsonl");
    write(&old, &a("msg_A").line());
    write(
        &recent,
        &(a("msg_B").at(&iso(now0() - 130.0 * DAY)).line()
            + &a("msg_C").at(&iso(now0() - 100.0 * DAY)).line()),
    );
    set_times(&old, at_ms(now0() - 91.0 * DAY)).unwrap();
    set_times(&recent, at_ms(now0() - 89.0 * DAY)).unwrap();
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(day_keys(&ledger), ["2026-07-10"]);
    assert_eq!(totals(&ledger).responses, 1.0);
    assert_eq!(ledger.snapshot().progress.total_bytes, size(&recent));
}

#[test]
fn the_ledger_file_holds_no_transcript_text_and_is_private() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(user() + &a("msg_A").line() + &a("msg_A").line()),
    );
    write(
        &root
            .join("p")
            .join("s")
            .join("subagents")
            .join("agent.jsonl"),
        &(user() + &a("msg_B").line()),
    );
    write(
        &root
            .join("p")
            .join("s")
            .join("tool-results")
            .join("r.jsonl"),
        &format!("{PHRASE}\n"),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let file = dir.join("token-ledger.json");
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.contains(MODEL));
    assert!(!text.contains(PHRASE));
    assert!(!text.contains("fixture-project"));
    #[cfg(unix)]
    assert_eq!(mode(&file), 0o600);

    // The seen files hold only 8-byte hashes of the response ids.
    let seen = dir.join("token-ledger-seen");
    #[cfg(unix)]
    assert_eq!(mode(&seen), 0o700);
    assert_eq!(read_dir_sorted(&seen), ["2026-10-18.bin"]);
    let bin = seen.join("2026-10-18.bin");
    let bytes = fs::read(&bin).unwrap();
    assert_eq!(bytes.len(), 2 * 8);
    for needle in [PHRASE, "msg_A", "req_msg_A", MODEL] {
        assert!(
            !bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
            "{needle}"
        );
    }
    #[cfg(unix)]
    assert_eq!(mode(&bin), 0o600);
}

#[test]
fn a_response_copied_into_other_transcripts_counts_once_another_request_id_for_the_same_message_counts()
 {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let response = a("msg_A")
        .req("req_1")
        .usage(json!({ "output_tokens": 10 }));
    write(
        &root.join("p1").join("s1.jsonl"),
        &(response.line().repeat(4) + &a("msg_B").line()),
    );
    // A resumed or forked session that copied the history, then went on.
    write(
        &root.join("p2").join("s2.jsonl"),
        &(response.line().repeat(2)
            + &a("msg_B").line()
            + &a("msg_A")
                .req("req_2")
                .usage(json!({ "output_tokens": 100 }))
                .line()),
    );
    write(
        &root
            .join("p2")
            .join("s2")
            .join("subagents")
            .join("agent-1.jsonl"),
        &response.line(),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 3.0);
    assert_eq!(totals(&ledger).output, 10.0 + 2.0 + 100.0);
}

#[test]
fn a_restart_from_an_older_ledger_after_newer_seen_hashes_were_written_counts_each_response_exactly_once()
 {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let one = root.join("p").join("one.jsonl");
    let two = root.join("p").join("two.jsonl");
    let ledger_file = dir.join("token-ledger.json");
    let seen_file = dir.join("token-ledger-seen").join("2026-10-18.bin");
    let row = |id: &str, output: u32| a(id).usage(json!({ "output_tokens": output })).line();
    write(&one, &(row("msg_1", 1) + &row("msg_2", 10)));
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let older = fs::read(&ledger_file).unwrap();
    let older_seen = size(&seen_file);

    append(&one, &row("msg_3", 100));
    write(
        &two,
        &(row("msg_1", 1) + &row("msg_3", 100) + &row("msg_4", 1000)),
    );
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).output, 1111.0);
    // The crash: the seen hashes of the second tick are on disk, its ledger is not.
    assert!(size(&seen_file) > older_seen);
    fs::write(&ledger_file, &older).unwrap();

    let mut restarted = plain(dir, &root);
    assert_eq!(totals(&restarted).output, 11.0);
    assert_eq!(restarted.tick().unwrap(), done(true));
    assert_eq!(totals(&restarted).responses, 4.0);
    assert_eq!(totals(&restarted).output, 1111.0);
    // Re-reading the same bytes again changes nothing.
    fs::write(&ledger_file, &older).unwrap();
    let mut again = plain(dir, &root);
    again.tick().unwrap();
    assert_eq!(totals(&again).output, 1111.0);
    assert_eq!(size(&seen_file), 4.0 * 8.0);
}

#[test]
fn a_ledger_that_cannot_be_read_clears_the_seen_hashes_so_a_rescan_counts_everything_once() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_1").line() + &a("msg_2").line()),
    );
    plain(dir, &root).tick().unwrap();
    fs::write(dir.join("token-ledger.json"), "{not json").unwrap();
    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 2.0);
}

#[test]
fn seen_hashes_are_dropped_with_their_day() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_old").at(&iso(now0() - 100.0 * DAY)).line() + &a("msg_new").line()),
    );
    let clock = Clock::new(now0());
    let mut ledger = ledger_for(
        dir,
        &roots(&root),
        Opts {
            now: Some(clock.now()),
            ..Opts::default()
        },
    );
    ledger.tick().unwrap();
    let seen = dir.join("token-ledger-seen");
    assert_eq!(read_dir_sorted(&seen), ["2026-07-10.bin", "2026-10-18.bin"]);
    clock.set(now0() + 30.0 * DAY);
    ledger.tick().unwrap();
    assert_eq!(day_keys(&ledger), ["2026-10-18"]);
    assert_eq!(read_dir_sorted(&seen), ["2026-10-18.bin"]);
    let saved = read_json(&dir.join("token-ledger.json"));
    assert_eq!(saved["seen"], json!({ "2026-10-18": 8 }));
}

#[test]
fn synthetic_rows_are_not_counted() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_A").line()
            + &a("synthetic-1").model("<synthetic>").line()
            + &a("synthetic-2").model("<synthetic>").line()),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 1.0);
    let snap = ledger.snapshot();
    let models: Vec<&String> = snap
        .days
        .get("2026-10-18")
        .unwrap()
        .get("acct:a1")
        .unwrap()
        .keys()
        .collect();
    assert_eq!(models, [MODEL]);
}

#[test]
fn at_most_16_days_of_seen_hashes_are_in_memory_and_an_evicted_day_still_finds_its_copies() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let at = |k: f64| iso(now0() - k * DAY);
    let mut original = String::new();
    let mut copies = String::new();
    for k in 1..=20 {
        let k = f64::from(k);
        original += &a(&format!("msg_{k}")).at(&at(k)).line();
        copies += &(a(&format!("msg_{k}")).at(&at(k)).line()
            + &a(&format!("msg_new_{k}")).at(&at(k)).line());
    }
    write(&root.join("p").join("a.jsonl"), &original);
    write(&root.join("p").join("b.jsonl"), &copies);
    let peak = Arc::new(AtomicUsize::new(0));
    let gauge: Arc<Mutex<Option<Arc<AtomicUsize>>>> = Arc::new(Mutex::new(None));
    let options = || {
        let (peak, gauge) = (Arc::clone(&peak), Arc::clone(&gauge));
        Opts {
            attribute: Some(Box::new(move |_: &AttributionRow<'_>| {
                if let Some(gauge) = gauge.lock().unwrap().as_ref() {
                    peak.fetch_max(gauge.load(Ordering::Relaxed), Ordering::Relaxed);
                }
                acct("a1")
            })),
            ..Opts::default()
        }
    };
    let mut ledger = ledger_for(dir, &roots(&root), options());
    *gauge.lock().unwrap() = Some(ledger.seen_days_gauge());
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 40.0);
    assert_eq!(peak.load(Ordering::Relaxed), 16);
    assert!(ledger.seen_days_in_memory() <= 16);

    // After a restart the evicted days come back from disk.
    write(&root.join("p").join("c.jsonl"), &original);
    let mut ledger = ledger_for(dir, &roots(&root), options());
    *gauge.lock().unwrap() = Some(ledger.seen_days_gauge());
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 40.0);
    assert!(ledger.seen_days_in_memory() <= 16);
}

#[test]
fn while_a_scan_spans_ticks_the_ledger_is_written_at_most_every_10_s_and_always_when_a_pass_ends() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let ledger_file = dir.join("token-ledger.json");
    let mut rows: Vec<String> = Vec::new();
    let mut size = 0;
    while (size as f64) < 3.5 * CHUNK as f64 {
        let row = a(&format!("msg_{}", rows.len())).pad(1500).line();
        size += row.len();
        rows.push(row);
    }
    write(&root.join("p").join("s.jsonl"), &rows.concat());
    let clock = Clock::new(now0());
    let mut ledger = ledger_for(
        dir,
        &roots(&root),
        Opts {
            budget_ms: Some(1.0),
            now: Some(clock.now()),
            attribute: Some(clock.costly(0.01)),
            ..Opts::default()
        },
    );
    let saved = || fs::read_to_string(&ledger_file).unwrap();
    assert!(!ledger.tick().unwrap().complete);
    let first = saved();
    assert!(!ledger.tick().unwrap().complete);
    assert_eq!(saved(), first);
    clock.add(10_000.0);
    assert!(!ledger.tick().unwrap().complete);
    let third = saved();
    assert_ne!(third, first);
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_ne!(saved(), third);
    let seen: Value = serde_json::from_str(&saved()).unwrap();
    assert_eq!(seen["seen"]["2026-10-18"], json!(rows.len() * 8));
}

fn streamed(output: u32, more: Value, at: Option<&str>) -> String {
    let mut usage = json!({ "output_tokens": output });
    for (key, value) in more.as_object().unwrap() {
        usage[key] = value.clone();
    }
    let fx = a("msg_S").req("req_S").usage(usage);
    match at {
        Some(at) => fx.at(at).line(),
        None => fx.line(),
    }
}

#[test]
fn a_streamed_response_counts_its_largest_usage_once() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let more = |input: u32, write: u32, read: u32| {
        json!({
            "input_tokens": input,
            "cache_creation_input_tokens": write,
            "cache_read_input_tokens": read,
        })
    };
    write(
        &root.join("p").join("s.jsonl"),
        &(streamed(1, more(5, 10, 100), None)
            + &streamed(1, more(7, 10, 300), None)
            + &streamed(37, more(6, 12, 200), None)
            + &streamed(120, more(7, 12, 300), None)),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger), sum(7.0, 120.0, 12.0, 300.0, 1.0));
}

#[test]
fn a_streamed_response_split_across_ticks_and_a_restart_still_counts_its_largest_usage_in_its_first_row_s_bucket()
 {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("s.jsonl");
    write(
        &file,
        &(streamed(1, json!({}), None) + &streamed(1, json!({}), None)),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).output, 1.0);
    append(&file, &streamed(37, json!({}), None));
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).output, 37.0);

    let mut restarted = plain(dir, &root);
    // The last row was written after midnight; the response stays on its day.
    append(
        &file,
        &(streamed(120, json!({}), Some("2026-10-19T00:00:05+03:00")) + &a("msg_T").line()),
    );
    restarted.tick().unwrap();
    assert_eq!(
        totals(&restarted),
        sum(1.0 + 1.0, 120.0 + 2.0, 3.0 + 3.0, 4.0 + 4.0, 2.0)
    );
    assert_eq!(day_keys(&restarted), ["2026-10-18"]);
}

#[test]
fn a_copy_in_another_transcript_is_skipped_even_when_it_has_more_rows() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let s = |output| streamed(output, json!({}), None);
    write(&root.join("p").join("a.jsonl"), &(s(1) + &s(1)));
    write(
        &root.join("p").join("b.jsonl"),
        &(s(1) + &s(1) + &s(37) + &s(120)),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).output, 1.0);
    assert_eq!(totals(&ledger).responses, 1.0);
}

#[test]
fn ids_and_models_out_of_shape_no_id_skips_the_row_odd_ids_skip_dedupe_a_long_model_is_unknown() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let mut no_id = a("msg_X").value();
    no_id["message"].as_object_mut().unwrap().shift_remove("id");
    let mut numeric_id = a("msg_Y").value();
    numeric_id["message"]["id"] = json!(42);
    let long_request = a("msg_L").req(&"r".repeat(300)).line();
    write(
        &root.join("p").join("s.jsonl"),
        &(serde_json::to_string(&no_id).unwrap()
            + "\n"
            + &serde_json::to_string(&numeric_id).unwrap()
            + "\n"
            + &long_request
            + &long_request
            + &a("msg_M").model(&"m".repeat(101)).line()
            + &a("msg_N").model(&"m".repeat(100)).line()),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let snap = ledger.snapshot();
    let by_model = snap.days.get("2026-10-18").unwrap().get("acct:a1").unwrap();
    assert_eq!(by_model.get(MODEL).unwrap().responses, 2.0);
    assert_eq!(by_model.get("unknown").unwrap().responses, 1.0);
    assert_eq!(by_model.get(&"m".repeat(100)).unwrap().responses, 1.0);
    assert_eq!(totals(&ledger).responses, 4.0);
}

// Windows has no POSIX file modes to make a file unreadable.
#[cfg(unix)]
#[test]
fn a_transcript_that_cannot_be_read_is_skipped_for_the_pass_and_read_on_a_later_one() {
    if is_root() {
        return; // root reads any file
    }
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let locked = root.join("p").join("a.jsonl");
    write(&locked, &a("msg_A").line());
    write(&root.join("p").join("b.jsonl"), &a("msg_B").line());
    let mut ledger = plain(dir, &root);
    chmod(&locked, 0o000);
    let first = ledger.tick();
    chmod(&locked, 0o600);
    assert_eq!(first.unwrap(), done(true));
    assert_eq!(totals(&ledger).responses, 1.0);
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 2.0);
}

// Windows has no POSIX file modes to make a file unreadable.
#[cfg(unix)]
#[test]
fn a_seen_day_that_cannot_be_read_fails_the_tick_and_a_later_tick_counts_once() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(&root.join("p").join("s.jsonl"), &a("msg_A").line());
    let mut ledger = plain(dir, &root);
    let day = dir.join("token-ledger-seen").join("2026-10-18.bin");
    fs::create_dir_all(&day).unwrap();
    assert!(ledger.tick().is_err());
    assert_eq!(totals(&ledger).responses, 0.0);
    fs::remove_dir(&day).unwrap();
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 1.0);
    assert_eq!(size(&day), 8.0);

    // A day file that exists but cannot be opened is not an empty day.
    if is_root() {
        return;
    }
    let mut restarted = plain(dir, &root);
    write(
        &root.join("p").join("t.jsonl"),
        &(a("msg_A").line() + &a("msg_B").line()),
    );
    chmod(&day, 0o000);
    let failed = restarted.tick();
    let counted = totals(&restarted).responses;
    chmod(&day, 0o600);
    assert!(failed.is_err());
    assert_eq!(counted, 1.0);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 2.0);
}

#[test]
fn seen_files_that_cannot_be_restored_start_the_ledger_over_and_the_rescan_counts_once() {
    for damage in ["directory", "symlink", "file"] {
        let dir = temp_dir();
        let dir = dir.path();
        let root = dir.join("projects");
        write(
            &root.join("p").join("s.jsonl"),
            &(a("msg_A").line() + &a("msg_B").line()),
        );
        plain(dir, &root).tick().unwrap();
        let seen = dir.join("token-ledger-seen");
        let elsewhere = dir.join("elsewhere");
        match damage {
            "directory" => {
                fs::remove_file(seen.join("2026-10-18.bin")).unwrap();
                fs::create_dir(seen.join("2026-10-18.bin")).unwrap();
            }
            "symlink" => {
                fs::rename(&seen, &elsewhere).unwrap();
                symlink_dir(&elsewhere, &seen);
            }
            _ => {
                fs::remove_dir_all(&seen).unwrap();
                fs::write(&seen, "not a directory").unwrap();
            }
        }
        let mut restarted = plain(dir, &root);
        assert!(restarted.snapshot().days.is_empty(), "{damage}");
        restarted.tick().unwrap();
        assert_eq!(totals(&restarted).responses, 2.0, "{damage}");
        let info = fs::symlink_metadata(&seen).unwrap();
        assert!(info.is_dir() && !info.is_symlink(), "{damage}");
        assert_eq!(read_dir_sorted(&seen), ["2026-10-18.bin"], "{damage}");
        if damage == "symlink" {
            assert_eq!(read_dir_sorted(&elsewhere), ["2026-10-18.bin"]);
        }
    }
}

#[test]
fn a_new_time_zone_starts_the_ledger_over_in_that_zone() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &a("msg_A").at("2026-10-18T01:00:00+03:00").line(),
    );
    let zone = Zone::new();
    let with_zone = || Opts {
        zone: Some(zone.get()),
        ..Opts::default()
    };
    let mut ledger = ledger_for(dir, &roots(&root), with_zone());
    ledger.tick().unwrap();
    assert_eq!(day_keys(&ledger), ["2026-10-18"]);
    zone.set("UTC");
    ledger.tick().unwrap();
    assert_eq!(day_keys(&ledger), ["2026-10-17"]);
    assert_eq!(totals(&ledger).responses, 1.0);
    assert_eq!(
        read_dir_sorted(&dir.join("token-ledger-seen")),
        ["2026-10-17.bin"]
    );
    let mut restarted = ledger_for(dir, &roots(&root), with_zone());
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 1.0);
    assert_eq!(
        read_json(&dir.join("token-ledger.json"))["zone"],
        json!("UTC")
    );
}

#[test]
fn seen_files_are_made_private_again_on_load() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(&root.join("p").join("s.jsonl"), &a("msg_A").line());
    plain(dir, &root).tick().unwrap();
    let bin = dir.join("token-ledger-seen").join("2026-10-18.bin");
    #[cfg(unix)]
    chmod(&bin, 0o644);
    plain(dir, &root);
    #[cfg(unix)]
    assert_eq!(mode(&bin), 0o600);
    assert!(bin.exists());
}

/// Rows enough for a pass over several 1 ms ticks; how many were written.
fn big_transcript(file: &Path, prefix: &str) -> f64 {
    let mut rows: Vec<String> = Vec::new();
    let mut size = 0;
    while (size as f64) < 2.5 * CHUNK as f64 {
        let row = a(&format!("{prefix}_{}", rows.len())).pad(1500).line();
        size += row.len();
        rows.push(row);
    }
    write(file, &rows.concat());
    rows.len() as f64
}

/// A 1 ms budget on a fake clock that each counted response moves.
fn slow_ticks() -> Opts {
    let clock = Clock::new(now0());
    Opts {
        budget_ms: Some(1.0),
        now: Some(clock.now()),
        attribute: Some(clock.costly(0.01)),
        ..Opts::default()
    }
}

#[test]
fn after_a_time_zone_change_the_ledger_is_incomplete_until_the_rebuild_ends_and_its_unfinished_pass_ticks_every_2_s()
 {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let rows = big_transcript(&root.join("p").join("s.jsonl"), "msg");
    let zone = Zone::new();
    let mut ledger = ledger_for(
        dir,
        &roots(&root),
        Opts {
            zone: Some(zone.get()),
            ..slow_ticks()
        },
    );
    assert!(!ledger.snapshot().progress.complete);
    let mut last = ledger.tick().unwrap();
    while !last.complete {
        assert!(!ledger.snapshot().progress.complete);
        assert_eq!(token_tick_delay(last), TOKEN_FIRST_SCAN_TICK_MS);
        last = ledger.tick().unwrap();
    }
    assert!(ledger.snapshot().progress.complete);
    assert_eq!(token_tick_delay(last), TOKEN_TICK_MS);

    zone.set("UTC");
    let mut ticks = 0;
    loop {
        last = ledger.tick().unwrap();
        ticks += 1;
        if !last.complete {
            assert!(!ledger.snapshot().progress.complete, "tick {ticks}");
            assert_eq!(token_tick_delay(last), TOKEN_FIRST_SCAN_TICK_MS);
        }
        assert!(ticks < 20, "the rebuild never completed");
        if last.complete {
            break;
        }
    }
    assert!(ticks >= 2, "only {ticks} ticks");
    assert!(ledger.snapshot().progress.complete);
    assert_eq!(totals(&ledger).responses, rows);
    assert_eq!(token_tick_delay(last), TOKEN_TICK_MS);
    // A failed tick backs off to the slow pace.
    assert_eq!(token_tick_delay(LastTick::Failed), TOKEN_TICK_MS);
    assert_eq!(TOKEN_TICK_MS, 5 * 60_000);
    assert_eq!(TOKEN_FIRST_SCAN_TICK_MS, 2_000);
}

#[test]
fn a_later_pass_that_spans_ticks_keeps_the_2_s_pace_while_the_ledger_stays_complete_and_a_restart_after_it_is_complete_at_once()
 {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(&root.join("p").join("a.jsonl"), &a("msg_first").line());
    let mut ledger = ledger_for(dir, &roots(&root), slow_ticks());
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert!(ledger.snapshot().progress.complete);

    let rows = big_transcript(&root.join("p").join("b.jsonl"), "msg");
    let mut ticks = 0;
    loop {
        let last = ledger.tick().unwrap();
        ticks += 1;
        assert!(ledger.snapshot().progress.complete, "tick {ticks}");
        assert_eq!(
            token_tick_delay(last),
            if last.complete {
                TOKEN_TICK_MS
            } else {
                TOKEN_FIRST_SCAN_TICK_MS
            }
        );
        assert!(ticks < 20, "the pass never completed");
        if last.complete {
            break;
        }
    }
    assert!(ticks >= 2, "only {ticks} ticks");
    assert_eq!(totals(&ledger).responses, rows + 1.0);
    // The finished pass is saved with the counts.
    let restarted = plain(dir, &root);
    assert!(restarted.snapshot().progress.complete);
}

#[test]
fn a_ledger_that_cannot_be_saved_says_so_in_its_progress_and_keeps_counting() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(&root.join("p").join("s.jsonl"), &a("msg_A").line());
    let mut ledger = ledger_for(
        dir,
        &roots(&root),
        Opts {
            max_bytes: Some(64),
            ..Opts::default()
        },
    );
    assert_eq!(ledger.snapshot().progress.error, None);
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_eq!(totals(&ledger).responses, 1.0);
    assert_eq!(ledger.snapshot().progress.error, Some(true));
    assert!(!dir.join("token-ledger.json").exists());
    append(&root.join("p").join("s.jsonl"), &a("msg_B").line());
    assert_eq!(ledger.tick().unwrap(), done(true));
    assert_eq!(totals(&ledger).responses, 2.0);
    assert_eq!(ledger.snapshot().progress.error, Some(true));
}

#[test]
fn a_saved_ledger_whose_seen_hashes_are_missing_starts_over_and_the_rescan_counts_once() {
    for missing in ["file", "directory"] {
        let dir = temp_dir();
        let dir = dir.path();
        let root = dir.join("projects");
        write(
            &root.join("p").join("s.jsonl"),
            &(a("msg_A").line() + &a("msg_B").line()),
        );
        plain(dir, &root).tick().unwrap();
        let seen = dir.join("token-ledger-seen");
        if missing == "file" {
            fs::remove_file(seen.join("2026-10-18.bin")).unwrap();
        } else {
            fs::remove_dir_all(&seen).unwrap();
        }
        let mut restarted = plain(dir, &root);
        assert!(restarted.snapshot().days.is_empty(), "{missing}");
        assert!(!restarted.snapshot().progress.complete, "{missing}");
        // A copy of a counted response, in a new transcript, is still found.
        write(&root.join("p").join("copy.jsonl"), &a("msg_A").line());
        restarted.tick().unwrap();
        assert_eq!(totals(&restarted).responses, 2.0, "{missing}");
        assert_eq!(read_dir_sorted(&seen), ["2026-10-18.bin"], "{missing}");
    }
}

#[test]
fn the_ledger_keys_transcripts_by_a_hash_of_their_path_and_holds_no_paths() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("secret-project-name").join("s.jsonl");
    let ledger_file = dir.join("token-ledger.json");
    write(&file, &a("msg_A").line());
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let text = fs::read_to_string(&ledger_file).unwrap();
    let saved: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(saved["version"], json!(3));
    assert_eq!(
        saved["files"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        [&key_of(&file)]
    );
    assert!(!text.contains("secret-project-name"));
    assert!(!text.contains("s.jsonl"));
    assert!(!text.contains(&*dir.to_string_lossy()));
    // Appended rows are found again by the hashed key, also after a restart.
    append(&file, &a("msg_B").line());
    ledger.tick().unwrap();
    assert_eq!(totals(&ledger).responses, 2.0);
    let mut restarted = plain(dir, &root);
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 2.0);
    append(&file, &a("msg_C").line());
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 3.0);
}

fn an_older_ledger_is_dropped(version: u32) {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("s.jsonl");
    let ledger_file = dir.join("token-ledger.json");
    write(&file, &(a("msg_A").line() + &a("msg_B").line()));
    plain(dir, &root).tick().unwrap();
    let mut saved = read_json(&ledger_file);
    saved["version"] = json!(version);
    if version == 1 {
        let state = saved["files"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()
            .clone();
        let mut files = serde_json::Map::new();
        files.insert(file.to_string_lossy().into_owned(), state);
        saved["files"] = Value::Object(files);
    }
    fs::write(&ledger_file, serde_json::to_string(&saved).unwrap()).unwrap();
    let mut restarted = plain(dir, &root);
    assert!(restarted.snapshot().days.is_empty());
    restarted.tick().unwrap();
    assert_eq!(totals(&restarted).responses, 2.0);
    let text = fs::read_to_string(&ledger_file).unwrap();
    assert!(!text.contains(&*file.to_string_lossy()));
    assert_eq!(
        serde_json::from_str::<Value>(&text).unwrap()["version"],
        json!(3)
    );
}

#[test]
fn a_version_1_ledger_keyed_by_paths_is_dropped_and_the_rescan_counts_once() {
    an_older_ledger_is_dropped(1);
}

#[test]
fn a_version_2_ledger_attributed_with_the_narrower_estimate_is_dropped_and_the_rescan_counts_once()
{
    an_older_ledger_is_dropped(2);
}

#[test]
fn a_transcript_idle_for_over_2_days_keeps_no_last_response() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let idle = root.join("p").join("idle.jsonl");
    let fresh = root.join("p").join("fresh.jsonl");
    write(&idle, &a("msg_A").line());
    write(&fresh, &a("msg_B").line());
    set_times(&idle, at_ms(now0() - 3.0 * DAY)).unwrap();
    set_times(&fresh, at_ms(now0() - DAY)).unwrap();
    plain(dir, &root).tick().unwrap();
    let saved = read_json(&dir.join("token-ledger.json"));
    let idle_state = &saved["files"][key_of(&idle)];
    assert_eq!(idle_state["offset"].as_f64(), Some(size(&idle)));
    assert!(idle_state.get("lastKey").is_none());
    assert!(idle_state.get("last").is_none());
    let fresh_state = &saved["files"][key_of(&fresh)];
    assert_eq!(fresh_state["lastKey"], json!("msg_B:req_msg_B"));
    assert_eq!(fresh_state["last"]["date"], json!("2026-10-18"));
}

fn near(actual: Option<f64>, expected: f64) {
    assert!(
        actual.is_some_and(|actual| (actual - expected).abs() < 1e-12),
        "{actual:?} ≠ {expected}"
    );
}

fn opus_usage() -> Value {
    json!({
        "input_tokens": 1000,
        "output_tokens": 2000,
        "cache_creation_input_tokens": 3000,
        "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 3000 },
        "cache_read_input_tokens": 4000,
    })
}
/// 1000 × $4 + 3000 × $8 (1-hour) + 4000 × $0.20 + 2000 × $20, per million.
const OPUS_COST: f64 = 0.0688;

fn slot_keys(ledger: &TokenLedger, date: &str, who: &str) -> Vec<String> {
    let snap = ledger.snapshot();
    snap.slots
        .unwrap()
        .get(date)
        .unwrap()
        .get(who)
        .unwrap()
        .keys()
        .cloned()
        .collect()
}

#[test]
fn a_response_is_priced_into_its_day_bucket_and_its_quarter_hour_slot() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &a("msg_C")
            .model("claude-opus-5-5")
            .usage(opus_usage())
            .line(),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let snap = ledger.snapshot();
    let counts = counts_at(&ledger, "2026-10-18", "acct:a1", "claude-opus-5-5");
    near(counts.cost, OPUS_COST);
    assert_eq!(counts.unpriced, Some(0.0));
    assert_eq!(counts.cost_estimated, None);
    // 09:00Z is 12:00 in Istanbul: quarter hour 48.
    assert_eq!(slot_keys(&ledger, "2026-10-18", "acct:a1"), ["48"]);
    let slot = snap
        .slots
        .as_ref()
        .unwrap()
        .get("2026-10-18")
        .unwrap()
        .get("acct:a1")
        .unwrap()
        .get("48")
        .unwrap();
    near(Some(slot.cost), OPUS_COST);
    assert_eq!(slot.output, 2000.0);
    // Counted from scratch: every kept day's slots are whole.
    assert_eq!(snap.slots_since, Some(0.0));
}

#[test]
fn a_streamed_response_adds_only_what_its_later_rows_grew_in_cost_too_and_a_copy_adds_nothing() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let first = a("msg_S").model("claude-opus-5-5").usage(opus_usage());
    let grown = first.clone().usage(json!({ "output_tokens": 5000 }));
    write(
        &root.join("p").join("s.jsonl"),
        &(first.line() + &grown.line()),
    );
    write(&root.join("p").join("copy.jsonl"), &grown.line());
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let snap = ledger.snapshot();
    let counts = counts_at(&ledger, "2026-10-18", "acct:a1", "claude-opus-5-5");
    near(counts.cost, OPUS_COST + (3000.0 * 20.0) / 1e6);
    assert_eq!(counts.output, 5000.0);
    let slot = snap
        .slots
        .as_ref()
        .unwrap()
        .get("2026-10-18")
        .unwrap()
        .get("acct:a1")
        .unwrap()
        .get("48")
        .unwrap();
    near(Some(slot.cost), OPUS_COST + 0.06);
}

#[test]
fn a_model_with_no_price_adds_its_tokens_to_unpriced_streamed_rows_included() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let row = a("msg_U")
        .model("mystery-model")
        .usage(json!({ "input_tokens": 10 }));
    write(
        &root.join("p").join("s.jsonl"),
        &(row.line()
            + &row
                .clone()
                .usage(json!({ "input_tokens": 10, "output_tokens": 30 }))
                .line()),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let counts = counts_at(&ledger, "2026-10-18", "acct:a1", "mystery-model");
    assert_eq!(counts.cost, Some(0.0));
    // 10 + 30 + the fixture's 3 cache write and 4 cache read.
    assert_eq!(counts.unpriced, Some(47.0));
}

#[test]
fn fast_mode_and_us_inference_come_from_the_row() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let usage = |extra: Value| {
        let mut usage = json!({
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        });
        for (key, value) in extra.as_object().unwrap() {
            usage[key] = value.clone();
        }
        usage
    };
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_F")
            .model("claude-opus-5-5")
            .usage(usage(json!({ "speed": "fast" })))
            .line()
            + &a("msg_G")
                .model("claude-opus-5-5")
                .usage(usage(json!({ "inference_geo": "us" })))
                .line()),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    near(
        counts_at(&ledger, "2026-10-18", "acct:a1", "claude-opus-5-5").cost,
        8.0 + 4.4,
    );
}

#[test]
fn only_the_last_8_days_keep_slots() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(
        &root.join("p").join("s.jsonl"),
        &(a("msg_old").at("2026-10-10T09:00:00.000Z").line()
            + &a("msg_kept").at("2026-10-11T09:00:00.000Z").line()),
    );
    let mut ledger = plain(dir, &root);
    ledger.tick().unwrap();
    let snap = ledger.snapshot();
    assert!(snap.days.contains_key("2026-10-10") && snap.days.contains_key("2026-10-11"));
    assert_eq!(
        snap.slots.unwrap().keys().collect::<Vec<_>>(),
        ["2026-10-11"]
    );
    let clock = Clock::new(now0());
    let mut later = ledger_for(
        dir,
        &roots(&root),
        Opts {
            now: Some(clock.now()),
            ..Opts::default()
        },
    );
    clock.set(now0() + 2.0 * DAY);
    later.tick().unwrap();
    assert!(later.snapshot().slots.unwrap().is_empty());
}

#[test]
fn buckets_counted_before_costs_were_kept_are_estimated_once_and_saved_costs_survive_a_restart() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    fs::create_dir_all(&root).unwrap();
    let old = json!({ "input": 1_000_000, "output": 0, "cacheWrite": 1_000_000, "cacheRead": 0, "responses": 3 });
    fs::write(
        dir.join("token-ledger.json"),
        serde_json::to_string(&json!({
            "version": 3,
            "zone": ZONE,
            "complete": true,
            "files": {},
            "days": {
                "2026-10-17": {
                    "acct:a1": { "claude-opus-5-5": old, "mystery-model": old.clone() },
                },
            },
            "seen": {},
        }))
        .unwrap(),
    )
    .unwrap();
    let mut ledger = plain(dir, &root);
    let opus = counts_at(&ledger, "2026-10-17", "acct:a1", "claude-opus-5-5");
    near(opus.cost, 4.0 + 8.0);
    assert_eq!(opus.cost_estimated, Some(true));
    assert_eq!(
        counts_at(&ledger, "2026-10-17", "acct:a1", "mystery-model").unpriced,
        Some(2_000_000.0)
    );
    // The slot note starts from the first tick after the upgrade.
    assert_eq!(ledger.snapshot().slots_since, None);
    ledger.tick().unwrap();
    assert_eq!(ledger.snapshot().slots_since, Some(now0()));
    let restarted = plain(dir, &root);
    let opus = counts_at(&restarted, "2026-10-17", "acct:a1", "claude-opus-5-5");
    near(opus.cost, 12.0);
    assert_eq!(opus.cost_estimated, Some(true));
    assert_eq!(
        counts_at(&restarted, "2026-10-17", "acct:a1", "mystery-model").unpriced,
        Some(2_000_000.0)
    );
    assert_eq!(restarted.snapshot().slots_since, Some(now0()));
}

#[test]
fn slots_are_saved_restored_and_emptied_with_everything_on_a_zone_change() {
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    write(&root.join("p").join("s.jsonl"), &a("msg_Z").line());
    let zone = Zone::new();
    let with_zone = || Opts {
        zone: Some(zone.get()),
        ..Opts::default()
    };
    let mut ledger = ledger_for(dir, &roots(&root), with_zone());
    ledger.tick().unwrap();
    let mut restarted = ledger_for(dir, &roots(&root), with_zone());
    assert_eq!(restarted.snapshot().slots, ledger.snapshot().slots);
    zone.set("UTC");
    restarted.tick().unwrap();
    let snap = restarted.snapshot();
    // The rescan counts the row again, in the new zone's quarter hour.
    assert_eq!(slot_keys(&restarted, "2026-10-18", "acct:a1"), ["36"]);
    assert_eq!(snap.slots_since, Some(0.0));
}

#[test]
fn the_saved_ledger_reads_back_in_the_electron_app_s_shape() {
    // Byte-compat check beyond the TS cases: key order and numbers as JSON.stringify writes them.
    let dir = temp_dir();
    let dir = dir.path();
    let root = dir.join("projects");
    let file = root.join("p").join("s.jsonl");
    write(&file, &a("msg_A").line());
    set_times(&file, at_ms(now0() - DAY)).unwrap();
    plain(dir, &root).tick().unwrap();
    let saved = read_json(&dir.join("token-ledger.json"));
    let keys = |value: &Value| {
        value
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(
        keys(&saved),
        [
            "version",
            "zone",
            "complete",
            "files",
            "days",
            "slots",
            "slotsSince",
            "pricedAt",
            "seen"
        ]
    );
    let state = &saved["files"][key_of(&file)];
    assert_eq!(
        keys(state),
        ["dev", "ino", "size", "offset", "mtimeMs", "lastKey", "last"]
    );
    assert_eq!(
        keys(&state["last"]),
        [
            "date",
            "who",
            "model",
            "input",
            "output",
            "cacheWrite",
            "cacheRead",
            "cost",
            "slot"
        ]
    );
    let counts = &saved["days"]["2026-10-18"]["acct:a1"][MODEL];
    assert_eq!(
        keys(counts),
        [
            "input",
            "output",
            "cacheWrite",
            "cacheRead",
            "responses",
            "cost",
            "unpriced"
        ]
    );
    assert_eq!(counts["input"].to_string(), "1");
    assert_eq!(saved["slotsSince"].to_string(), "0");
}
