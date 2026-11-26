//! Port of `tests/linux-browser.test.ts`. The two card tests (`instanceLine`, `extensionGuide`)
//! are UI code in `src/lib/extension-ui.ts`, which stays TypeScript.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use relay_core::browser_system::{
    BrowserSystem, LinuxProcess, LockOwner, browser_running, data_dir, extension_instances,
    find_command, linux_browser_system, linux_main_pids, lock_owner, session_environment,
};
use relay_core::shared::browser_extension::{BrowserApp, CLAUDE_EXTENSION_ID, browser_apps};

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
#[cfg(not(windows))]
fn linux_looks_in_the_browsers_with_a_linux_build_only_under_xdg_config_home() {
    let apps: Vec<&str> = browser_apps(Some("linux"))
        .into_iter()
        .map(BrowserApp::as_str)
        .collect();
    assert_eq!(
        apps,
        [
            "chrome",
            "brave",
            "edge",
            "chromium",
            "vivaldi",
            "chrome-beta",
            "chrome-dev"
        ]
    );
    assert_eq!(browser_apps(Some("darwin")).len(), 11);
    let system = linux_browser_system("/home/u", env(&[("XDG_CONFIG_HOME", "/cfg")]));
    assert_eq!(system.platform(), Some("linux"));
    assert_eq!(
        data_dir(&system, BrowserApp::Chrome),
        Path::new("/cfg/google-chrome")
    );
    assert_eq!(
        data_dir(&system, BrowserApp::ChromeDev),
        Path::new("/cfg/google-chrome-unstable")
    );
    assert_eq!(
        data_dir(&system, BrowserApp::Brave),
        Path::new("/cfg/BraveSoftware/Brave-Browser")
    );
    // A relative XDG_CONFIG_HOME is invalid by the spec: ~/.config.
    let relative = linux_browser_system("/home/u", env(&[("XDG_CONFIG_HOME", "cfg")]));
    assert_eq!(
        data_dir(&relative, BrowserApp::Edge),
        Path::new("/home/u/.config/microsoft-edge")
    );
    let unset = linux_browser_system("/home/u", env(&[]));
    assert_eq!(
        data_dir(&unset, BrowserApp::Vivaldi),
        Path::new("/home/u/.config/vivaldi")
    );
}

#[test]
#[cfg(unix)]
fn a_linux_profile_with_the_extension_is_found_through_a_linked_data_folder_too() {
    let home = tempfile::Builder::new()
        .prefix("relay-linux-browser-")
        .tempdir()
        .unwrap();
    let home = home.path();
    // profile-sync-daemon keeps ~/.config/google-chrome as a link into /run.
    let real = home.join("psd").join("google-chrome");
    fs::create_dir_all(
        real.join("Default")
            .join("Local Extension Settings")
            .join(CLAUDE_EXTENSION_ID),
    )
    .unwrap();
    fs::write(
        real.join("Local State"),
        serde_json::json!({ "profile": { "info_cache": { "Default": { "name": "Person 1" } } } })
            .to_string(),
    )
    .unwrap();
    fs::create_dir(home.join(".config")).unwrap();
    std::os::unix::fs::symlink(&real, home.join(".config").join("google-chrome")).unwrap();
    // A mac-only browser's folder name is never looked in.
    fs::create_dir_all(home.join(".config").join("Arc").join("User Data")).unwrap();
    let instances = extension_instances(&linux_browser_system(home, env(&[])));
    let listed: Vec<(BrowserApp, String, String, bool)> = instances
        .into_iter()
        .map(|i| (i.app, i.profile, i.name, i.opened))
        .collect();
    assert_eq!(
        listed,
        [(
            BrowserApp::Chrome,
            "Default".into(),
            "Person 1".into(),
            true
        )]
    );
}

#[test]
fn a_singleton_lock_target_names_its_host_and_pid() {
    assert_eq!(
        lock_owner(Some("merthan-12345")),
        Some(LockOwner {
            host: "merthan".into(),
            pid: 12345
        })
    );
    assert_eq!(
        lock_owner(Some("my-host-name-7")),
        Some(LockOwner {
            host: "my-host-name".into(),
            pid: 7
        })
    );
    assert_eq!(lock_owner(None), None);
    assert_eq!(lock_owner(Some("merthan")), None);
    assert_eq!(lock_owner(Some("merthan-0")), None);
    assert_eq!(lock_owner(Some("merthan-99999999999999999999")), None);
}

/// A Linux browser system that answers only what `browser_running` asks.
struct Fake {
    lock: Option<String>,
    alive: Option<i64>,
    processes: String,
}

impl BrowserSystem for Fake {
    fn support(&self) -> &Path {
        Path::new("/cfg")
    }
    fn platform(&self) -> Option<&str> {
        Some("linux")
    }
    fn hostname(&self) -> Option<&str> {
        Some("here")
    }
    fn read_text(&self, _file: &Path) -> Option<String> {
        None
    }
    fn exists(&self, _file: &Path) -> bool {
        false
    }
    fn modified_at(&self, _dir: &Path) -> Option<f64> {
        None
    }
    fn read_link(&self, file: &Path) -> Option<String> {
        (file == Path::new("/cfg/google-chrome/SingletonLock"))
            .then(|| self.lock.clone())
            .flatten()
    }
    fn alive(&self, pid: i64) -> bool {
        self.alive == Some(pid)
    }
    fn processes(&self) -> Result<String, String> {
        Ok(self.processes.clone())
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

fn fake(lock: Option<&str>, alive: Option<i64>, processes: &str) -> Fake {
    Fake {
        lock: lock.map(str::to_owned),
        alive,
        processes: processes.into(),
    }
}

#[test]
#[cfg(not(windows))]
fn on_linux_a_browser_runs_by_its_live_lock_another_machines_lock_or_its_executable() {
    let running = |f: Fake| browser_running(&f, BrowserApp::Chrome).unwrap();
    assert!(running(fake(Some("here-42"), Some(42), "")));
    // A stale lock of this machine is not running.
    assert!(!running(fake(Some("here-42"), None, "")));
    // Another machine's lock (a shared home): that browser holds the profile.
    assert!(running(fake(Some("there-42"), None, "")));
    // No lock, but the executable runs; another browser's executable does not count.
    assert!(running(fake(
        None,
        None,
        "/usr/bin/bash\n/opt/google/chrome/chrome"
    )));
    assert!(!running(fake(None, None, "/opt/google/chrome-beta/chrome")));
    assert!(!running(fake(
        None,
        None,
        "/home/u/Applications/chrome.app/Contents/MacOS/Google Chrome"
    )));
}

#[test]
fn the_linux_quit_signals_the_browsers_main_process_never_a_helper_or_a_stranger() {
    let p = |pid: i64, exe: &str, args: &[&str]| LinuxProcess {
        pid,
        exe: exe.into(),
        args: args.iter().map(|a| (*a).to_owned()).collect(),
    };
    let procs = [
        p(
            10,
            "/opt/google/chrome/chrome",
            &["/opt/google/chrome/chrome"],
        ),
        p(
            11,
            "/opt/google/chrome/chrome",
            &["/opt/google/chrome/chrome", "--type=zygote"],
        ),
        p(
            12,
            "/opt/google/chrome/chrome",
            &["/opt/google/chrome/chrome", "--type=renderer"],
        ),
        p(20, "/usr/bin/bash", &["bash"]),
        p(
            30,
            "/opt/google/chrome-beta/chrome",
            &["/opt/google/chrome-beta/chrome"],
        ),
    ];
    // The lock's pid, when it is a main browser process of this machine.
    assert_eq!(
        linux_main_pids(BrowserApp::Chrome, Some("host-10"), "host", &procs),
        [10]
    );
    // A recycled pid (a shell now) or a helper is never taken from the lock: the scan decides.
    assert_eq!(
        linux_main_pids(BrowserApp::Chrome, Some("host-20"), "host", &procs),
        [10]
    );
    assert_eq!(
        linux_main_pids(BrowserApp::Chrome, Some("host-12"), "host", &procs),
        [10]
    );
    // Another machine's lock is not this machine's pid.
    assert_eq!(
        linux_main_pids(BrowserApp::Chrome, Some("other-20"), "host", &procs),
        [10]
    );
    assert_eq!(
        linux_main_pids(BrowserApp::ChromeBeta, None, "host", &procs),
        [30]
    );
    assert!(linux_main_pids(BrowserApp::Brave, None, "host", &procs).is_empty());
}

#[test]
#[cfg(not(windows))]
fn a_browsers_launcher_is_the_first_command_found_on_path() {
    let present = ["/usr/bin/google-chrome", "/opt/bin/google-chrome-stable"];
    let has = |file: &Path| present.iter().any(|p| Path::new(p) == file);
    let dirs = |list: &[&str]| list.iter().map(|d| (*d).to_owned()).collect::<Vec<_>>();
    assert_eq!(
        find_command(
            &["google-chrome-stable", "google-chrome"],
            &dirs(&["/usr/bin", "/opt/bin"]),
            &has
        ),
        Some("/opt/bin/google-chrome-stable".into())
    );
    assert_eq!(
        find_command(&["google-chrome"], &dirs(&["relative", "/usr/bin"]), &has),
        Some("/usr/bin/google-chrome".into())
    );
    assert_eq!(
        find_command(&["chromium"], &dirs(&["/usr/bin"]), &has),
        None
    );
}

#[test]
fn a_browser_relay_starts_gets_the_graphical_session_not_electrons_or_an_appimages_variables() {
    let kept = session_environment(&env(&[
        ("HOME", "/home/u"),
        ("PATH", "/usr/bin"),
        ("DISPLAY", ":0"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ("XDG_CURRENT_DESKTOP", "KDE"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
        ("LC_ALL", "en_US.UTF-8"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("CHROME_DESKTOP", "relay.desktop"),
        ("LD_LIBRARY_PATH", "/tmp/.mount/usr/lib"),
        ("APPDIR", "/tmp/.mount"),
    ]));
    let keys: Vec<&str> = kept.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "DBUS_SESSION_BUS_ADDRESS",
            "DISPLAY",
            "HOME",
            "LC_ALL",
            "PATH",
            "WAYLAND_DISPLAY",
            "XDG_CURRENT_DESKTOP",
            "XDG_RUNTIME_DIR",
        ]
    );
}
