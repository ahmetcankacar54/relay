//! Windows and Linux updates, replacing `electron/core/win-linux-update.ts` (electron-updater).
//! The release's installer for this platform (`Relay-Setup-<v>-x64.exe`, or
//! `Relay-<v>-x86_64.AppImage`) is installed only when the release's SHA256SUMS.txt carries a
//! valid Ed25519 signature by the embedded key and lists the downloaded file, under its own name
//! for that version, with its SHA-256; otherwise the download is deleted and never installed.
//! Windows runs the installer silently (`/S`), detached, and Relay quits; Linux replaces the
//! AppImage it runs from (`$APPIMAGE`) and is started again. An AppImage can only update when
//! it runs as one.

use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::app_update::{
    RELEASE_REPO, UpdateDriver, UpdateError, UpdatePatch, UpdateRequest, compare_versions,
    default_request, fetch_json, newest_release, parse_checksums, read_capped, release_feed,
};
use crate::mac_update::{
    UPDATE_CHECKSUM_MISMATCH, UPDATE_NO_CHECKSUM, UPDATE_SIGNATURE_MISMATCH, is_version_folder,
};
use crate::meters::common::buffer_from_base64;
use crate::relay_paths::Platform;
use crate::shared::types::{UpdateChannel, UpdateManualReason, UpdateStatus};
use crate::update_signing_key::UPDATE_SIGNING_PUBLIC_KEY;

const MAX_SUMS_BYTES: u64 = 64 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 1024;
/// An installer larger than this is not one of Relay's.
const MAX_INSTALLER_BYTES: u64 = 600 * 1024 * 1024;
const SUMS: &str = "SHA256SUMS.txt";
const SIGNATURE: &str = "SHA256SUMS.txt.sig";

/// The installer a release publishes for this platform: the bundle's artifact name for it.
pub fn installer_name(platform: Platform, version: &str) -> String {
    if platform == Platform::Windows {
        format!("Relay-Setup-{version}-x64.exe")
    } else {
        format!("Relay-{version}-x86_64.AppImage")
    }
}

/// A file of a release, by name.
pub fn release_file(version: &str, name: &str) -> String {
    format!("https://github.com/{RELEASE_REPO}/releases/download/v{version}/{name}")
}

/// The DER header of an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows it.
const ED25519_SPKI: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// Whether `signature` (base64 Ed25519) signs `text` under `public_key` (SPKI DER, base64). A
/// key of another kind never verifies.
pub fn signed_by(text: &str, signature: &str, public_key: &str) -> bool {
    let key = buffer_from_base64(public_key);
    let Some(raw) = key.strip_prefix(&ED25519_SPKI[..]) else {
        return false;
    };
    let Ok(raw) = <[u8; 32]>::try_from(raw) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(&raw) else {
        return false;
    };
    let Ok(signature) = <[u8; 64]>::try_from(buffer_from_base64(crate::shared::types::js::trim(
        signature,
    ))) else {
        return false;
    };
    key.verify(text.as_bytes(), &Signature::from_bytes(&signature))
        .is_ok()
}

/// Starts a program that outlives Relay (the installer).
pub type LaunchDetached = Arc<dyn Fn(&Path, &[String]) -> Result<(), String> + Send + Sync>;

/// What the Windows and Linux driver runs with.
pub struct WinLinuxUpdateDeps {
    /// The release feed of each channel: GitHub's latest-release JSON, or its release list.
    pub feed_stable: String,
    pub feed_beta: String,
    /// The channel chosen in Settings, read at every check.
    pub channel: Arc<dyn Fn() -> UpdateChannel + Send + Sync>,
    /// `<data>/updates`; each version's download goes in its own folder.
    pub folder: PathBuf,
    pub current: String,
    /// Windows or Linux.
    pub platform: Platform,
    /// The environment: `APPIMAGE` on Linux.
    pub env: BTreeMap<String, String>,
    pub request: Option<UpdateRequest>,
    /// Tests sign with their own key; the embedded one otherwise.
    pub public_key: Option<String>,
    /// Starts the Windows installer, detached.
    pub launch: LaunchDetached,
    /// Asks the app shell to start this AppImage again once Relay has quit (Linux).
    pub relaunch: Arc<dyn Fn(&Path) + Send + Sync>,
}

impl WinLinuxUpdateDeps {
    /// GitHub's feeds and this computer's defaults, for the app.
    pub fn new(
        folder: PathBuf,
        current: String,
        channel: Arc<dyn Fn() -> UpdateChannel + Send + Sync>,
        relaunch: Arc<dyn Fn(&Path) + Send + Sync>,
    ) -> Self {
        WinLinuxUpdateDeps {
            feed_stable: release_feed(UpdateChannel::Stable),
            feed_beta: release_feed(UpdateChannel::Beta),
            channel,
            folder,
            current,
            platform: Platform::current(),
            env: crate::relay_cli_path::process_env(),
            request: None,
            public_key: None,
            launch: default_launch_detached(),
            relaunch,
        }
    }
}

/// The Windows and Linux driver.
pub struct WinLinuxUpdateDriver {
    deps: WinLinuxUpdateDeps,
    /// The verified installer, ready to run.
    ready: Mutex<Option<PathBuf>>,
}

fn io(error: std::io::Error) -> UpdateError {
    UpdateError::new(error.to_string())
}

fn hex(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A file's SHA-256 in hex.
fn sha256_file(file: &Path) -> std::io::Result<String> {
    let mut hash = Sha256::new();
    let mut input = fs::File::open(file)?;
    let mut chunk = vec![0u8; 256 * 1024];
    loop {
        let read = input.read(&mut chunk)?;
        if read == 0 {
            return Ok(hex(&hash.finalize()));
        }
        hash.update(&chunk[..read]);
    }
}

impl WinLinuxUpdateDriver {
    pub fn new(deps: WinLinuxUpdateDeps) -> Self {
        WinLinuxUpdateDriver {
            deps,
            ready: Mutex::new(None),
        }
    }

    fn appimage(&self) -> Option<&String> {
        self.deps.env.get("APPIMAGE").filter(|v| !v.is_empty())
    }

    fn request(&self) -> UpdateRequest {
        self.deps.request.clone().unwrap_or_else(default_request)
    }

    fn text(&self, url: &str, max_bytes: u64) -> Result<String, UpdateError> {
        let mut response =
            (self.request())(url, &[], Duration::from_secs(30)).map_err(UpdateError)?;
        if !response.ok() {
            return Err(UpdateError(format!(
                "The update download failed (HTTP {}).",
                response.status
            )));
        }
        read_capped(&mut response.body, max_bytes)
    }

    /// The signed sums' digest for `name`: the signature is checked before anything is
    /// downloaded.
    fn expected_digest(
        &self,
        sums_url: Option<&str>,
        sig_url: Option<&str>,
        name: &str,
    ) -> Result<String, UpdateError> {
        let sums = sums_url
            .ok_or(())
            .and_then(|url| self.text(url, MAX_SUMS_BYTES).map_err(|_| ()))
            .map_err(|()| UpdateError::new(UPDATE_NO_CHECKSUM))?;
        let signature = sig_url
            .ok_or(())
            .and_then(|url| self.text(url, MAX_SIGNATURE_BYTES).map_err(|_| ()))
            .map_err(|()| UpdateError::new(UPDATE_SIGNATURE_MISMATCH))?;
        let key = self
            .deps
            .public_key
            .as_deref()
            .unwrap_or(UPDATE_SIGNING_PUBLIC_KEY);
        if !signed_by(&sums, &signature, key) {
            return Err(UpdateError::new(UPDATE_SIGNATURE_MISMATCH));
        }
        parse_checksums(&sums)
            .get(name)
            .cloned()
            .ok_or_else(|| UpdateError::new(UPDATE_NO_CHECKSUM))
    }

    /// Streams `url` to `file`; its SHA-256 in hex.
    fn download(
        &self,
        url: &str,
        size: i64,
        file: &Path,
        progress: &mut dyn FnMut(f64),
    ) -> Result<String, UpdateError> {
        let mut response =
            (self.request())(url, &[], Duration::from_secs(30 * 60)).map_err(UpdateError)?;
        if !response.ok() {
            return Err(UpdateError(format!(
                "The update download failed (HTTP {}).",
                response.status
            )));
        }
        let total = match response.content_length {
            Some(length) if length > 0 => length as f64,
            _ => size as f64,
        };
        if total > MAX_INSTALLER_BYTES as f64 {
            return Err(UpdateError::new("The update is too large."));
        }
        let mut partial = file.as_os_str().to_owned();
        partial.push(".part");
        let partial = PathBuf::from(partial);
        let mut out = {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            options.open(&partial).map_err(io)?
        };
        let mut hash = Sha256::new();
        let mut received: u64 = 0;
        let mut shown = 0.0;
        let mut chunk = vec![0u8; 256 * 1024];
        loop {
            let read = response.body.read(&mut chunk).map_err(io)?;
            if read == 0 {
                break;
            }
            received += read as u64;
            if received > MAX_INSTALLER_BYTES {
                drop(out);
                let _ = fs::remove_file(&partial);
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
        out.sync_all().map_err(io)?;
        drop(out);
        fs::rename(&partial, file).map_err(io)?;
        Ok(hex(&hash.finalize()))
    }

    fn check_now(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = None;
        // Beta takes the newest release of either kind; stable only the latest stable one.
        let channel = (self.deps.channel)();
        let feed = match channel {
            UpdateChannel::Stable => &self.deps.feed_stable,
            UpdateChannel::Beta => &self.deps.feed_beta,
        };
        let feed = fetch_json(feed, Some(&self.request()), None, None)?;
        let release = newest_release(&feed, channel)
            .ok_or_else(|| UpdateError::new("The update feed has no usable release."))?;
        // Never a downgrade, also not after leaving beta.
        if compare_versions(&release.version, &self.deps.current)
            .map_err(|e| UpdateError::new(e.to_string()))?
            != Ordering::Greater
        {
            report(UpdatePatch::status(UpdateStatus::UpToDate));
            return Ok(());
        }
        let version = release.version.clone();
        // An AppImage that does not run as one cannot replace itself: nothing to download.
        if self.deps.platform == Platform::Linux && self.appimage().is_none() {
            report(
                UpdatePatch::status(UpdateStatus::Manual)
                    .with_manual_reason(UpdateManualReason::NotAppimage)
                    .with_version(&version)
                    .with_notes_url(&release.notes_url),
            );
            return Ok(());
        }
        report(
            UpdatePatch::status(UpdateStatus::Available)
                .with_version(&version)
                .with_notes_url(&release.notes_url),
        );
        let name = installer_name(self.deps.platform, &version);
        let asset = |wanted: &str| release.assets.iter().find(|a| a.name == wanted);
        let Some(installer) = asset(&name) else {
            report(
                UpdatePatch::status(UpdateStatus::Manual)
                    .with_manual_reason(UpdateManualReason::NoAsset),
            );
            return Ok(());
        };
        let expected = self.expected_digest(
            asset(SUMS).map(|a| a.url.as_str()),
            asset(SIGNATURE).map(|a| a.url.as_str()),
            &name,
        )?;
        let dir = self.deps.folder.join(&version);
        let file = dir.join(&name);
        // An earlier download of this version that still matches the signed sums.
        let kept = sha256_file(&file).is_ok_and(|digest| digest == expected);
        if !kept {
            let _ = fs::remove_dir_all(&dir);
            crate::fs_util::create_private_dir_all(&dir).map_err(io)?;
            report(UpdatePatch::status(UpdateStatus::Downloading).with_progress(Some(0.0)));
            let digest = self.download(&installer.url, installer.size, &file, &mut |progress| {
                report(UpdatePatch::status(UpdateStatus::Downloading).with_progress(Some(progress)))
            })?;
            if digest != expected {
                let _ = fs::remove_file(&file);
                return Err(UpdateError::new(UPDATE_CHECKSUM_MISMATCH));
            }
        }
        *self.ready.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
        report(UpdatePatch::status(UpdateStatus::Ready).with_progress(None));
        Ok(())
    }

    /// Linux: the verified AppImage put in place of the one Relay runs from, through a file
    /// beside it, so `$APPIMAGE` is never half written.
    fn replace_appimage(&self, installer: &Path) -> Result<PathBuf, UpdateError> {
        let target = PathBuf::from(
            self.appimage()
                .ok_or_else(|| UpdateError::new("No update is ready to install."))?,
        );
        let dir = target.parent().unwrap_or(Path::new("/"));
        let name = target
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let next = dir.join(format!(".{name}.relay-update"));
        let result = (|| {
            fs::copy(installer, &next)?;
            #[cfg(unix)]
            fs::set_permissions(&next, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
            // Writable: Windows refuses to flush a read-only handle.
            fs::OpenOptions::new().write(true).open(&next)?.sync_all()?;
            fs::rename(&next, &target)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&next);
            return Err(io(error));
        }
        Ok(target)
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
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

impl UpdateDriver for WinLinuxUpdateDriver {
    fn check(&self, report: &mut dyn FnMut(UpdatePatch)) -> Result<(), UpdateError> {
        self.check_now(report)
    }

    fn install(&self) -> Result<(), UpdateError> {
        let ready = self.ready.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(installer) = ready else {
            return Err(UpdateError::new("No update is ready to install."));
        };
        if self.deps.platform == Platform::Windows {
            (self.deps.launch)(&installer, &["/S".to_owned()]).map_err(UpdateError)?;
        } else {
            let target = self.replace_appimage(&installer)?;
            (self.deps.relaunch)(&target);
        }
        Ok(())
    }
}

/// Starts `program` with `args` outside Relay's process group (a detached process on Windows),
/// its output discarded.
pub fn default_launch_detached() -> LaunchDetached {
    Arc::new(|program: &Path, args: &[String]| {
        let mut command = std::process::Command::new(program);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        command.spawn().map(|_| ()).map_err(|e| e.to_string())
    })
}
