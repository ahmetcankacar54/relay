//! Port of `electron/core/install-location.ts`: where the running Relay.app sits, as far as
//! Gatekeeper cares.

use std::path::{Path, PathBuf};

/// Where the running Relay.app sits. The share builds are not notarized, so macOS asks once
/// ("Open Anyway") and records the answer on the bundle. It cannot record it on a disk image,
/// which is read-only, or in App Translocation's randomized read-only copy: there it asks at
/// every launch. `Applications`: /Applications or ~/Applications. `Elsewhere`: a writable place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BundlePlace {
    Applications,
    DiskImage,
    Translocated,
    Elsewhere,
}

/// The .app bundle around the running executable (Contents/MacOS/<name>); None outside one.
pub fn bundle_path(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.to_string_lossy().ends_with(".app"))
    .then(|| bundle.to_path_buf())
}

pub fn bundle_place(bundle: &Path, in_applications: bool) -> BundlePlace {
    let text = bundle.to_string_lossy();
    if text.contains("/AppTranslocation/") {
        BundlePlace::Translocated
    } else if text.starts_with("/Volumes/") {
        BundlePlace::DiskImage
    } else if in_applications {
        BundlePlace::Applications
    } else {
        BundlePlace::Elsewhere
    }
}

/// Places where macOS cannot keep the user's approval, so Relay offers to move itself.
pub fn forgets_approval(place: BundlePlace) -> bool {
    matches!(place, BundlePlace::DiskImage | BundlePlace::Translocated)
}

/// Removes the download quarantine from Relay's own bundle once it runs from a writable place.
/// Gatekeeper has already let this copy start and only assesses quarantined apps, so this keeps
/// an approval macOS failed to record (or the widget extension the system launches) from asking
/// again. The quarantine is not part of the code signature. Never fails: false when it could
/// not.
pub fn clear_own_quarantine<E>(
    bundle: &Path,
    run: impl FnOnce(&str, &[String]) -> Result<(), E>,
) -> bool {
    run(
        "/usr/bin/xattr",
        &[
            "-dr".to_owned(),
            "com.apple.quarantine".to_owned(),
            bundle.to_string_lossy().into_owned(),
        ],
    )
    .is_ok()
}
