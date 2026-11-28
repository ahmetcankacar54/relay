//! Relay's own updates, and moving a copy that cannot keep macOS's approval to Applications
//! (port of electron/main/updates.ts).

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use relay_core::app_update::{AppUpdates, AppUpdatesDeps, UPDATE_BUSY, UpdateDriver, UpdateError};
use relay_core::install_location::{BundlePlace, bundle_path, bundle_place};
use relay_core::shared::types::{UpdateChannel, UpdateState};
use serde_json::{Value, json};

use crate::host::UNPACKAGED;
use crate::services::desktop_lock::DESKTOP_LOCK;
use crate::services::logs::log_draft_event;
use crate::state::STATE;

/// Relay's own updates; only in a packaged app, or with RELAY_UPDATE_FEED to test one.
static APP_UPDATES: OnceLock<AppUpdates> = OnceLock::new();

/// `appUpdates`: None in a development run without a test feed.
pub fn app_updates() -> Option<&'static AppUpdates> {
    APP_UPDATES.get()
}

/// `appUpdates?.state()`: the snapshot's `update` field.
pub fn state() -> Option<UpdateState> {
    app_updates().map(AppUpdates::state)
}

fn log(event: &str, fields: Value) {
    log_draft_event(event, fields.as_object());
}

fn exe() -> PathBuf {
    std::env::current_exe().unwrap_or_default()
}

/// `app.isInApplicationsFolder()`: the bundle sits in /Applications or ~/Applications.
fn in_applications_folder(bundle: &Path) -> bool {
    let bundle = std::fs::canonicalize(bundle).unwrap_or_else(|_| bundle.to_path_buf());
    let home = relay_core::relay_paths::home_dir().join("Applications");
    [Path::new("/Applications"), home.as_path()]
        .iter()
        .any(|folder| bundle.parent() == Some(folder))
}

/// The share builds are not notarized, so macOS asks once ("Open Anyway") and keeps the answer
/// on the bundle. Run from the disk image or a translocated copy it cannot keep it and asks at
/// every launch: Relay offers to move itself to Applications and starts again from there.
/// From a writable place the download quarantine is cleared so the approval holds (see
/// install_location). True when Relay is moving and this copy quits.
pub fn settle_install_location() -> bool {
    let Some(bundle) = bundle_path(&exe()) else {
        return false;
    };
    let place = bundle_place(&bundle, in_applications_folder(&bundle));
    if !relay_core::install_location::forgets_approval(place) {
        std::thread::spawn(move || {
            let cleared =
                relay_core::install_location::clear_own_quarantine(&bundle, |file, args| {
                    relay_core::detached_exec::run_detached(
                        file,
                        args,
                        &relay_core::detached_exec::ExecOptions::timeout_ms(15_000),
                    )
                    .map(|_| ())
                });
            log(
                "install-location",
                json!({ "place": place, "quarantineCleared": cleared }),
            );
        });
        return false;
    }
    log("install-location", json!({ "place": place }));
    // Settings are not read yet; the system language decides.
    let locale = relay_i18n::resolve_locale(
        Some(relay_i18n::LanguagePref::System),
        &crate::i18n::system_languages(),
    );
    let t = |id: &str| relay_i18n::translate(locale, id, &relay_i18n::Args::new());
    let answer = STATE.shell().message_box(&relay_core::host::MessageBox {
        kind: relay_core::host::MessageKind::Warning,
        buttons: vec![
            t("electronMain.moveToApplications"),
            t("electronMain.notNow"),
        ],
        default_id: 0,
        cancel_id: Some(1),
        message: t("electronMain.moveRelayToApplications"),
        detail: Some(if place == BundlePlace::DiskImage {
            t("electronMain.whileRelayRunsFromTheDisk")
        } else {
            t("electronMain.whileRelayRunsFromItsDownload")
        }),
        ..relay_core::host::MessageBox::default()
    });
    if answer.response != 0 {
        return false;
    }
    match move_to_applications_folder(&bundle, place) {
        Ok(()) => {
            crate::lifecycle::quit();
            true
        }
        Err(error) => {
            STATE.shell().error_box(
                &t("electronMain.relayWasNotMoved"),
                &format!(
                    "{}\n\n{error}",
                    t("electronMain.dragRelayToApplicationsInFinder")
                ),
            );
            false
        }
    }
}

/// `app.moveToApplicationsFolder()`: copies the bundle to /Applications (asking for an
/// administrator's password when the folder is not writable), puts an older copy there in the
/// Trash, and opens the new copy once this one has quit, ejecting the disk image it ran from.
#[cfg(target_os = "macos")]
fn move_to_applications_folder(bundle: &Path, place: BundlePlace) -> Result<(), String> {
    use relay_core::detached_exec::{ExecOptions, run_attached};

    let name = bundle
        .file_name()
        .ok_or("Relay's app bundle has no name.")?;
    let folder = Path::new("/Applications");
    let target = folder.join(name);
    let staged = folder.join(format!(".{}.relay-move", name.to_string_lossy()));
    let quote = |path: &Path| format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"));
    // Copied beside the target first, so a failed copy never leaves half an app in its place.
    let mut script = format!(
        "/bin/rm -rf {staged} && /usr/bin/ditto {bundle} {staged}",
        staged = quote(&staged),
        bundle = quote(bundle),
    );
    if target.exists() {
        let trash = relay_core::relay_paths::home_dir()
            .join(".Trash")
            .join(format!(
                "{} {}",
                name.to_string_lossy(),
                relay_core::clock::now_ms()
            ));
        script.push_str(&format!(
            " && (/bin/mv {target} {trash} || /bin/rm -rf {target})",
            target = quote(&target),
            trash = quote(&trash),
        ));
    }
    script.push_str(&format!(
        " && /bin/mv {staged} {target}",
        staged = quote(&staged),
        target = quote(&target),
    ));
    let options = ExecOptions::timeout_ms(120_000);
    let args = if relay_core::mac_update::writable(folder) {
        vec!["-c".to_owned(), script]
    } else {
        let apple = format!(
            "do shell script \"{}\" with administrator privileges",
            script.replace('\\', "\\\\").replace('"', "\\\"")
        );
        return run_attached("/usr/bin/osascript", &["-e".to_owned(), apple], &options)
            .map_err(|e| e.message)
            .and_then(|_| relaunch_from(&target, bundle, place));
    };
    run_attached("/bin/sh", &args, &options).map_err(|e| e.message)?;
    relaunch_from(&target, bundle, place)
}

/// Opens the moved copy once this process has ended; a disk image Relay ran from is ejected.
#[cfg(target_os = "macos")]
fn relaunch_from(target: &Path, bundle: &Path, place: BundlePlace) -> Result<(), String> {
    // `/Volumes/<name>`: the disk image Relay ran from.
    let volume = if place == BundlePlace::DiskImage {
        let root: PathBuf = bundle.components().take(3).collect();
        root.to_string_lossy().into_owned()
    } else {
        String::new()
    };
    let script = "while /bin/kill -0 \"$1\" 2>/dev/null; do /bin/sleep 0.2; done; \
                  /usr/bin/open \"$2\"; [ -n \"$3\" ] && /usr/bin/hdiutil detach \"$3\" -quiet; exit 0";
    let mut command = std::process::Command::new("/bin/sh");
    command
        .args(["-c", script, "sh"])
        .arg(std::process::id().to_string())
        .arg(target)
        .arg(volume)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn move_to_applications_folder(_bundle: &Path, _place: BundlePlace) -> Result<(), String> {
    Err("Only macOS moves Relay to Applications.".into())
}

fn channel() -> UpdateChannel {
    STATE
        .settings()
        .update_channel
        .unwrap_or(UpdateChannel::Stable)
}

/// Starts Relay's own updates: Relay downloads, verifies and installs its update itself (macOS
/// in mac_update, Windows and Linux in win_linux_update). A development run never updates
/// unless RELAY_UPDATE_FEED points it at a test feed; a packaged Relay never reads that
/// variable.
pub fn start_app_updates() {
    let test_feed = if UNPACKAGED {
        std::env::var("RELAY_UPDATE_FEED")
            .ok()
            .filter(|feed| !feed.is_empty())
    } else {
        None
    };
    if UNPACKAGED && test_feed.is_none() {
        return;
    }
    let folder = STATE.paths().data_dir().join("updates");
    let current = STATE.paths().app_version();
    let Some(driver) = driver(folder.clone(), current.clone(), test_feed) else {
        return;
    };
    let updates = AppUpdates::new(AppUpdatesDeps {
        folder,
        current,
        driver,
        now: Arc::new(|| relay_core::clock::now_ms() as f64),
        notify: Arc::new(crate::services::notifications::notify_update),
        changed: Arc::new(crate::events::changed),
        busy: Arc::new(|| {
            (STATE.desktop.get().is_some_and(|desktop| desktop.is_busy()) || DESKTOP_LOCK.busy())
                .then(|| UPDATE_BUSY.to_owned())
        }),
        quit: Arc::new(|| {
            crate::lifecycle::quit();
            // Still here a while later: the quit was cancelled (running terminals), so the
            // update waits.
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(20_000));
                if let Some(updates) = app_updates() {
                    updates.quit_cancelled();
                }
            });
        }),
        timers: None,
        log: Some(Arc::new(|event: &str, fields: &Value| {
            log_draft_event(event, fields.as_object())
        })),
    });
    if APP_UPDATES.set(updates).is_ok()
        && let Some(updates) = app_updates()
    {
        updates.start();
    }
}

/// macOS updates only from inside Relay.app; old downloads are pruned at start.
#[cfg(target_os = "macos")]
fn driver(
    folder: PathBuf,
    current: String,
    test_feed: Option<String>,
) -> Option<Arc<dyn UpdateDriver>> {
    use relay_core::app_update::release_feed;
    use relay_core::mac_update::{
        MacUpdateDeps, MacUpdateDriver, default_run, default_spawn_detached, node_arch, writable,
    };
    let bundle = bundle_path(&exe())?;
    let place_of = bundle.clone();
    let mac = MacUpdateDriver::new(MacUpdateDeps {
        feed_stable: test_feed
            .clone()
            .unwrap_or_else(|| release_feed(UpdateChannel::Stable)),
        feed_beta: test_feed.unwrap_or_else(|| release_feed(UpdateChannel::Beta)),
        channel: Arc::new(channel),
        folder,
        current,
        arch: node_arch().to_owned(),
        bundle,
        place: Arc::new(move || bundle_place(&place_of, in_applications_folder(&place_of))),
        pid: std::process::id(),
        request: None,
        run: default_run(),
        spawn_detached: default_spawn_detached(),
        writable: Arc::new(writable),
    });
    // Old downloads that cannot go now stay until the next start.
    mac.prune(None);
    Some(Arc::new(mac))
}

/// Windows runs the verified installer; Linux replaces its AppImage and starts it again.
#[cfg(not(target_os = "macos"))]
fn driver(
    folder: PathBuf,
    current: String,
    test_feed: Option<String>,
) -> Option<Arc<dyn UpdateDriver>> {
    use relay_core::win_linux_update::{WinLinuxUpdateDeps, WinLinuxUpdateDriver};
    let mut deps = WinLinuxUpdateDeps::new(
        folder,
        current,
        Arc::new(channel),
        Arc::new(|appimage: &Path| relaunch_after_quit(appimage)),
    );
    if let Some(feed) = test_feed {
        deps.feed_stable = feed.clone();
        deps.feed_beta = feed;
    }
    let driver = WinLinuxUpdateDriver::new(deps);
    driver.prune(None);
    Some(Arc::new(driver))
}

/// Starts the replaced AppImage once this process has ended (electron-updater's relaunch).
#[cfg(not(target_os = "macos"))]
fn relaunch_after_quit(program: &Path) {
    #[cfg(unix)]
    {
        let mut command = std::process::Command::new("/bin/sh");
        command
            .args([
                "-c",
                "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec \"$2\"",
                "sh",
            ])
            .arg(std::process::id().to_string())
            .arg(program)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        if let Err(error) = command.spawn() {
            crate::services::errors::record_main_error("update-relaunch", &error.to_string());
        }
    }
    #[cfg(not(unix))]
    let _ = program;
}

/// Stops the update checks at quit (`appUpdates?.stop()`).
pub fn stop() {
    if let Some(updates) = app_updates() {
        updates.stop();
    }
}

const UNAVAILABLE: &str = "Updates are not available in this copy of Relay.";

fn updates_or_refuse() -> Result<&'static AppUpdates, String> {
    app_updates().ok_or_else(|| UNAVAILABLE.to_owned())
}

/// `update-check`.
pub fn check() -> Result<UpdateState, String> {
    Ok(updates_or_refuse()?.check())
}

/// `update-install`.
pub fn install() -> Result<(), String> {
    updates_or_refuse()?.install().map_err(|e: UpdateError| e.0)
}

/// `set-update-auto`.
pub fn set_auto(enabled: bool) -> Result<(), String> {
    updates_or_refuse()?.set_auto(enabled).map_err(|e| e.0)
}

/// `appUpdates?.channelChanged()`, off the caller's thread: it may check the feed.
pub fn channel_changed() {
    if let Some(updates) = app_updates() {
        std::thread::spawn(|| updates.channel_changed());
    }
}

/// `update-notes`: only the release page of a version the feed named, never a URL from the
/// renderer.
pub fn open_notes() -> Result<(), String> {
    let Some(version) = state().and_then(|state| state.version) else {
        return Ok(());
    };
    if !release_version(&version) {
        return Ok(());
    }
    STATE
        .shell()
        .open_external(&relay_core::app_update::release_page(&version))
}

/// `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/`.
fn release_version(version: &str) -> bool {
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty()
                && pre
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}
