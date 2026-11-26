//! Port of tests/data-reset.test.ts.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use relay_core::data_reset::{
    BeginResetError, NodeFs, PortError, RESET_MARKER, ResetFs, ResetPorts, begin_reset,
    finish_pending_reset, safe_reset_root,
};

struct Layout {
    _dir: tempfile::TempDir,
    home: PathBuf,
    root: PathBuf,
    logs: PathBuf,
    claude: PathBuf,
}

/// A temp home with Relay's data folder, its log folder, and things beside them that are not Relay's.
fn layout() -> Layout {
    let dir = tempfile::Builder::new()
        .prefix("relay-reset-")
        .tempdir()
        .unwrap();
    let home = dir.path().to_path_buf();
    let root = home.join("Library/Application Support/Relay");
    let logs = home.join("Library/Logs/Relay");
    let claude = home.join("Library/Application Support/Claude");
    let files = [
        ("state.json", "{}"),
        ("language.json", "{}"),
        (
            "desktop-vault/accounts/11111111-2222-4333-8444-555555555555.bin",
            "sealed",
        ),
        (
            "profiles/66666666-7777-4888-8999-000000000000/.claude.json",
            "{}",
        ),
        (
            "profiles/66666666-7777-4888-8999-000000000000/antigravity-oauth/example.json",
            "{}",
        ),
        (
            "tools/cli-proxy-api-8.0.61-darwin-arm64/cli-proxy-api",
            "binary",
        ),
        ("relay-backups/before-import.relaybackup", "RLYB"),
        ("Local Storage/leveldb/000003.log", "chromium"),
    ];
    for (relative, text) in files {
        let file = root.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, text).unwrap();
    }
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("main-errors.log"), "log").unwrap();
    fs::create_dir_all(&claude).unwrap();
    fs::write(claude.join("config.json"), "claude's own").unwrap();
    fs::write(home.join("keep.txt"), "outside").unwrap();
    // A link inside the folder to Claude's data: removed as a link, never followed.
    #[cfg(unix)]
    std::os::unix::fs::symlink(&claude, root.join("claude-link")).unwrap();
    // Windows needs a privilege for links; without it the layout simply has none.
    #[cfg(windows)]
    let _ = std::os::windows::fs::symlink_dir(&claude, root.join("claude-link"));
    Layout {
        _dir: dir,
        home,
        root,
        logs,
        claude,
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

struct FakePorts {
    root: PathBuf,
    busy: Option<String>,
    calls: RefCell<Vec<&'static str>>,
    fail_unbind: bool,
}

fn ports(root: &Path, busy: Option<&str>) -> FakePorts {
    FakePorts {
        root: root.to_path_buf(),
        busy: busy.map(str::to_owned),
        calls: RefCell::new(Vec::new()),
        fail_unbind: false,
    }
}

impl ResetPorts for FakePorts {
    fn root(&self) -> PathBuf {
        self.root.clone()
    }
    fn busy(&self) -> Option<String> {
        self.busy.clone()
    }
    fn stop_gateway(&self) -> Result<(), PortError> {
        self.calls.borrow_mut().push("gateway");
        Ok(())
    }
    fn unbind_clients(&self) -> Result<(), PortError> {
        if self.fail_unbind {
            return Err("Codex settings could not be written.".into());
        }
        self.calls.borrow_mut().push("unbind");
        Ok(())
    }
    fn remove_login_item(&self) -> Result<(), PortError> {
        self.calls.borrow_mut().push("login-item");
        Ok(())
    }
    fn remove_secrets(&self) -> Result<(), PortError> {
        self.calls.borrow_mut().push("secrets");
        Ok(())
    }
    fn relaunch(&self) {
        self.calls.borrow_mut().push("relaunch");
    }
}

fn begin(ports: &FakePorts, home: &Path) -> Result<(), BeginResetError> {
    begin_reset(ports, &NodeFs, home, 1_795_000_000_000)
}

#[test]
fn a_reset_stops_what_lives_outside_the_folder_then_the_next_launch_empties_exactly_relay_s_folders()
 {
    let Layout {
        _dir,
        home,
        root,
        logs,
        claude,
    } = layout();
    let entries: Vec<PathBuf> = names(&root).iter().map(|name| root.join(name)).collect();
    let value = ports(&root, None);
    begin(&value, &home).unwrap();
    assert_eq!(
        *value.calls.borrow(),
        ["gateway", "unbind", "login-item", "secrets", "relaunch"]
    );
    assert!(root.join(RESET_MARKER).exists());
    assert!(
        root.join("state.json").exists(),
        "nothing is deleted while Relay runs"
    );

    let removed = finish_pending_reset(&root, std::slice::from_ref(&logs), &NodeFs, &home);
    let mut expected: HashSet<PathBuf> = entries.into_iter().collect();
    expected.insert(logs.clone());
    expected.insert(root.join(RESET_MARKER));
    assert_eq!(
        removed.unwrap().into_iter().collect::<HashSet<_>>(),
        expected
    );
    assert!(names(&root).is_empty());
    assert!(!logs.exists());
    assert_eq!(
        fs::read_to_string(claude.join("config.json")).unwrap(),
        "claude's own"
    );
    assert_eq!(
        fs::read_to_string(home.join("keep.txt")).unwrap(),
        "outside"
    );
    assert_eq!(
        finish_pending_reset(&root, &[logs], &NodeFs, &home),
        None,
        "done once"
    );
}

#[test]
fn without_the_marker_the_launch_deletes_nothing() {
    let Layout {
        _dir,
        home,
        root,
        logs,
        ..
    } = layout();
    let before = names(&root);
    assert_eq!(
        finish_pending_reset(&root, std::slice::from_ref(&logs), &NodeFs, &home),
        None
    );
    assert_eq!(names(&root), before);
    assert!(logs.exists());
}

#[test]
fn a_reset_is_refused_during_a_desktop_operation_with_nothing_touched() {
    let Layout {
        _dir, home, root, ..
    } = layout();
    let value = ports(
        &root,
        Some("Finish the Desktop handoff before starting another Desktop operation."),
    );
    match begin(&value, &home) {
        Err(BeginResetError::Refused(refused)) => assert!(refused.to_string().contains("Desktop")),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(value.calls.borrow().is_empty());
    assert!(!root.join(RESET_MARKER).exists());
}

#[test]
fn a_step_that_fails_stops_the_reset_before_the_marker() {
    let Layout {
        _dir, home, root, ..
    } = layout();
    let mut value = ports(&root, None);
    value.fail_unbind = true;
    let error = begin(&value, &home).unwrap_err();
    assert!(error.to_string().contains("Codex"), "{error}");
    assert!(!root.join(RESET_MARKER).exists());
}

/// The real file system, but `state.json` cannot be removed.
struct BusyStateFs;

impl ResetFs for BusyStateFs {
    fn exists(&self, file: &Path) -> bool {
        NodeFs.exists(file)
    }
    fn read_dir(&self, dir: &Path) -> io::Result<Vec<String>> {
        NodeFs.read_dir(dir)
    }
    fn remove(&self, file: &Path) -> io::Result<()> {
        if file.to_string_lossy().ends_with("state.json") {
            return Err(io::Error::new(io::ErrorKind::ResourceBusy, "busy"));
        }
        NodeFs.remove(file)
    }
    fn write_file(&self, file: &Path, data: &str, mode: u32) -> io::Result<()> {
        NodeFs.write_file(file, data, mode)
    }
}

#[test]
fn a_removal_that_fails_leaves_the_marker_for_the_next_launch() {
    let Layout {
        _dir, home, root, ..
    } = layout();
    fs::write(root.join(RESET_MARKER), "{}").unwrap();
    let removed = finish_pending_reset(&root, &[], &BusyStateFs, &home).unwrap();
    assert!(
        !removed
            .iter()
            .any(|file| file.to_string_lossy().ends_with("state.json"))
    );
    let mut expected = vec![RESET_MARKER.to_owned(), "state.json".to_owned()];
    expected.sort();
    assert_eq!(names(&root), expected);
}

#[test]
fn only_a_folder_below_the_home_folder_can_be_reset() {
    let base = std::path::absolute(Path::new(std::path::MAIN_SEPARATOR_STR)).unwrap();
    let home = base.join("Users").join("example");
    assert!(safe_reset_root(
        &home
            .join("Library")
            .join("Application Support")
            .join("Relay"),
        &home
    ));
    assert!(!safe_reset_root(&home, &home));
    assert!(!safe_reset_root(home.parent().unwrap(), &home));
    assert!(!safe_reset_root(&base, &home));
    assert!(!safe_reset_root(Path::new("Relay"), &home));
}
