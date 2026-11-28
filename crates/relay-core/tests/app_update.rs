//! Port of tests/app-update.test.ts. The Windows and Linux cases are rewritten for the Rust
//! driver that replaced electron-updater (`win_linux_update`): a local HTTP server serves the
//! release feed, the installer and its sums, signed with a throwaway key.

#[path = "common/platform.rs"]
mod platform;
#[path = "common/signing.rs"]
mod signing;

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use platform::{Reply, TestServer};
use relay_core::app_update::{
    AppUpdates, AppUpdatesDeps, CHECK_EVERY_MS, FIRST_CHECK_MS, RETRY_CHECK_MS, ReleaseAsset,
    UPDATE_BUSY, UpdateDriver, UpdateError, UpdatePatch, UpdateRequest, UpdateResponse,
    UpdateTimers, compare_versions, newest_release, parse_checksums, release_from,
};
use relay_core::detached_exec::ExecOutput;
use relay_core::install_location::BundlePlace;
use relay_core::mac_update::{
    INSTALL_SCRIPT, MacUpdateDeps, MacUpdateDriver, UPDATE_CHECKSUM_MISMATCH, UPDATE_NO_CHECKSUM,
    UPDATE_SIGNATURE_MISMATCH, designated_requirement, dmg_for,
};
use relay_core::relay_paths::Platform;
use relay_core::shared::error_text::localize_error;
use relay_core::shared::types::js::date_parse;
use relay_core::shared::types::{UpdateChannel, UpdateManualReason as Manual, UpdateStatus as S};
use relay_core::win_linux_update::{WinLinuxUpdateDeps, WinLinuxUpdateDriver, installer_name};
use relay_i18n::Locale;
use serde_json::{Value, json};
use signing::{TestKey, sha256_hex};

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-update-")
        .tempdir()
        .unwrap()
}

fn cmp(a: &str, b: &str) -> Ordering {
    compare_versions(a, b).unwrap()
}

#[test]
fn versions_compare_by_number_and_a_pre_release_is_older_than_its_release() {
    assert_eq!(cmp("0.16.0", "0.15.9"), Ordering::Greater);
    assert_eq!(cmp("v0.15.10", "0.15.9"), Ordering::Greater);
    assert_eq!(cmp("1.0.0", "v1.0.0"), Ordering::Equal);
    assert_eq!(cmp("0.16.0-test", "0.16.0"), Ordering::Less);
    assert_eq!(cmp("0.15.0", "0.16.0"), Ordering::Less);
    assert!(compare_versions("latest", "0.1.0").is_err());
}

#[test]
fn a_release_comes_from_the_feed_only_when_published_and_stable_with_its_https_assets() {
    let stable = UpdateChannel::Stable;
    let release = release_from(
        &json!({
            "tag_name": "v0.16.0",
            "assets": [
                { "name": "Relay-0.16.0-arm64.dmg", "browser_download_url": "https://example.test/a.dmg", "size": 10 },
                { "name": "x", "browser_download_url": "http://bad.example/x", "size": 1 },
                { "name": "y", "browser_download_url": "http://localhost.evil.test/y", "size": 1 }
            ]
        }),
        stable,
    );
    // A local test feed may serve over plain http from this computer.
    assert_eq!(
        release_from(
            &json!({ "tag_name": "v0.16.0", "assets": [{ "name": "z", "browser_download_url": "http://127.0.0.1:8765/z", "size": 1 }] }),
            stable
        )
        .unwrap()
        .assets
        .len(),
        1
    );
    let release = release.unwrap();
    assert_eq!(release.version, "0.16.0");
    assert_eq!(
        release.notes_url,
        "https://github.com/ahmetcankacar54/relay/releases/tag/v0.16.0"
    );
    assert_eq!(
        release.assets,
        vec![ReleaseAsset {
            name: "Relay-0.16.0-arm64.dmg".into(),
            url: "https://example.test/a.dmg".into(),
            size: 10
        }]
    );
    assert_eq!(
        release_from(&json!({ "tag_name": "v0.16.0", "draft": true }), stable),
        None
    );
    assert_eq!(
        release_from(
            &json!({ "tag_name": "v0.16.0", "prerelease": true }),
            stable
        ),
        None
    );
    assert_eq!(
        release_from(&json!({ "tag_name": "v0.16.0-beta" }), stable),
        None
    );
    assert_eq!(
        release_from(&json!({ "tag_name": "nightly" }), stable),
        None
    );
    assert_eq!(release_from(&Value::Null, stable), None);
}

fn asset(name: &str, url: &str) -> ReleaseAsset {
    ReleaseAsset {
        name: name.into(),
        url: url.into(),
        size: 1,
    }
}

#[test]
fn checksums_the_macs_dmg_and_the_designated_requirement_are_read_strictly() {
    let sums = parse_checksums(&format!(
        "{}  Relay-0.16.0-arm64.dmg\n{} *INSTALL.txt\nnot a line\n",
        "A".repeat(64),
        "b".repeat(64)
    ));
    assert_eq!(sums.get("Relay-0.16.0-arm64.dmg"), Some(&"a".repeat(64)));
    assert_eq!(sums.get("INSTALL.txt"), Some(&"b".repeat(64)));
    assert_eq!(sums.len(), 2);
    let assets = vec![
        asset("Relay-0.16.0-arm64.dmg", "https://x/1"),
        asset("Relay-0.16.0-x64.dmg", "https://x/2"),
    ];
    assert_eq!(
        dmg_for(&assets, "0.16.0", "arm64").unwrap().url,
        "https://x/1"
    );
    assert_eq!(
        dmg_for(&assets, "0.16.0", "x64").unwrap().url,
        "https://x/2"
    );
    assert_eq!(dmg_for(&assets, "0.16.0", "ia32"), None);
    let display = "Executable=/Applications/Relay.app/Contents/MacOS/Relay\ndesignated => identifier \"dev.relay.workspace\" and certificate leaf = H\"32508c2b\"\n";
    assert_eq!(
        designated_requirement(display).unwrap(),
        "identifier \"dev.relay.workspace\" and certificate leaf = H\"32508c2b\""
    );
    // An ad-hoc signature has only a cdhash requirement: nothing could be checked against it.
    assert_eq!(
        designated_requirement("designated => cdhash H\"abc\"")
            .unwrap_err()
            .0,
        UPDATE_SIGNATURE_MISMATCH
    );
}

/// A driver that answers with fixed steps.
struct FakeDriver {
    steps: Mutex<Vec<UpdatePatch>>,
    fail: Option<String>,
    installs: Mutex<u32>,
}

fn fake_driver(steps: Vec<UpdatePatch>, fail: Option<&str>) -> Arc<FakeDriver> {
    Arc::new(FakeDriver {
        steps: Mutex::new(steps),
        fail: fail.map(str::to_owned),
        installs: Mutex::new(0),
    })
}

impl UpdateDriver for FakeDriver {
    fn check(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        let steps = self.steps.lock().unwrap().clone();
        for step in steps {
            report(step);
        }
        match &self.fail {
            Some(message) => Err(UpdateError(message.clone())),
            None => Ok(()),
        }
    }
    fn install(&self) -> Result<(), UpdateError> {
        *self.installs.lock().unwrap() += 1;
        Ok(())
    }
}

type Pending = Option<Box<dyn FnOnce() + Send>>;

/// Timers that only record: a test runs one when it likes.
#[derive(Default)]
struct FakeTimers {
    set: Mutex<Vec<(u64, Pending)>>,
}

impl UpdateTimers for FakeTimers {
    fn set_timeout(&self, run: Box<dyn FnOnce() + Send>, ms: u64) -> u64 {
        let mut set = self.set.lock().unwrap();
        set.push((ms, Some(run)));
        set.len() as u64 - 1
    }
    fn clear_timeout(&self, _id: u64) {}
}

impl FakeTimers {
    fn ms(&self) -> Vec<u64> {
        self.set.lock().unwrap().iter().map(|(ms, _)| *ms).collect()
    }
    fn run(&self, index: usize) {
        let run = self.set.lock().unwrap()[index].1.take().unwrap();
        run();
    }
}

struct Updates {
    app: AppUpdates,
    _dir: Option<tempfile::TempDir>,
    folder: PathBuf,
    notified: Arc<Mutex<Vec<String>>>,
    timers: Arc<FakeTimers>,
    quits: Arc<Mutex<u32>>,
    busy: Arc<Mutex<Option<String>>>,
}

fn updates(driver: Arc<dyn UpdateDriver>, folder: Option<PathBuf>) -> Updates {
    let (dir, folder) = match folder {
        Some(folder) => (None, folder),
        None => {
            let dir = temp();
            let folder = dir.path().to_path_buf();
            (Some(dir), folder)
        }
    };
    let notified = Arc::new(Mutex::new(Vec::new()));
    let timers = Arc::new(FakeTimers::default());
    let quits = Arc::new(Mutex::new(0));
    let busy: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let app = {
        let (notified, quits, busy) = (notified.clone(), quits.clone(), busy.clone());
        AppUpdates::new(AppUpdatesDeps {
            folder: folder.clone(),
            current: "0.15.0".into(),
            driver,
            now: Arc::new(|| date_parse("2026-11-05T09:00:00Z")),
            notify: Arc::new(move |v: &str| notified.lock().unwrap().push(v.to_owned())),
            changed: Arc::new(|| {}),
            busy: Arc::new(move || busy.lock().unwrap().clone()),
            quit: Arc::new(move || *quits.lock().unwrap() += 1),
            timers: Some(timers.clone()),
            log: None,
        })
    };
    Updates {
        app,
        _dir: dir,
        folder,
        notified,
        timers,
        quits,
        busy,
    }
}

#[test]
fn a_ready_update_is_told_once_per_version_installs_only_when_nothing_else_runs_then_relay_quits() {
    let driver = fake_driver(
        vec![
            UpdatePatch::status(S::Available).with_version("0.16.0"),
            UpdatePatch::status(S::Downloading).with_progress(Some(0.5)),
            UpdatePatch::status(S::Ready),
        ],
        None,
    );
    let f = updates(driver.clone(), None);
    let state = f.app.check();
    assert_eq!(state.status, S::Ready);
    assert_eq!(state.version.as_deref(), Some("0.16.0"));
    assert_eq!(
        state.checked_at.as_deref(),
        Some("2026-11-05T09:00:00.000Z")
    );
    assert_eq!(*f.notified.lock().unwrap(), vec!["0.16.0"]);
    // A second look keeps it ready and says nothing again.
    f.app.check();
    assert_eq!(*f.notified.lock().unwrap(), vec!["0.16.0"]);
    *f.busy.lock().unwrap() = Some(UPDATE_BUSY.into());
    assert_eq!(f.app.install().unwrap_err().0, UPDATE_BUSY);
    assert_eq!(*driver.installs.lock().unwrap(), 0);
    *f.busy.lock().unwrap() = None;
    f.app.install().unwrap();
    assert_eq!(*driver.installs.lock().unwrap(), 1);
    assert_eq!(*f.quits.lock().unwrap(), 1);
    assert_eq!(f.app.state().status, S::Installing);
    // The quit was cancelled: it is ready again.
    f.app.quit_cancelled();
    assert_eq!(f.app.state().status, S::Ready);
    // A new start remembers it was already told.
    let again = updates(
        fake_driver(
            vec![UpdatePatch::status(S::Ready).with_version("0.16.0")],
            None,
        ),
        Some(f.folder.clone()),
    );
    again.app.check();
    assert!(again.notified.lock().unwrap().is_empty());
    assert!(localize_error(UPDATE_BUSY, Locale::Tr).contains("Bitince güncelle"));
}

#[test]
fn a_failed_check_says_why_nothing_newer_reads_as_up_to_date() {
    let failed = updates(
        fake_driver(
            vec![UpdatePatch::status(S::Available).with_version("0.16.0")],
            Some(UPDATE_CHECKSUM_MISMATCH),
        ),
        None,
    );
    let state = failed.app.check();
    assert_eq!(
        (state.status, state.error.as_deref()),
        (S::Error, Some(UPDATE_CHECKSUM_MISMATCH))
    );
    assert!(
        failed
            .app
            .install()
            .unwrap_err()
            .0
            .contains("No update is ready")
    );
    let quiet = updates(fake_driver(Vec::new(), None), None);
    assert_eq!(quiet.app.check().status, S::UpToDate);
}

#[test]
fn checks_start_after_a_short_wait_repeat_every_six_hours_and_stop_when_turned_off() {
    let f = updates(fake_driver(Vec::new(), None), None);
    f.app.start();
    assert_eq!(f.timers.ms(), vec![FIRST_CHECK_MS]);
    f.timers.run(0);
    assert_eq!(f.timers.ms().last(), Some(&CHECK_EVERY_MS));
    let before = f.timers.ms().len();
    f.app.set_auto(false).unwrap();
    assert!(!f.app.state().auto_check);
    assert_eq!(f.timers.ms().len(), before);
    // Kept outside the registry, and a new start honours it.
    let saved: Value =
        serde_json::from_slice(&fs::read(f.folder.join("state.json")).unwrap()).unwrap();
    assert_eq!(saved["autoCheck"], false);
    let next = updates(fake_driver(Vec::new(), None), Some(f.folder.clone()));
    next.app.start();
    assert!(next.timers.ms().is_empty());
}

#[test]
fn a_check_finding_no_asset_or_an_error_retries_in_two_minutes_not_six_hours() {
    let no_asset = updates(
        fake_driver(
            vec![UpdatePatch::status(S::Manual).with_manual_reason(Manual::NoAsset)],
            None,
        ),
        None,
    );
    no_asset.app.start();
    assert_eq!(no_asset.timers.ms().first(), Some(&FIRST_CHECK_MS));
    no_asset.timers.run(0);
    assert_eq!(no_asset.timers.ms().last(), Some(&RETRY_CHECK_MS));

    let error_check = updates(fake_driver(Vec::new(), Some("network down")), None);
    error_check.app.start();
    error_check.timers.run(0);
    assert_eq!(error_check.timers.ms().last(), Some(&RETRY_CHECK_MS));
}

const REQUIREMENT: &str = "identifier \"dev.relay.workspace\" and certificate leaf = H\"32508c2b9b3423e1f36cb671c5f8285bb33f5e0a\"";

/// A request that answers from memory, by URL, and records what was asked.
fn memory_request(
    answer: impl Fn(&str) -> (u16, Vec<u8>) + Send + Sync + 'static,
    fetched: Arc<Mutex<Vec<String>>>,
) -> UpdateRequest {
    Arc::new(move |url: &str, _headers: &[(&str, &str)], _timeout| {
        fetched.lock().unwrap().push(url.to_owned());
        let (status, body) = answer(url);
        Ok(UpdateResponse {
            status,
            content_length: Some(body.len() as u64),
            body: Box::new(std::io::Cursor::new(body)),
        })
    })
}

#[derive(Clone)]
struct MacOptions {
    sums: Option<fn(&str) -> String>,
    signed_like_us: bool,
    plist_version: Option<String>,
    arch: String,
    place: BundlePlace,
    writable: bool,
    version: String,
    prerelease: bool,
    latest: Option<Value>,
    others: Vec<Value>,
    channel: UpdateChannel,
    current: String,
    folder: Option<PathBuf>,
}

impl Default for MacOptions {
    fn default() -> Self {
        MacOptions {
            sums: None,
            signed_like_us: true,
            plist_version: None,
            arch: "arm64".into(),
            place: BundlePlace::Applications,
            writable: true,
            version: "0.16.0".into(),
            prerelease: false,
            latest: None,
            others: Vec::new(),
            channel: UpdateChannel::Stable,
            current: "0.15.0".into(),
            folder: None,
        }
    }
}

/// A Mac with one release on its feed; the commands Relay runs are acted out in the temp
/// folder. The stable feed answers `latest` (that release by default), the beta feed the
/// release list: that release, then `others`.
struct MacWorld {
    driver: MacUpdateDriver,
    _dir: tempfile::TempDir,
    root: PathBuf,
    runs: Arc<Mutex<Vec<Vec<String>>>>,
    spawned: Arc<Mutex<Vec<Vec<String>>>>,
    fetched: Arc<Mutex<Vec<String>>>,
    bundle: PathBuf,
}

impl MacWorld {
    fn check(&self) -> (Result<(), UpdateError>, Vec<UpdatePatch>) {
        let mut reports = Vec::new();
        let result = self.driver.check(&mut |p| reports.push(p));
        (result, reports)
    }
    fn runs_of(&self, tool: &str) -> usize {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r[0] == tool)
            .count()
    }
}

fn mac_world(options: MacOptions) -> MacWorld {
    let dir = temp();
    let root = dir.path().to_path_buf();
    let dmg_bytes = b"fake disk image".to_vec();
    let sha = sha256_hex(&dmg_bytes);
    let version = options.version.clone();
    let dmg_name = format!("Relay-{version}-arm64.dmg");
    let release = json!({
        "tag_name": format!("v{version}"),
        "prerelease": options.prerelease,
        "assets": [
            { "name": dmg_name, "browser_download_url": format!("https://example.test/{dmg_name}"), "size": dmg_bytes.len() },
            { "name": "SHA256SUMS.txt", "browser_download_url": "https://example.test/SHA256SUMS.txt", "size": 100 }
        ]
    });
    let fetched = Arc::new(Mutex::new(Vec::new()));
    let latest = options.latest.clone().unwrap_or_else(|| release.clone());
    let mut list = vec![release];
    list.extend(options.others.clone());
    let sums = options.sums;
    let name = dmg_name.clone();
    let request = memory_request(
        move |url| {
            let body = if url == "https://feed.test/latest" {
                latest.to_string().into_bytes()
            } else if url == "https://feed.test/list" {
                Value::Array(list.clone()).to_string().into_bytes()
            } else if url.ends_with("SHA256SUMS.txt") {
                match sums {
                    Some(sums) => sums(&sha),
                    None => format!("{sha}  {name}\n"),
                }
                .into_bytes()
            } else {
                dmg_bytes.clone()
            };
            (200, body)
        },
        fetched.clone(),
    );
    let runs: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let spawned: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let plist = options.plist_version.clone().unwrap_or(version);
    let signed_like_us = options.signed_like_us;
    let run = {
        let runs = runs.clone();
        Arc::new(
            move |file: &str, args: &[String]| -> Result<ExecOutput, String> {
                let tool = Path::new(file)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let mut record = vec![tool.clone()];
                record.extend(args.iter().cloned());
                runs.lock().unwrap().push(record);
                let out = |stdout: String| {
                    Ok(ExecOutput {
                        stdout,
                        stderr: String::new(),
                    })
                };
                if tool == "hdiutil" && args[0] == "attach" {
                    let at = args.iter().position(|a| a == "-mountpoint").unwrap();
                    let mount = Path::new(&args[at + 1]);
                    fs::create_dir_all(mount.join("Relay.app/Contents")).unwrap();
                    fs::write(mount.join("Relay.app/Contents/Info.plist"), "new").unwrap();
                }
                if tool == "ditto" {
                    copy_dir(Path::new(&args[0]), Path::new(&args[1]));
                }
                if tool == "codesign" && args[0] == "--display" {
                    return out(format!("designated => {REQUIREMENT}\n"));
                }
                if tool == "codesign"
                    && args.iter().any(|a| a == "--test-requirement")
                    && !signed_like_us
                {
                    return Err("failed to satisfy requirement".into());
                }
                if tool == "plutil" {
                    return out(format!("{plist}\n"));
                }
                out(String::new())
            },
        )
    };
    let bundle = root.join("Applications").join("Relay.app");
    fs::create_dir_all(&bundle).unwrap();
    let place = options.place;
    let writable = options.writable;
    let channel = options.channel;
    let driver = MacUpdateDriver::new(MacUpdateDeps {
        feed_stable: "https://feed.test/latest".into(),
        feed_beta: "https://feed.test/list".into(),
        channel: Arc::new(move || channel),
        folder: options
            .folder
            .clone()
            .unwrap_or_else(|| root.join("updates")),
        current: options.current.clone(),
        arch: options.arch.clone(),
        bundle: bundle.clone(),
        place: Arc::new(move || place),
        pid: 4242,
        request: Some(request),
        run,
        spawn_detached: {
            let spawned = spawned.clone();
            Arc::new(move |file: &str, args: &[String]| {
                let mut record = vec![file.to_owned()];
                record.extend(args.iter().cloned());
                spawned.lock().unwrap().push(record);
            })
        },
        writable: Arc::new(move |_| writable),
    });
    MacWorld {
        driver,
        _dir: dir,
        root,
        runs,
        spawned,
        fetched,
        bundle,
    }
}

fn copy_dir(from: &Path, to: &Path) {
    if from.is_dir() {
        fs::create_dir_all(to).unwrap();
        for entry in fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            copy_dir(&entry.path(), &to.join(entry.file_name()));
        }
    } else {
        fs::copy(from, to).unwrap();
    }
}

fn statuses(reports: &[UpdatePatch]) -> Vec<S> {
    reports.iter().filter_map(|r| r.status).collect()
}

#[test]
fn macos_the_dmg_is_downloaded_checked_unpacked_and_accepted_when_signed_like_this_relay() {
    let w = mac_world(MacOptions::default());
    let (result, reports) = w.check();
    result.unwrap();
    let statuses = statuses(&reports);
    assert_eq!(
        (statuses[0], *statuses.last().unwrap()),
        (S::Available, S::Ready)
    );
    assert!(statuses.contains(&S::Downloading));
    let dir = w.root.join("updates").join("0.16.0");
    assert!(dir.join("Relay.app/Contents/Info.plist").exists());
    assert!(
        !dir.join("Relay-0.16.0-arm64.dmg").exists(),
        "the DMG is removed once unpacked"
    );
    assert!(!dir.join("mount").exists());
    // The running app's own requirement is applied to the new one.
    assert!(
        w.runs
            .lock()
            .unwrap()
            .iter()
            .any(|r| r[0] == "codesign" && r.contains(&format!("={REQUIREMENT}")))
    );
    // Installing hands the swap to the script, which waits for Relay's pid.
    w.driver.install().unwrap();
    let spawned = w.spawned.lock().unwrap().clone();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0][0], "/bin/bash");
    assert_eq!(
        spawned[0][2..5],
        [
            "4242".to_owned(),
            dir.join("Relay.app").to_string_lossy().into_owned(),
            w.bundle.to_string_lossy().into_owned()
        ]
    );
    assert_eq!(fs::read_to_string(&spawned[0][1]).unwrap(), INSTALL_SCRIPT);
    // A second check finds the verified copy without downloading again.
    let before = w.runs_of("hdiutil");
    let again = mac_world(MacOptions {
        folder: Some(w.root.join("updates")),
        ..MacOptions::default()
    });
    let (result, reports) = again.check();
    result.unwrap();
    assert_eq!(reports.last().unwrap().status, Some(S::Ready));
    assert_eq!(again.runs_of("hdiutil"), 0);
    assert!(before > 0);
}

#[test]
fn macos_once_a_version_runs_its_download_and_older_ones_are_removed_newer_ones_kept() {
    let w = mac_world(MacOptions::default());
    let folder = w.root.join("updates");
    for v in ["0.14.1", "0.15.0", "0.16.0"] {
        fs::create_dir_all(folder.join(v)).unwrap();
    }
    fs::write(folder.join("state.json"), "{}").unwrap();
    w.driver.prune(None);
    let mut names: Vec<String> = fs::read_dir(&folder)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, vec!["0.16.0", "state.json"]);
}

#[test]
fn macos_a_wrong_checksum_another_signature_or_another_version_is_never_accepted() {
    let tampered = mac_world(MacOptions {
        sums: Some(|_| format!("{}  Relay-0.16.0-arm64.dmg\n", "0".repeat(64))),
        ..MacOptions::default()
    });
    assert_eq!(tampered.check().0.unwrap_err().0, UPDATE_CHECKSUM_MISMATCH);
    assert!(!tampered.root.join("updates/0.16.0").exists());
    let stranger = mac_world(MacOptions {
        signed_like_us: false,
        ..MacOptions::default()
    });
    assert_eq!(stranger.check().0.unwrap_err().0, UPDATE_SIGNATURE_MISMATCH);
    let mislabelled = mac_world(MacOptions {
        plist_version: Some("0.15.0".into()),
        ..MacOptions::default()
    });
    assert_eq!(
        mislabelled.check().0.unwrap_err().0,
        UPDATE_SIGNATURE_MISMATCH
    );
    for w in [stranger, mislabelled] {
        assert!(
            w.driver
                .install()
                .unwrap_err()
                .0
                .contains("No update is ready")
        );
    }
}

#[test]
fn macos_without_a_dmg_for_this_mac_from_a_disk_image_or_an_unwritable_folder_it_is_offered_by_hand()
 {
    let intel = mac_world(MacOptions {
        arch: "ia32".into(),
        ..MacOptions::default()
    });
    let (_, reports) = intel.check();
    assert_eq!(
        reports.last().unwrap(),
        &UpdatePatch::status(S::Manual).with_manual_reason(Manual::NoAsset)
    );
    let from_dmg = mac_world(MacOptions {
        place: BundlePlace::DiskImage,
        ..MacOptions::default()
    });
    let (_, reports) = from_dmg.check();
    assert_eq!(
        reports.last().unwrap().manual_reason,
        Some(Some(Manual::Location))
    );
    assert!(
        from_dmg
            .driver
            .install()
            .unwrap_err()
            .0
            .contains("Move it to Applications")
    );
    let locked = mac_world(MacOptions {
        writable: false,
        ..MacOptions::default()
    });
    let (_, reports) = locked.check();
    assert_eq!(
        reports.last().unwrap().manual_reason,
        Some(Some(Manual::NotWritable))
    );
}

/// Runs INSTALL_SCRIPT for real against fake apps; the tools that touch the system are
/// stand-ins.
#[cfg(target_os = "macos")]
struct ScriptRun {
    _dir: tempfile::TempDir,
    root: PathBuf,
    target: PathBuf,
    log: String,
    status: Option<i32>,
}

#[cfg(target_os = "macos")]
fn run_script(ditto: &str, rsync: &str) -> ScriptRun {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp();
    let root = dir.path().to_path_buf();
    let target = root.join("Applications").join("Relay.app");
    let next = root.join("updates").join("Relay.app");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("version"), "old").unwrap();
    fs::create_dir_all(&next).unwrap();
    fs::write(next.join("version"), "new").unwrap();
    // A file the new version no longer ships: an in-place copy must remove it.
    fs::write(target.join("dropped"), "old only").unwrap();
    let script = root.join("install.sh");
    fs::write(&script, INSTALL_SCRIPT).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let log = root.join("install.log");
    // A pid that is gone: Relay has quit.
    let gone = std::process::Command::new("/bin/sh")
        .args(["-c", "echo $$"])
        .output()
        .unwrap();
    let gone = String::from_utf8_lossy(&gone.stdout).trim().to_owned();
    let status = std::process::Command::new("/bin/bash")
        .arg(&script)
        .arg(&gone)
        .arg(&next)
        .arg(&target)
        .arg(&log)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("RELAY_UPDATE_OPEN", "/usr/bin/touch")
        .env("RELAY_UPDATE_DITTO", ditto)
        .env("RELAY_UPDATE_RSYNC", rsync)
        .env("RELAY_UPDATE_LSREGISTER", "/usr/bin/true")
        .env("RELAY_UPDATE_PLUGINKIT", "/usr/bin/true")
        .status()
        .unwrap();
    ScriptRun {
        log: fs::read_to_string(&log).unwrap(),
        _dir: dir,
        root,
        target,
        status: status.code(),
    }
}

/// macOS script.
#[cfg(target_os = "macos")]
#[test]
fn the_install_script_updates_the_app_in_place_once_relay_has_quit_and_reopens_it() {
    let r = run_script("/usr/bin/ditto", "/usr/bin/rsync");
    assert_eq!(r.status, Some(0), "{}", r.log);
    assert_eq!(fs::read_to_string(r.target.join("version")).unwrap(), "new");
    assert!(!r.target.join("dropped").exists());
    // The old app never leaves for a sibling path in Applications, and its copy is gone.
    let names: Vec<String> = fs::read_dir(r.target.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["Relay.app"]);
    assert!(!r.root.join("previous").exists());
    assert!(r.log.contains("installed"));
}

/// macOS script.
#[cfg(target_os = "macos")]
#[test]
fn the_install_script_keeps_the_old_app_when_it_cannot_copy_it_first() {
    let r = run_script("/usr/bin/false", "/usr/bin/rsync");
    assert_eq!(r.status, Some(1));
    assert_eq!(fs::read_to_string(r.target.join("version")).unwrap(), "old");
    assert!(r.log.contains("nothing changed"));
}

/// macOS script.
#[cfg(target_os = "macos")]
#[test]
fn the_install_script_puts_the_old_app_back_when_the_copy_fails() {
    let r = run_script("/usr/bin/ditto", "/usr/bin/false");
    assert_eq!(r.status, Some(1));
    assert_eq!(fs::read_to_string(r.target.join("version")).unwrap(), "old");
    assert!(r.target.join("dropped").exists());
    assert!(r.log.contains("old app put back"));
}

// --- Windows and Linux ---------------------------------------------------------------------

/// A program started, and its arguments.
type Launch = (PathBuf, Vec<String>);

/// A release on a local host: its feed, its installer, and SHA256SUMS.txt signed with a
/// throwaway key the driver is given instead of the embedded one.
struct SignedRelease {
    server: TestServer,
    key: TestKey,
    digest: String,
    platform: Platform,
    _dir: tempfile::TempDir,
    folder: PathBuf,
    launched: Arc<Mutex<Vec<Launch>>>,
    relaunched: Arc<Mutex<Vec<PathBuf>>>,
}

struct ReleaseOptions {
    version: String,
    platform: Platform,
    /// The sums file instead of the one listing the installer.
    sums: Option<String>,
    /// The signature file instead of the key's.
    signature: Option<String>,
    /// Signs instead of the driver's key.
    signer: Option<TestKey>,
    /// Rewrites the sums after they were signed.
    tamper: fn(&str) -> String,
    /// Files the host does not have.
    missing: Vec<&'static str>,
    /// The bytes the host serves as the installer.
    served: Vec<u8>,
    /// Asset names the release lists (the installer and the sums by default).
    assets: Option<Vec<String>>,
}

impl Default for ReleaseOptions {
    fn default() -> Self {
        ReleaseOptions {
            version: "0.16.0".into(),
            platform: Platform::Windows,
            sums: None,
            signature: None,
            signer: None,
            tamper: |text| text.to_owned(),
            missing: Vec::new(),
            served: b"installer bytes".to_vec(),
            assets: None,
        }
    }
}

fn signed_release(options: ReleaseOptions) -> SignedRelease {
    let key = TestKey::new(9);
    let digest = sha256_hex(b"installer bytes");
    let name = installer_name(options.platform, &options.version);
    let text = options
        .sums
        .clone()
        .unwrap_or_else(|| format!("{}  INSTALL.txt\n{digest}  {name}\n", "0".repeat(64)));
    let signature = options
        .signature
        .clone()
        .unwrap_or_else(|| format!("{}\n", options.signer.as_ref().unwrap_or(&key).sign(&text)));
    let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    files.insert(
        "SHA256SUMS.txt".into(),
        (options.tamper)(&text).into_bytes(),
    );
    files.insert("SHA256SUMS.txt.sig".into(), signature.into_bytes());
    files.insert(name.clone(), options.served.clone());
    for missing in &options.missing {
        files.remove(*missing);
    }
    let asset_names = options.assets.clone().unwrap_or_else(|| {
        vec![
            name.clone(),
            "SHA256SUMS.txt".into(),
            "SHA256SUMS.txt.sig".into(),
        ]
    });
    let version = options.version.clone();
    let port = Arc::new(Mutex::new(0u16));
    let host = port.clone();
    let server = TestServer::start(move |seen| {
        let port = *host.lock().unwrap();
        let release = json!({
            "tag_name": format!("v{version}"),
            "prerelease": version.contains('-'),
            "assets": asset_names.iter().map(|n| json!({
                "name": n,
                "browser_download_url": format!("http://127.0.0.1:{port}/download/v{version}/{n}"),
                "size": 15
            })).collect::<Vec<_>>()
        });
        match seen.url.as_str() {
            "/feed/latest" => Reply::json(200, release.to_string()),
            "/feed/list" => Reply::json(200, json!([release]).to_string()),
            url => match url.rsplit('/').next().and_then(|n| files.get(n)) {
                Some(body) => Reply::bytes(200, body.clone()),
                None => Reply::bytes(404, "not found"),
            },
        }
    });
    *port.lock().unwrap() = server.port;
    let dir = temp();
    SignedRelease {
        server,
        key,
        digest,
        platform: options.platform,
        folder: dir.path().join("updates"),
        _dir: dir,
        launched: Arc::new(Mutex::new(Vec::new())),
        relaunched: Arc::new(Mutex::new(Vec::new())),
    }
}

impl SignedRelease {
    fn driver(
        &self,
        env: &[(&str, &str)],
        channel: UpdateChannel,
        current: &str,
    ) -> WinLinuxUpdateDriver {
        let launched = self.launched.clone();
        let relaunched = self.relaunched.clone();
        WinLinuxUpdateDriver::new(WinLinuxUpdateDeps {
            feed_stable: self.server.url("/feed/latest"),
            feed_beta: self.server.url("/feed/list"),
            channel: Arc::new(move || channel),
            folder: self.folder.clone(),
            current: current.into(),
            platform: self.platform,
            env: env
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect(),
            request: None,
            public_key: Some(self.key.public_key()),
            launch: Arc::new(move |program: &Path, args: &[String]| {
                launched
                    .lock()
                    .unwrap()
                    .push((program.to_path_buf(), args.to_vec()));
                Ok(())
            }),
            relaunch: Arc::new(move |program: &Path| {
                relaunched.lock().unwrap().push(program.to_path_buf())
            }),
        })
    }

    fn stable(&self) -> WinLinuxUpdateDriver {
        self.driver(&[], UpdateChannel::Stable, "0.15.0")
    }

    fn fetched(&self) -> Vec<String> {
        self.server.seen().into_iter().map(|s| s.url).collect()
    }
}

fn check(driver: &WinLinuxUpdateDriver) -> (Result<(), UpdateError>, Vec<UpdatePatch>) {
    let mut reports = Vec::new();
    let result = driver.check(&mut |p| reports.push(p));
    (result, reports)
}

#[test]
fn windows_and_linux_the_driver_downloads_and_verifies_the_installer_and_installs_it_only_on_update()
 {
    let release = signed_release(ReleaseOptions::default());
    let driver = release.stable();
    let (result, reports) = check(&driver);
    result.unwrap();
    assert_eq!(
        statuses(&reports),
        vec![S::Available, S::Downloading, S::Downloading, S::Ready]
    );
    assert_eq!(reports[0].version, Some(Some("0.16.0".into())));
    assert_eq!(
        reports[0].notes_url,
        Some(Some(
            "https://github.com/ahmetcankacar54/relay/releases/tag/v0.16.0".into()
        ))
    );
    assert_eq!(reports[1].progress, Some(Some(0.0)));
    assert_eq!(reports[2].progress, Some(Some(1.0)));
    assert_eq!(reports[3].progress, Some(None));
    // The sums and their signature come first, from the release of the version found; nothing
    // is installed on a check.
    assert_eq!(
        release.fetched(),
        vec![
            "/feed/latest",
            "/download/v0.16.0/SHA256SUMS.txt",
            "/download/v0.16.0/SHA256SUMS.txt.sig",
            "/download/v0.16.0/Relay-Setup-0.16.0-x64.exe",
        ]
    );
    assert!(release.launched.lock().unwrap().is_empty());
    let installer = release
        .folder
        .join("0.16.0")
        .join("Relay-Setup-0.16.0-x64.exe");
    assert_eq!(fs::read(&installer).unwrap(), b"installer bytes");
    // Windows: the installer runs silently, detached, and reopens Relay; Relay quits after.
    driver.install().unwrap();
    assert_eq!(
        *release.launched.lock().unwrap(),
        vec![(
            installer,
            ["/S", "/UPDATE", "/R"].map(str::to_owned).to_vec()
        )]
    );
    // A second check keeps the verified download.
    let (result, _) = check(&release.stable());
    result.unwrap();
    assert_eq!(
        release
            .fetched()
            .iter()
            .filter(|u| u.ends_with(".exe"))
            .count(),
        1
    );

    // An AppImage running as one is checked the same way and replaced in place.
    let app_image = signed_release(ReleaseOptions {
        platform: Platform::Linux,
        ..ReleaseOptions::default()
    });
    let place = temp();
    let running = place.path().join("Relay.AppImage");
    fs::write(&running, "old appimage").unwrap();
    let running_text = running.to_string_lossy().into_owned();
    let linux = app_image.driver(
        &[("APPIMAGE", &running_text)],
        UpdateChannel::Stable,
        "0.15.0",
    );
    let (result, reports) = check(&linux);
    result.unwrap();
    assert_eq!(reports.last().unwrap().status, Some(S::Ready));
    linux.install().unwrap();
    assert_eq!(fs::read(&running).unwrap(), b"installer bytes");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&running).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    assert_eq!(*app_image.relaunched.lock().unwrap(), vec![running.clone()]);
    assert_eq!(fs::read_dir(place.path()).unwrap().count(), 1);

    // Linux outside an AppImage cannot replace itself.
    let bare = signed_release(ReleaseOptions {
        platform: Platform::Linux,
        ..ReleaseOptions::default()
    });
    let driver = bare.stable();
    let (result, reports) = check(&driver);
    result.unwrap();
    assert_eq!(
        reports.last().unwrap(),
        &UpdatePatch::status(S::Manual)
            .with_manual_reason(Manual::NotAppimage)
            .with_version("0.16.0")
            .with_notes_url("https://github.com/ahmetcankacar54/relay/releases/tag/v0.16.0")
    );
    assert!(
        driver
            .install()
            .unwrap_err()
            .0
            .contains("No update is ready")
    );
    assert_eq!(bare.fetched(), vec!["/feed/latest"]);
    // Nothing newer.
    let none = signed_release(ReleaseOptions::default());
    let (result, reports) = check(&none.driver(&[], UpdateChannel::Stable, "0.16.0"));
    result.unwrap();
    assert_eq!(reports, vec![UpdatePatch::status(S::UpToDate)]);
}

#[test]
fn windows_and_linux_an_installer_the_signed_sums_do_not_vouch_for_is_deleted_never_installed() {
    let rejected = |release: &SignedRelease, error: &str| {
        let driver = release.stable();
        let (result, _) = check(&driver);
        assert_eq!(result.unwrap_err().0, error);
        let installer = release
            .folder
            .join("0.16.0")
            .join("Relay-Setup-0.16.0-x64.exe");
        assert!(!installer.exists(), "the rejected download is removed");
        assert!(
            driver
                .install()
                .unwrap_err()
                .0
                .contains("No update is ready")
        );
        assert!(release.launched.lock().unwrap().is_empty());
    };
    let downloaded = |release: &SignedRelease| {
        release
            .fetched()
            .iter()
            .any(|u| u.ends_with("Relay-Setup-0.16.0-x64.exe"))
    };
    // A tampered installer: the signed sums do not match it.
    let tampered = signed_release(ReleaseOptions {
        served: b"something else".to_vec(),
        ..ReleaseOptions::default()
    });
    rejected(&tampered, UPDATE_CHECKSUM_MISMATCH);
    // The tampered installer again, now with the sums edited to its digest; the signature is
    // the original one, over the original sums. Nothing is downloaded.
    let edited = signed_release(ReleaseOptions {
        served: b"something else".to_vec(),
        tamper: |text| {
            let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
            let last = lines.last_mut().unwrap();
            *last = format!("{}{}", sha256_hex(b"something else"), &last[64..]);
            lines.join("\n") + "\n"
        },
        ..ReleaseOptions::default()
    });
    rejected(&edited, UPDATE_SIGNATURE_MISMATCH);
    assert!(!downloaded(&edited));
    // Sums signed by another key (the release host's own, say).
    let other = signed_release(ReleaseOptions {
        signer: Some(TestKey::new(10)),
        ..ReleaseOptions::default()
    });
    rejected(&other, UPDATE_SIGNATURE_MISMATCH);
    assert!(!downloaded(&other));
    // A garbled signature, and none at all.
    rejected(
        &signed_release(ReleaseOptions {
            signature: Some("not base64 at all".into()),
            ..ReleaseOptions::default()
        }),
        UPDATE_SIGNATURE_MISMATCH,
    );
    rejected(
        &signed_release(ReleaseOptions {
            missing: vec!["SHA256SUMS.txt.sig"],
            ..ReleaseOptions::default()
        }),
        UPDATE_SIGNATURE_MISMATCH,
    );
    rejected(
        &signed_release(ReleaseOptions {
            missing: vec!["SHA256SUMS.txt"],
            ..ReleaseOptions::default()
        }),
        UPDATE_NO_CHECKSUM,
    );
    // Signed sums that do not list this installer.
    rejected(
        &signed_release(ReleaseOptions {
            sums: Some(format!("{}  INSTALL.txt\n", "a".repeat(64))),
            ..ReleaseOptions::default()
        }),
        UPDATE_NO_CHECKSUM,
    );
    // A release naming another (older, validly listed) installer: only this version's own
    // name is ever downloaded.
    let renamed = signed_release(ReleaseOptions {
        assets: Some(vec![
            "Relay-Setup-0.14.0-x64.exe".into(),
            "SHA256SUMS.txt".into(),
            "SHA256SUMS.txt.sig".into(),
        ]),
        ..ReleaseOptions::default()
    });
    let driver = renamed.stable();
    let (result, reports) = check(&driver);
    result.unwrap();
    assert_eq!(
        reports.last().unwrap(),
        &UpdatePatch::status(S::Manual).with_manual_reason(Manual::NoAsset)
    );
    assert!(!renamed.fetched().iter().any(|u| u.ends_with(".exe")));
    assert!(driver.install().is_err());
    let _ = renamed.digest;
}

#[test]
fn the_installer_names_the_updater_expects_are_the_release_scripts_names() {
    // scripts/electron-update-yml.mjs names the installers a release publishes (and the
    // latest.yml Relay 0.x reads); the updater must look for exactly those.
    let script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/electron-update-yml.mjs");
    let script = fs::read_to_string(script).unwrap();
    let name = |platform: &str| {
        let start = format!("if (platform === \"{platform}\") return `");
        let from = script.find(&start).expect("installerName branch") + start.len();
        let end = script[from..].find('`').expect("closing backtick");
        script[from..from + end].replace("${version}", "1.2.3")
    };
    assert_eq!(installer_name(Platform::Windows, "1.2.3"), name("win32"));
    assert_eq!(installer_name(Platform::Linux, "1.2.3"), name("linux"));
    // The macOS updater picks the DMG for the running architecture: Apple silicon and Intel.
    let assets: Vec<ReleaseAsset> = ["arm64", "x64"]
        .iter()
        .map(|arch| {
            asset(
                &format!("Relay-1.2.3-{arch}.dmg"),
                &format!("https://x/{arch}"),
            )
        })
        .collect();
    assert_eq!(
        dmg_for(&assets, "1.2.3", "arm64").unwrap().url,
        "https://x/arm64"
    );
    assert_eq!(
        dmg_for(&assets, "1.2.3", "x64").unwrap().url,
        "https://x/x64"
    );
    assert_eq!(dmg_for(&assets[..1], "1.2.3", "x64"), None);
}

/// GitHub's release list, newest first by date as GitHub sends it.
fn release_list() -> Value {
    json!([
        { "tag_name": "v0.18.0-beta.1", "draft": true },
        { "tag_name": "v0.17.0-beta.10", "prerelease": true },
        { "tag_name": "v0.17.0-beta.9", "prerelease": true },
        { "tag_name": "v0.16.2" },
        { "tag_name": "v0.16.1" }
    ])
}

#[test]
fn stable_takes_only_published_stable_releases_beta_also_pre_releases_by_version_never_a_draft() {
    let (stable, beta) = (UpdateChannel::Stable, UpdateChannel::Beta);
    let version = |feed: &Value, channel| newest_release(feed, channel).map(|r| r.version);
    assert_eq!(version(&release_list(), stable).as_deref(), Some("0.16.2"));
    assert_eq!(
        version(&release_list(), beta).as_deref(),
        Some("0.17.0-beta.10")
    );
    // A stable release newer than every beta wins on beta too.
    let mut with_stable = release_list();
    with_stable
        .as_array_mut()
        .unwrap()
        .push(json!({ "tag_name": "v0.17.0" }));
    assert_eq!(version(&with_stable, beta).as_deref(), Some("0.17.0"));
    // A pre-release by its flag alone, or by its tag alone, stays off stable.
    assert_eq!(
        version(
            &json!([{ "tag_name": "v0.20.0", "prerelease": true }, { "tag_name": "v0.21.0-rc.1" }]),
            stable
        ),
        None
    );
    let rc = release_from(&json!({ "tag_name": "v0.21.0-rc.1" }), beta).unwrap();
    assert_eq!(rc.version, "0.21.0-rc.1");
    assert_eq!(
        rc.notes_url,
        "https://github.com/ahmetcankacar54/relay/releases/tag/v0.21.0-rc.1"
    );
    // GitHub's latest-release answer is one release, not a list.
    assert_eq!(
        version(&json!({ "tag_name": "v0.16.2" }), stable).as_deref(),
        Some("0.16.2")
    );
    // Pre-release parts compare as semver: numbers by value, below words, a shorter list first.
    assert_eq!(cmp("0.17.0-beta.10", "0.17.0-beta.9"), Ordering::Greater);
    assert_eq!(cmp("0.17.0-beta.1", "0.17.0-beta"), Ordering::Greater);
    assert_eq!(cmp("0.17.0-rc.1", "0.17.0-beta.2"), Ordering::Greater);
    assert_eq!(cmp("0.17.0-1", "0.17.0-alpha"), Ordering::Less);
    assert_eq!(cmp("0.17.0", "0.17.0-rc.1"), Ordering::Greater);
}

#[test]
fn macos_beta_finds_a_pre_release_and_readies_it_stable_does_not_see_it() {
    let world = |channel| {
        mac_world(MacOptions {
            channel,
            current: "0.16.0".into(),
            version: "0.17.0-beta.1".into(),
            prerelease: true,
            plist_version: Some("0.17.0-beta.1".into()),
            latest: Some(json!({ "tag_name": "v0.16.0", "assets": [] })),
            others: vec![json!({ "tag_name": "v0.16.0", "assets": [] })],
            ..MacOptions::default()
        })
    };
    let stable = world(UpdateChannel::Stable);
    let (_, reports) = stable.check();
    assert_eq!(reports, vec![UpdatePatch::status(S::UpToDate)]);
    assert_eq!(
        *stable.fetched.lock().unwrap(),
        vec!["https://feed.test/latest"]
    );
    let beta = world(UpdateChannel::Beta);
    let (result, reports) = beta.check();
    result.unwrap();
    assert_eq!(beta.fetched.lock().unwrap()[0], "https://feed.test/list");
    assert_eq!(
        reports[0],
        UpdatePatch::status(S::Available)
            .with_version("0.17.0-beta.1")
            .with_notes_url("https://github.com/ahmetcankacar54/relay/releases/tag/v0.17.0-beta.1")
    );
    assert_eq!(reports.last().unwrap().status, Some(S::Ready));
    // Signed like this Relay and carrying the pre-release's own version, as for a stable one.
    assert!(
        beta.runs
            .lock()
            .unwrap()
            .iter()
            .any(|r| r[0] == "codesign" && r.iter().any(|a| a == "--test-requirement"))
    );
    let unsigned = mac_world(MacOptions {
        channel: UpdateChannel::Beta,
        current: "0.16.0".into(),
        version: "0.17.0-beta.1".into(),
        prerelease: true,
        plist_version: Some("0.17.0-beta.1".into()),
        signed_like_us: false,
        ..MacOptions::default()
    });
    assert_eq!(unsigned.check().0.unwrap_err().0, UPDATE_SIGNATURE_MISMATCH);
    // Its download is pruned like any other once that version runs.
    fs::create_dir_all(beta.root.join("updates/0.17.0-beta.1")).unwrap();
    beta.driver.prune(Some("0.17.0-beta.1"));
    assert!(!beta.root.join("updates/0.17.0-beta.1").exists());
}

#[test]
fn macos_back_on_stable_while_a_beta_runs_an_older_stable_release_is_never_installed() {
    let back = mac_world(MacOptions {
        current: "0.17.0-beta.1".into(),
        version: "0.16.2".into(),
        ..MacOptions::default()
    });
    let (_, reports) = back.check();
    assert_eq!(reports, vec![UpdatePatch::status(S::UpToDate)]);
    assert!(
        !back
            .fetched
            .lock()
            .unwrap()
            .iter()
            .any(|u| u.ends_with(".dmg"))
    );
    // The stable release of that version is newer than its beta, and installs.
    let released = mac_world(MacOptions {
        current: "0.17.0-beta.1".into(),
        version: "0.17.0".into(),
        ..MacOptions::default()
    });
    let (result, reports) = released.check();
    result.unwrap();
    assert_eq!(reports.last().unwrap().status, Some(S::Ready));
}

#[test]
fn windows_and_linux_the_channel_picks_the_feed_and_never_a_downgrade() {
    let release = signed_release(ReleaseOptions::default());
    // Stable reads the latest release; beta the release list.
    check(&release.driver(&[], UpdateChannel::Stable, "0.15.0"))
        .0
        .unwrap();
    check(&release.driver(&[], UpdateChannel::Beta, "0.15.0"))
        .0
        .unwrap();
    let feeds: Vec<String> = release
        .fetched()
        .into_iter()
        .filter(|u| u.starts_with("/feed/"))
        .collect();
    assert_eq!(feeds, vec!["/feed/latest", "/feed/list"]);
    // An older version found anyway is up to date, never installed.
    let (result, reports) = check(&release.driver(&[], UpdateChannel::Stable, "0.17.0"));
    result.unwrap();
    assert_eq!(reports, vec![UpdatePatch::status(S::UpToDate)]);
    // A pre-release is seen on beta only, and its installer is checked against its signed sums
    // under its own name.
    let pre = signed_release(ReleaseOptions {
        version: "0.16.0-beta.2".into(),
        ..ReleaseOptions::default()
    });
    let (result, reports) = check(&pre.driver(&[], UpdateChannel::Stable, "0.15.0"));
    assert!(result.unwrap_err().0.contains("no usable release"));
    assert!(reports.is_empty());
    let (result, reports) = check(&pre.driver(&[], UpdateChannel::Beta, "0.15.0"));
    result.unwrap();
    assert_eq!(reports.last().unwrap().status, Some(S::Ready));
    assert!(
        pre.fetched()
            .iter()
            .any(|u| u.ends_with("/v0.16.0-beta.2/SHA256SUMS.txt.sig"))
    );
    assert!(
        pre.folder
            .join("0.16.0-beta.2/Relay-Setup-0.16.0-beta.2-x64.exe")
            .exists()
    );
}

/// A driver whose steps change between checks.
struct Steps(Mutex<Vec<UpdatePatch>>);

impl UpdateDriver for Steps {
    fn check(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        for step in self.0.lock().unwrap().clone() {
            report(step);
        }
        Ok(())
    }
    fn install(&self) -> Result<(), UpdateError> {
        Ok(())
    }
}

#[test]
fn a_channel_change_drops_what_the_old_channel_found_and_checks_the_new_one() {
    let driver = Arc::new(Steps(Mutex::new(vec![
        UpdatePatch::status(S::Available).with_version("0.16.0-beta.1"),
        UpdatePatch::status(S::Ready),
    ])));
    let f = updates(driver.clone(), None);
    assert_eq!(f.app.check().status, S::Ready);
    // Back on stable: the beta ready to install is no longer offered.
    *driver.0.lock().unwrap() = Vec::new();
    let state = f.app.channel_changed();
    assert_eq!(state.status, S::UpToDate);
    assert_eq!(state.version, None);
    // With automatic checks off, it only forgets.
    f.app.set_auto(false).unwrap();
    *driver.0.lock().unwrap() = vec![UpdatePatch::status(S::Ready).with_version("0.16.0-beta.1")];
    assert_eq!(f.app.channel_changed().status, S::Idle);
}
