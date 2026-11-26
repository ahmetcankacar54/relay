//! Port of tests/install-location.test.ts.

use std::path::{Path, PathBuf};

use relay_core::install_location::{
    BundlePlace, bundle_path, bundle_place, clear_own_quarantine, forgets_approval,
};

#[test]
fn the_bundle_is_found_around_contents_macos_and_nothing_outside_an_app() {
    assert_eq!(
        bundle_path(Path::new("/Applications/Relay.app/Contents/MacOS/Relay")),
        Some(PathBuf::from("/Applications/Relay.app"))
    );
    assert_eq!(
        bundle_path(Path::new(
            "/Volumes/Relay 0.13.3/Relay.app/Contents/MacOS/Relay"
        )),
        Some(PathBuf::from("/Volumes/Relay 0.13.3/Relay.app"))
    );
    assert_eq!(
        bundle_path(Path::new(
            "/usr/local/lib/node_modules/electron/dist/electron"
        )),
        None
    );
    assert_eq!(bundle_path(Path::new("/tmp/Contents/MacOS/Relay")), None);
}

#[test]
fn a_disk_image_or_a_translocated_copy_forgets_the_approval_applications_and_other_folders_keep_it()
{
    let translocated = "/private/var/folders/x1/abc/T/AppTranslocation/0D2F-11AA/d/Relay.app";
    assert_eq!(
        bundle_place(Path::new(translocated), false),
        BundlePlace::Translocated
    );
    assert_eq!(
        bundle_place(Path::new("/Volumes/Relay 0.13.3/Relay.app"), false),
        BundlePlace::DiskImage
    );
    assert_eq!(
        bundle_place(Path::new("/Applications/Relay.app"), true),
        BundlePlace::Applications
    );
    assert_eq!(
        bundle_place(Path::new("/Users/me/Desktop/Relay.app"), false),
        BundlePlace::Elsewhere
    );
    assert!(
        forgets_approval(BundlePlace::Translocated) && forgets_approval(BundlePlace::DiskImage)
    );
    assert!(
        !forgets_approval(BundlePlace::Applications) && !forgets_approval(BundlePlace::Elsewhere)
    );
}

#[test]
fn the_quarantine_is_cleared_from_the_whole_bundle_with_the_systems_xattr_and_a_failure_is_only_reported()
 {
    let mut calls: Vec<(String, Vec<String>)> = Vec::new();
    assert!(clear_own_quarantine(
        Path::new("/Applications/Relay.app"),
        |file, args| -> Result<(), ()> {
            calls.push((file.to_owned(), args.to_vec()));
            Ok(())
        }
    ));
    assert_eq!(
        calls,
        vec![(
            "/usr/bin/xattr".to_owned(),
            vec![
                "-dr".to_owned(),
                "com.apple.quarantine".to_owned(),
                "/Applications/Relay.app".to_owned()
            ]
        )]
    );
    assert!(!clear_own_quarantine(
        Path::new("/Applications/Relay.app"),
        |_, _| Err("Operation not permitted")
    ));
}
