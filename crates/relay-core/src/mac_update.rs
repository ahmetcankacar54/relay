//! Port of `electron/core/mac-update.ts`: macOS updates by Relay itself. The release's DMG for
//! this Mac is downloaded, checked against the release's SHA256SUMS.txt, unpacked, and accepted
//! only when it is signed with this Relay's own certificate (its designated requirement) and
//! carries the expected version. Installing swaps the app in place after Relay quits, through
//! INSTALL_SCRIPT.

use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::app_update::{
    ReleaseAsset, UpdateDriver, UpdateError, UpdatePatch, UpdateRequest, compare_versions,
    default_request, fetch_json, newest_release, parse_checksums, read_capped,
};
use crate::detached_exec::ExecOutput;
use crate::install_location::BundlePlace;
use crate::shared::types::{UpdateChannel, UpdateManualReason, UpdateStatus};

/// A DMG larger than this is not one of Relay's.
const MAX_DMG_BYTES: u64 = 600 * 1024 * 1024;
const MAX_SUMS_BYTES: u64 = 64 * 1024;
const APP: &str = "Relay.app";

pub const UPDATE_CHECKSUM_MISMATCH: &str = "The downloaded update does not match its checksum.";
pub const UPDATE_SIGNATURE_MISMATCH: &str =
    "The downloaded update is not signed like this Relay, so it was not installed.";
pub const UPDATE_NO_CHECKSUM: &str = "The release lists no checksum for the update.";
pub const MOVE_FIRST: &str =
    "Relay runs from the disk image. Move it to Applications, then update.";
pub const NOT_WRITABLE: &str =
    "Relay cannot replace itself in its folder. Download the update from the release page.";

/// Runs a command; its stdout and stderr, or why it failed.
pub type RunCommand = Arc<dyn Fn(&str, &[String]) -> Result<ExecOutput, String> + Send + Sync>;
/// Starts a command that outlives Relay.
pub type SpawnDetached = Arc<dyn Fn(&str, &[String]) + Send + Sync>;

/// What the macOS driver runs with.
pub struct MacUpdateDeps {
    /// The release feed of each channel: GitHub's latest-release JSON, or its release list.
    pub feed_stable: String,
    pub feed_beta: String,
    /// The channel chosen in Settings, read at every check.
    pub channel: Arc<dyn Fn() -> UpdateChannel + Send + Sync>,
    /// `<data>/updates`; each version gets its own folder.
    pub folder: PathBuf,
    pub current: String,
    /// Node's `process.arch`: `arm64` or `x64`.
    pub arch: String,
    /// The running Relay.app.
    pub bundle: PathBuf,
    pub place: Arc<dyn Fn() -> BundlePlace + Send + Sync>,
    /// Relay's pid, which the install waits to end.
    pub pid: u32,
    pub request: Option<UpdateRequest>,
    pub run: RunCommand,
    /// Starts a command that outlives Relay.
    pub spawn_detached: SpawnDetached,
    pub writable: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
}

/// The arch name Node gives this build (`process.arch`).
pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// The DMG for this Mac's architecture, if the release has one.
pub fn dmg_for<'a>(
    assets: &'a [ReleaseAsset],
    version: &str,
    arch: &str,
) -> Option<&'a ReleaseAsset> {
    let want = match arch {
        "arm64" => "arm64",
        "x64" => "x64",
        _ => return None,
    };
    let name = format!("Relay-{version}-{want}.dmg");
    assets.iter().find(|a| a.name == name)
}

static DESIGNATED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^#?\s*designated => (.+)$").expect("valid regex"));
static CDHASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bcdhash\b").expect("valid regex"));
static CERTIFICATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bcertificate\s").expect("valid regex"));

/// The running app's designated requirement, from `codesign --display --requirements -`.
pub fn designated_requirement(display: &str) -> Result<String, UpdateError> {
    let requirement = DESIGNATED
        .captures(display)
        .map(|m| crate::shared::types::js::trim(&m[1]).to_owned())
        .filter(|r| !r.is_empty() && !CDHASH.is_match(r) && CERTIFICATE.is_match(r));
    requirement.ok_or_else(|| UpdateError::new(UPDATE_SIGNATURE_MISMATCH))
}

static VERSION_FOLDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$").expect("valid regex")
});

/// A download folder's name: a version without its `v`.
pub(crate) fn is_version_folder(name: &str) -> bool {
    VERSION_FOLDER.is_match(name)
}

/// Updates the app at TARGET to NEW once Relay (PID) has quit, in place: the bundle's path never
/// goes away, so macOS keeps the Relay widgets placed on the desktop (moving the old bundle aside
/// and deleting it reads as the widget extension being uninstalled, and its widgets vanish). A
/// copy of the old app is kept beside LOG, outside Applications, and put back when the copy
/// fails; then the app is opened. Run by bash, detached. Tests override the tools it calls
/// through RELAY_UPDATE_* variables.
pub const INSTALL_SCRIPT: &str = r#"#!/bin/bash
set -u
PID="$1"; NEW="$2"; TARGET="$3"; LOG="$4"
OPEN="${RELAY_UPDATE_OPEN:-/usr/bin/open}"
DITTO="${RELAY_UPDATE_DITTO:-/usr/bin/ditto}"
RSYNC="${RELAY_UPDATE_RSYNC:-/usr/bin/rsync}"
LSREGISTER="${RELAY_UPDATE_LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"
PLUGINKIT="${RELAY_UPDATE_PLUGINKIT:-/usr/bin/pluginkit}"
exec >>"$LOG" 2>&1
echo "$(date '+%Y-%m-%dT%H:%M:%S') install $NEW -> $TARGET"
for _ in $(seq 1 240); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$PID" 2>/dev/null; then echo "Relay did not quit; nothing changed"; exit 1; fi
DIR="$(dirname "$TARGET")"; NAME="$(basename "$TARGET")"
BACKUP="$(dirname "$LOG")/previous"
reopen() { /usr/bin/env -i "$OPEN" "$TARGET"; }
# Left by older Relays, which swapped the bundle by moving it.
rm -rf "$DIR/.$NAME.installing" "$DIR/.$NAME.previous" "$BACKUP"
if [ -e "$TARGET" ]; then
  if ! /bin/mkdir -p "$BACKUP" || ! "$DITTO" "$TARGET" "$BACKUP/$NAME"; then echo "could not keep a copy of the old app; nothing changed"; rm -rf "$BACKUP"; reopen; exit 1; fi
  if ! "$RSYNC" -rlpt --ignore-times --delete "$NEW/" "$TARGET/"; then
    echo "copy failed; old app put back"
    /usr/bin/rsync -rlpt --ignore-times --delete "$BACKUP/$NAME/" "$TARGET/" || echo "could not put the old app back; it is in $BACKUP"
    reopen; exit 1
  fi
elif ! "$DITTO" "$NEW" "$TARGET"; then echo "copy failed; nothing changed"; exit 1; fi
"$LSREGISTER" -f -R "$TARGET" || true
if [ -d "$TARGET/Contents/PlugIns/RelayWidget.appex" ]; then "$PLUGINKIT" -a "$TARGET/Contents/PlugIns/RelayWidget.appex" || true; fi
rm -rf "$BACKUP"
echo "installed"
reopen
"#;

/// The macOS driver.
pub struct MacUpdateDriver {
    deps: MacUpdateDeps,
    ready: Mutex<Option<(String, PathBuf)>>,
}

fn io(error: std::io::Error) -> UpdateError {
    UpdateError::new(error.to_string())
}

fn rm_rf(path: &Path) {
    let _ = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => Ok(()),
    };
}

fn arg(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl MacUpdateDriver {
    pub fn new(deps: MacUpdateDeps) -> Self {
        MacUpdateDriver {
            deps,
            ready: Mutex::new(None),
        }
    }

    fn dir(&self, version: &str) -> PathBuf {
        self.deps.folder.join(version)
    }

    fn request(&self) -> UpdateRequest {
        self.deps.request.clone().unwrap_or_else(default_request)
    }

    fn run(&self, file: &str, args: &[String]) -> Result<ExecOutput, UpdateError> {
        (self.deps.run)(file, args).map_err(UpdateError)
    }

    fn check_now(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        let channel = (self.deps.channel)();
        let feed = match channel {
            UpdateChannel::Stable => &self.deps.feed_stable,
            UpdateChannel::Beta => &self.deps.feed_beta,
        };
        let feed = fetch_json(feed, Some(&self.request()), None, None)?;
        let release = newest_release(&feed, channel)
            .ok_or_else(|| UpdateError::new("The update feed has no usable release."))?;
        // Never older, on either channel: back on stable, a beta runs until a newer release
        // comes.
        if compare_versions(&release.version, &self.deps.current)
            .map_err(|e| UpdateError::new(e.to_string()))?
            != Ordering::Greater
        {
            report(UpdatePatch::status(UpdateStatus::UpToDate));
            return Ok(());
        }
        let version = release.version.clone();
        report(
            UpdatePatch::status(UpdateStatus::Available)
                .with_version(&version)
                .with_notes_url(&release.notes_url),
        );
        let dmg = dmg_for(&release.assets, &version, &self.deps.arch);
        let sums = release.assets.iter().find(|a| a.name == "SHA256SUMS.txt");
        let (Some(dmg), Some(sums)) = (dmg, sums) else {
            report(
                UpdatePatch::status(UpdateStatus::Manual)
                    .with_manual_reason(UpdateManualReason::NoAsset),
            );
            return Ok(());
        };
        let dir = self.dir(&version);
        let app = dir.join(APP);
        if self.verified(&dir, &app, &version) {
            self.readied(&version, &app, report);
            return Ok(());
        }
        rm_rf(&dir);
        crate::fs_util::create_private_dir_all(&dir).map_err(io)?;
        let expected = parse_checksums(&self.text(&sums.url)?)
            .get(&dmg.name)
            .cloned()
            .ok_or_else(|| UpdateError::new(UPDATE_NO_CHECKSUM))?;
        let file = dir.join(&dmg.name);
        report(UpdatePatch::status(UpdateStatus::Downloading).with_progress(Some(0.0)));
        let digest = self.download(dmg, &file, &mut |progress| {
            report(UpdatePatch::status(UpdateStatus::Downloading).with_progress(Some(progress)))
        })?;
        if digest != expected {
            rm_rf(&dir);
            return Err(UpdateError::new(UPDATE_CHECKSUM_MISMATCH));
        }
        self.unpack(&file, &dir)?;
        rm_rf(&file);
        self.verify(&app, &version)?;
        write_private(
            &dir.join("verified.json"),
            json!({ "version": version, "sha256": digest })
                .to_string()
                .as_bytes(),
        )
        .map_err(io)?;
        self.readied(&version, &app, report);
        Ok(())
    }

    /// Ready to install, unless Relay cannot replace itself where it runs.
    fn readied(&self, version: &str, app: &Path, report: &mut dyn FnMut(UpdatePatch)) {
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((version.to_owned(), app.to_path_buf()));
        report(match self.blocked() {
            Some(reason) => UpdatePatch::status(UpdateStatus::Manual)
                .with_manual_reason(reason)
                .with_progress(None),
            None => UpdatePatch::status(UpdateStatus::Ready).with_progress(None),
        });
    }

    /// An earlier download of this version that passed every check, still intact.
    fn verified(&self, dir: &Path, app: &Path, version: &str) -> bool {
        let marker: Option<Value> = fs::read(dir.join("verified.json"))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok());
        let Some(marker) = marker else { return false };
        if marker.get("version").and_then(Value::as_str) != Some(version) || !app.exists() {
            return false;
        }
        self.verify(app, version).is_ok()
    }

    fn text(&self, url: &str) -> Result<String, UpdateError> {
        let mut response =
            (self.request())(url, &[], Duration::from_secs(30)).map_err(UpdateError)?;
        if !response.ok() {
            return Err(UpdateError(format!(
                "The update download failed (HTTP {}).",
                response.status
            )));
        }
        read_capped(&mut response.body, MAX_SUMS_BYTES)
    }

    /// Streams `asset` to `file`; its SHA-256 in hex.
    fn download(
        &self,
        asset: &ReleaseAsset,
        file: &Path,
        progress: &mut dyn FnMut(f64),
    ) -> Result<String, UpdateError> {
        let mut response =
            (self.request())(&asset.url, &[], Duration::from_secs(30 * 60)).map_err(UpdateError)?;
        if !response.ok() {
            return Err(UpdateError(format!(
                "The update download failed (HTTP {}).",
                response.status
            )));
        }
        let total = match response.content_length {
            Some(length) if length > 0 => length as f64,
            _ => asset.size as f64,
        };
        if total > MAX_DMG_BYTES as f64 {
            return Err(UpdateError::new("The update is too large."));
        }
        let mut hash = Sha256::new();
        let mut partial = file.as_os_str().to_owned();
        partial.push(".part");
        let partial = PathBuf::from(partial);
        let mut out = open_private(&partial).map_err(io)?;
        let mut received: u64 = 0;
        let mut shown = 0.0;
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let read = response.body.read(&mut chunk).map_err(io)?;
            if read == 0 {
                break;
            }
            received += read as u64;
            if received > MAX_DMG_BYTES {
                return Err(UpdateError::new("The update is too large."));
            }
            hash.update(&chunk[..read]);
            out.write_all(&chunk[..read]).map_err(io)?;
            let now = if total > 0.0 {
                received as f64 / total
            } else {
                0.0
            };
            if now - shown >= 0.02 {
                shown = now.min(1.0);
                progress(shown);
            }
        }
        drop(out);
        fs::rename(&partial, file).map_err(io)?;
        Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
    }

    /// Copies Relay.app out of the DMG into `dir`.
    fn unpack(&self, dmg: &Path, dir: &Path) -> Result<(), UpdateError> {
        let mount = dir.join("mount");
        crate::fs_util::create_private_dir(&mount).map_err(io)?;
        self.run(
            "/usr/bin/hdiutil",
            &[
                "attach".into(),
                "-nobrowse".into(),
                "-readonly".into(),
                "-noautoopen".into(),
                "-mountpoint".into(),
                arg(&mount),
                arg(dmg),
            ],
        )?;
        let copied = self.run(
            "/usr/bin/ditto",
            &[arg(&mount.join(APP)), arg(&dir.join(APP))],
        );
        if self
            .run("/usr/bin/hdiutil", &["detach".into(), arg(&mount)])
            .is_err()
        {
            let _ = self.run(
                "/usr/bin/hdiutil",
                &["detach".into(), "-force".into(), arg(&mount)],
            );
        }
        rm_rf(&mount);
        copied.map(|_| ())
    }

    /// Signed whole, with this Relay's own certificate, and the expected version.
    fn verify(&self, app: &Path, version: &str) -> Result<(), UpdateError> {
        let fail = || UpdateError::new(UPDATE_SIGNATURE_MISMATCH);
        let own = self.run(
            "/usr/bin/codesign",
            &[
                "--display".into(),
                "--requirements".into(),
                "-".into(),
                arg(&self.deps.bundle),
            ],
        )?;
        let requirement = designated_requirement(&format!("{}\n{}", own.stdout, own.stderr))?;
        self.run(
            "/usr/bin/codesign",
            &[
                "--verify".into(),
                "--deep".into(),
                "--strict".into(),
                arg(app),
            ],
        )
        .map_err(|_| fail())?;
        self.run(
            "/usr/bin/codesign",
            &[
                "--verify".into(),
                "--strict".into(),
                "--test-requirement".into(),
                format!("={requirement}"),
                arg(app),
            ],
        )
        .map_err(|_| fail())?;
        let shown = self.run(
            "/usr/bin/plutil",
            &[
                "-extract".into(),
                "CFBundleShortVersionString".into(),
                "raw".into(),
                arg(&app.join("Contents").join("Info.plist")),
            ],
        )?;
        if shown.stdout.trim() != version {
            return Err(fail());
        }
        Ok(())
    }

    /// Why it cannot install itself where it runs, or None when it can.
    pub fn blocked(&self) -> Option<UpdateManualReason> {
        match (self.deps.place)() {
            BundlePlace::DiskImage | BundlePlace::Translocated => {
                Some(UpdateManualReason::Location)
            }
            _ if !(self.deps.writable)(self.deps.bundle.parent().unwrap_or(Path::new("/"))) => {
                Some(UpdateManualReason::NotWritable)
            }
            _ => None,
        }
    }

    /// Removes downloads of this version and older ones: once running, a version needs none.
    pub fn prune(&self, running: Option<&str>) {
        let running = running.unwrap_or(&self.deps.current);
        let Ok(entries) = fs::read_dir(&self.deps.folder) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_version_folder(&name)
                && compare_versions(&name, running).is_ok_and(|o| o != Ordering::Greater)
            {
                rm_rf(&entry.path());
            }
        }
    }
}

impl UpdateDriver for MacUpdateDriver {
    fn check(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        self.check_now(report)
    }

    fn install(&self) -> Result<(), UpdateError> {
        let ready = self.ready.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some((version, app)) = ready else {
            return Err(UpdateError::new("No update is ready to install."));
        };
        if let Some(reason) = self.blocked() {
            return Err(UpdateError::new(
                if reason == UpdateManualReason::Location {
                    MOVE_FIRST
                } else {
                    NOT_WRITABLE
                },
            ));
        }
        let script = self.dir(&version).join("install.sh");
        write_mode(&script, INSTALL_SCRIPT.as_bytes(), 0o700).map_err(io)?;
        (self.deps.spawn_detached)(
            "/bin/bash",
            &[
                arg(&script),
                self.deps.pid.to_string(),
                arg(&app),
                arg(&self.deps.bundle),
                arg(&self.deps.folder.join("install.log")),
            ],
        );
        Ok(())
    }
}

/// `fs.writeFileSync(file, data, { mode })`: the mode applies to a new file.
pub(crate) fn write_mode(file: &Path, data: &[u8], mode: u32) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, mode);
    #[cfg(not(unix))]
    let _ = mode;
    options.open(file)?.write_all(data)
}

fn write_private(file: &Path, data: &[u8]) -> std::io::Result<()> {
    write_mode(file, data, 0o600)
}

fn open_private(file: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(file)
}

/// Runs a command as Relay does for the update (2 min, 4 MiB of output).
pub fn default_run() -> RunCommand {
    Arc::new(|file: &str, args: &[String]| {
        crate::detached_exec::run_attached(
            file,
            args,
            &crate::detached_exec::ExecOptions {
                max_buffer: Some(4 * 1024 * 1024),
                ..crate::detached_exec::ExecOptions::timeout_ms(120_000)
            },
        )
        .map_err(|e| e.message)
    })
}

/// Starts the install script outliving Relay, with only PATH: the script's RELAY_UPDATE_* tool
/// overrides never come from Relay's environment, and nothing of it reaches the app the script
/// opens (`env -i`).
pub fn default_spawn_detached() -> SpawnDetached {
    Arc::new(|file: &str, args: &[String]| {
        let mut command = std::process::Command::new(file);
        command
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let _ = command.spawn();
    })
}

/// Whether this user may write into `dir` (`fs.accessSync(dir, W_OK)`).
pub fn writable(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: a NUL-terminated path.
        unsafe { libc::access(c.as_ptr(), libc::W_OK) == 0 }
    }
    #[cfg(not(unix))]
    fs::metadata(dir).is_ok_and(|m| !m.permissions().readonly())
}
