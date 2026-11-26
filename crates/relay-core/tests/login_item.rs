//! Port of tests/login-item.test.ts.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use relay_core::login_item::{
    LOGIN_LAUNCH_FLAG, LoginItemHost, LoginItemSettings, NoLoginItem, autostart_entry,
    autostart_file, exec_argument, launch_at_login_enabled, launched_at_login, set_launch_at_login,
    windows_run_command,
};
use relay_core::relay_paths::Platform;

fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn the_linux_autostart_entry_lives_under_xdg_config_home_else_config() {
    let home = Path::new("/home/alto");
    assert_eq!(
        autostart_file(&env(&[]), home),
        home.join(".config").join("autostart").join("relay.desktop")
    );
    assert_eq!(
        autostart_file(&env(&[("XDG_CONFIG_HOME", "/data/config")]), home),
        Path::new("/data/config")
            .join("autostart")
            .join("relay.desktop")
    );
    // A relative value is invalid by the spec and ignored.
    assert_eq!(
        autostart_file(&env(&[("XDG_CONFIG_HOME", "config")]), home),
        home.join(".config").join("autostart").join("relay.desktop")
    );
}

#[test]
fn the_autostart_entry_starts_relay_hidden_with_its_path_quoted_as_the_desktop_entry_spec_says() {
    assert_eq!(
        autostart_entry("/opt/Relay/relay"),
        [
            "[Desktop Entry]",
            "Type=Application",
            "Version=1.0",
            "Name=Relay",
            "Exec=/opt/Relay/relay --hidden",
            "Terminal=false",
            "X-GNOME-Autostart-enabled=true",
            "",
        ]
        .join("\n")
    );
    assert_eq!(
        exec_argument("/home/alto/Apps/Relay 1.0.AppImage"),
        "\"/home/alto/Apps/Relay 1.0.AppImage\""
    );
    // `$` and `"` are escaped inside quotes, and every backslash is doubled again by the
    // string escape.
    assert_eq!(exec_argument("/tmp/a$b\"c"), "\"/tmp/a\\\\$b\\\\\"c\"");
    // A percent sign would read as a field code.
    assert_eq!(exec_argument("/tmp/100%/relay"), "/tmp/100%%/relay");
}

#[test]
fn a_login_launch_is_the_flag_on_windows_and_linux_and_the_systems_word_on_macos() {
    assert!(launched_at_login(
        &["relay", LOGIN_LAUNCH_FLAG],
        Platform::Linux,
        false
    ));
    assert!(launched_at_login(
        &["relay.exe", LOGIN_LAUNCH_FLAG],
        Platform::Windows,
        false
    ));
    assert!(!launched_at_login(&["relay"], Platform::Linux, true));
    assert!(launched_at_login(&["Relay"], Platform::MacOs, true));
    assert!(!launched_at_login(
        &["Relay", LOGIN_LAUNCH_FLAG],
        Platform::MacOs,
        false
    ));
}

/// A login item that fails the test when asked: Linux never asks the system.
struct NotOnLinux;

impl LoginItemSettings for NotOnLinux {
    fn get_login_item_settings(&self, _args: Option<&[&str]>) -> bool {
        panic!("not on Linux")
    }
    fn set_login_item_settings(&self, _open: bool, _args: Option<&[&str]>) -> io::Result<()> {
        panic!("not on Linux")
    }
}

#[test]
fn on_linux_turning_it_on_writes_the_appimages_entry_once_and_turning_it_off_removes_it() {
    let dir = tempfile::Builder::new()
        .prefix("relay-login-")
        .tempdir()
        .unwrap();
    let home = dir.path().to_path_buf();
    let env = env(&[("APPIMAGE", "/home/alto/Relay.AppImage")]);
    let host = LoginItemHost {
        platform: Platform::Linux,
        env: &env,
        home: home.clone(),
        exec_path: PathBuf::from("/tmp/.mount_Relay/relay"),
        settings: &NotOnLinux,
    };
    let file = autostart_file(&env, &home);
    assert!(!launch_at_login_enabled(&host));
    set_launch_at_login(true, &host).unwrap();
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        autostart_entry("/home/alto/Relay.AppImage")
    );
    assert!(launch_at_login_enabled(&host));
    // An entry for another path (Relay moved) is rewritten.
    fs::write(&file, autostart_entry("/old/Relay.AppImage")).unwrap();
    assert!(!launch_at_login_enabled(&host));
    set_launch_at_login(true, &host).unwrap();
    assert!(
        fs::read_to_string(&file)
            .unwrap()
            .lines()
            .any(|l| l == "Exec=/home/alto/Relay.AppImage --hidden")
    );
    set_launch_at_login(false, &host).unwrap();
    assert_eq!(
        fs::metadata(&file).unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    // Off when already off does nothing.
    set_launch_at_login(false, &host).unwrap();
    // The bare system item on Linux is never asked either.
    let _ = NoLoginItem;
}

/// One recorded call: `get` or `set`, the value set, the arguments.
type Call = (String, Option<bool>, Option<Vec<String>>);

/// Electron's get/setLoginItemSettings, recorded.
#[derive(Default)]
struct Recorded {
    open: Mutex<bool>,
    calls: Mutex<Vec<Call>>,
}

fn args(args: Option<&[&str]>) -> Option<Vec<String>> {
    args.map(|a| a.iter().map(|s| (*s).to_owned()).collect())
}

impl LoginItemSettings for Recorded {
    fn get_login_item_settings(&self, a: Option<&[&str]>) -> bool {
        self.calls
            .lock()
            .unwrap()
            .push(("get".into(), None, args(a)));
        *self.open.lock().unwrap()
    }
    fn set_login_item_settings(&self, open: bool, a: Option<&[&str]>) -> io::Result<()> {
        self.calls
            .lock()
            .unwrap()
            .push(("set".into(), Some(open), args(a)));
        *self.open.lock().unwrap() = open;
        Ok(())
    }
}

#[test]
fn on_macos_and_windows_the_login_item_is_set_only_when_it_differs_with_the_flag_on_windows() {
    for platform in [Platform::MacOs, Platform::Windows] {
        let recorded = Recorded::default();
        let env = BTreeMap::new();
        let host = LoginItemHost {
            platform,
            env: &env,
            home: PathBuf::from("/home/alto"),
            exec_path: PathBuf::from("/Applications/Relay.app/Contents/MacOS/Relay"),
            settings: &recorded,
        };
        set_launch_at_login(true, &host).unwrap();
        set_launch_at_login(true, &host).unwrap();
        set_launch_at_login(false, &host).unwrap();
        let flag = (platform == Platform::Windows).then(|| vec![LOGIN_LAUNCH_FLAG.to_owned()]);
        assert_eq!(
            *recorded.calls.lock().unwrap(),
            vec![
                ("get".to_owned(), None, flag.clone()),
                ("set".to_owned(), Some(true), flag.clone()),
                ("get".to_owned(), None, flag.clone()),
                ("get".to_owned(), None, flag.clone()),
                ("set".to_owned(), Some(false), flag.clone()),
            ],
            "{platform:?}"
        );
    }
    // The Windows Run value Electron writes: the quoted program, then the flag.
    assert_eq!(
        windows_run_command(
            Path::new(r"C:\Program Files\Relay\Relay.exe"),
            &[LOGIN_LAUNCH_FLAG]
        ),
        r#""C:\Program Files\Relay\Relay.exe" --hidden"#
    );
}
