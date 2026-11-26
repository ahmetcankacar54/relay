//! Port of `tests/extension-access.test.ts`. "with no extension found because macOS blocks the
//! browser, the card says how to allow it" tests UI code (`src/lib/extension-ui.ts`) and stays TS.

use std::fs;
use std::path::{Path, PathBuf};

use relay_core::browser_system::{BrowserSystem, denied_browsers, mac_browser_system};
use relay_core::shared::browser_extension::BrowserApp;

/// A system where `present` data folders exist and `denied` ones refuse their Local State.
struct Fake {
    support: PathBuf,
    present: Vec<PathBuf>,
    denied: Option<Vec<PathBuf>>,
}

impl BrowserSystem for Fake {
    fn support(&self) -> &Path {
        &self.support
    }
    fn read_text(&self, _file: &Path) -> Option<String> {
        None
    }
    fn exists(&self, file: &Path) -> bool {
        self.present.iter().any(|dir| dir == file)
    }
    fn denied(&self, file: &Path) -> bool {
        self.denied
            .as_ref()
            .is_some_and(|denied| denied.iter().any(|dir| dir.join("Local State") == file))
    }
    fn modified_at(&self, _dir: &Path) -> Option<f64> {
        None
    }
    fn read_link(&self, _file: &Path) -> Option<String> {
        None
    }
    fn alive(&self, _pid: i64) -> bool {
        false
    }
    fn processes(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn quit(&self, _app: BrowserApp) -> Result<(), String> {
        Ok(())
    }
    fn launch(&self, _app: BrowserApp) -> Result<(), String> {
        Ok(())
    }
    fn open_url(&self, _app: BrowserApp, _url: &str, _profile: &str) -> Result<(), String> {
        Ok(())
    }
    fn sleep(&self, _ms: u64) {}
}

fn fake(present: &[&str], denied: Option<&[&str]>) -> Fake {
    let support = PathBuf::from("/support");
    let under = |list: &[&str]| list.iter().map(|dir| support.join(dir)).collect::<Vec<_>>();
    Fake {
        present: under(present),
        denied: denied.map(under),
        support: support.clone(),
    }
}

#[test]
fn a_browser_macos_keeps_from_relay_is_told_apart_from_one_that_is_not_there() {
    let system = fake(
        &["Google/Chrome", "BraveSoftware/Brave-Browser"],
        Some(&["Google/Chrome"]),
    );
    assert_eq!(denied_browsers(&system), [BrowserApp::Chrome]);
    // A browser that is not installed, or a fake system without the check, is never "denied".
    assert!(denied_browsers(&fake(&[], Some(&["Google/Chrome"]))).is_empty());
    assert!(denied_browsers(&fake(&["Google/Chrome"], None)).is_empty());
}

#[test]
fn the_real_check_says_readable_files_are_not_denied_and_missing_ones_are_not_either() {
    let dir = tempfile::Builder::new()
        .prefix("relay-access-")
        .tempdir()
        .unwrap();
    let file = dir.path().join("Local State");
    fs::write(&file, "{}").unwrap();
    let system = mac_browser_system(dir.path());
    assert!(!system.denied(&file));
    assert!(!system.denied(&dir.path().join("missing")));
}
