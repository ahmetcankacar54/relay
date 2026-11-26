//! Port of `electron/core/login-item.ts`: starting Relay at login. macOS registers the app with
//! `SMAppService.mainApp`, Windows writes the HKCU `Run` value, Linux an XDG autostart entry.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::relay_paths::Platform;

/// The argument a login launch carries on Windows and Linux: Relay then starts in the tray with
/// no window. macOS cannot pass arguments to a login item; there the system says it opened Relay
/// (the launch Apple event's `keyAELaunchedAsLogInItem`, read by the app shell).
pub const LOGIN_LAUNCH_FLAG: &str = "--hidden";

/// The value under HKCU `Software\Microsoft\Windows\CurrentVersion\Run` that starts Relay.
pub const WINDOWS_RUN_VALUE: &str = "Relay";

/// The system's login item on macOS and Windows, as Electron's `get`/`setLoginItemSettings`
/// saw it: `args` is the launch flag on Windows and None on macOS.
pub trait LoginItemSettings: Send + Sync {
    fn get_login_item_settings(&self, args: Option<&[&str]>) -> bool;
    fn set_login_item_settings(&self, open_at_login: bool, args: Option<&[&str]>)
    -> io::Result<()>;
}

/// What the login item needs from the app: the platform, the environment, the home folder, the
/// program a login starts and the system's login item.
pub struct LoginItemHost<'a> {
    pub platform: Platform,
    pub env: &'a BTreeMap<String, String>,
    pub home: PathBuf,
    /// The program a login starts: the AppImage on Linux when Relay runs from one.
    pub exec_path: PathBuf,
    pub settings: &'a dyn LoginItemSettings,
}

/// `$XDG_CONFIG_HOME/autostart/relay.desktop`, or `~/.config/autostart/relay.desktop` when the
/// variable is unset or not absolute, as the XDG base directory spec says. `has_root` is Node's
/// `path.isAbsolute`: on Windows a leading separator counts too.
pub fn autostart_file(env: &BTreeMap<String, String>, home: &Path) -> PathBuf {
    let config = match env.get("XDG_CONFIG_HOME") {
        Some(configured) if !configured.is_empty() && Path::new(configured).has_root() => {
            PathBuf::from(configured)
        }
        _ => home.join(".config"),
    };
    config.join("autostart").join("relay.desktop")
}

/// Characters that make an Exec argument need quotes (Desktop Entry spec, "The Exec key").
fn reserved(c: char) -> bool {
    c.is_whitespace() || "\"'\\><~|&;$*?#()`".contains(c)
}

/// One Exec argument. A quoted argument escapes `"`, `` ` ``, `$` and `\` with a backslash, and
/// the string escape doubles each backslash again; `%` is doubled so no path reads as a field
/// code.
pub fn exec_argument(arg: &str) -> String {
    let literal = arg.replace('%', "%%");
    if !literal.chars().any(reserved) {
        return literal;
    }
    let mut escaped = String::with_capacity(literal.len() + 2);
    for c in literal.chars() {
        if matches!(c, '"' | '`' | '$' | '\\') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    format!("\"{}\"", escaped.replace('\\', "\\\\"))
}

/// The autostart entry that starts `exec` hidden at login.
pub fn autostart_entry(exec: &str) -> String {
    [
        "[Desktop Entry]",
        "Type=Application",
        "Version=1.0",
        "Name=Relay",
        &format!("Exec={} {LOGIN_LAUNCH_FLAG}", exec_argument(exec)),
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ]
    .join("\n")
}

/// The program a Linux login starts: the AppImage itself, never its temporary mount.
pub fn linux_exec(env: &BTreeMap<String, String>, exec_path: &Path) -> String {
    match env.get("APPIMAGE") {
        Some(image) if !image.is_empty() => image.clone(),
        _ => exec_path.to_string_lossy().into_owned(),
    }
}

/// Whether this run is a login launch, which stays in the tray. Windows and Linux pass the
/// flag; macOS reports it through `was_opened_at_login`.
pub fn launched_at_login<S: AsRef<str>>(
    argv: &[S],
    platform: Platform,
    was_opened_at_login: bool,
) -> bool {
    match platform {
        Platform::MacOs => was_opened_at_login,
        _ => argv.iter().any(|a| a.as_ref() == LOGIN_LAUNCH_FLAG),
    }
}

const FLAG_ARGS: &[&str] = &[LOGIN_LAUNCH_FLAG];

/// Whether the system starts Relay at login now.
pub fn launch_at_login_enabled(host: &LoginItemHost) -> bool {
    match host.platform {
        Platform::Linux => fs::read_to_string(autostart_file(host.env, &host.home))
            .is_ok_and(|text| text == autostart_entry(&linux_exec(host.env, &host.exec_path))),
        Platform::Windows => host.settings.get_login_item_settings(Some(FLAG_ARGS)),
        Platform::MacOs => host.settings.get_login_item_settings(None),
    }
}

/// Makes the system start Relay at login, or stop doing so. Does nothing when the system
/// already matches, so a start never re-registers a macOS login item or rewrites a file the
/// user left alone.
pub fn set_launch_at_login(enabled: bool, host: &LoginItemHost) -> io::Result<()> {
    if enabled == launch_at_login_enabled(host) {
        return Ok(());
    }
    match host.platform {
        Platform::Linux => {
            let file = autostart_file(host.env, &host.home);
            if !enabled {
                return match fs::remove_file(&file) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                    _ => Ok(()),
                };
            }
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir)?;
            }
            write_mode(
                &file,
                autostart_entry(&linux_exec(host.env, &host.exec_path)).as_bytes(),
            )
        }
        Platform::Windows => host
            .settings
            .set_login_item_settings(enabled, Some(FLAG_ARGS)),
        Platform::MacOs => host.settings.set_login_item_settings(enabled, None),
    }
}

/// `fs.writeFile(file, data, { mode: 0o644 })`: the mode applies to a new file only.
fn write_mode(file: &Path, data: &[u8]) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o644);
    }
    io::Write::write_all(&mut options.open(file)?, data)
}

/// The quoted command line the Windows `Run` value holds: `"<exe>" --hidden`.
pub fn windows_run_command(exe: &Path, args: &[&str]) -> String {
    let mut command = format!("\"{}\"", exe.display());
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    command
}

/// The system login item of this platform: `SMAppService.mainApp` on macOS, the HKCU `Run`
/// value on Windows. None on Linux, whose autostart entry is a file.
pub fn system_login_item(exe: &Path) -> Option<Box<dyn LoginItemSettings>> {
    #[cfg(target_os = "macos")]
    {
        let _ = exe;
        Some(Box::new(mac::MainAppService))
    }
    #[cfg(windows)]
    {
        Some(Box::new(windows_run::RunKey {
            exe: exe.to_path_buf(),
        }))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = exe;
        None
    }
}

/// A login item that is never on and cannot be set: Linux's entry is a file, so its host never
/// asks.
pub struct NoLoginItem;

impl LoginItemSettings for NoLoginItem {
    fn get_login_item_settings(&self, _args: Option<&[&str]>) -> bool {
        false
    }
    fn set_login_item_settings(&self, _open: bool, _args: Option<&[&str]>) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::io;

    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    /// The running app as its own login item (macOS 13+). "Requires approval" counts as on, as
    /// Electron's `openAtLogin` does: the user approves it in System Settings.
    pub struct MainAppService;

    impl super::LoginItemSettings for MainAppService {
        fn get_login_item_settings(&self, _args: Option<&[&str]>) -> bool {
            // SAFETY: mainAppService and status take no arguments and are thread-safe.
            let status = unsafe { SMAppService::mainAppService().status() };
            status == SMAppServiceStatus::Enabled || status == SMAppServiceStatus::RequiresApproval
        }

        fn set_login_item_settings(&self, open: bool, _args: Option<&[&str]>) -> io::Result<()> {
            // SAFETY: as above; the error is an owned NSError.
            let result = unsafe {
                let service = SMAppService::mainAppService();
                if open {
                    service.registerAndReturnError()
                } else {
                    service.unregisterAndReturnError()
                }
            };
            result.map_err(|error| io::Error::other(error.localizedDescription().to_string()))
        }
    }
}

#[cfg(windows)]
mod windows_run {
    use std::io;
    use std::path::PathBuf;

    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_SZ, RRF_RT_REG_SZ,
        RegCloseKey, RegDeleteKeyValueW, RegGetValueW, RegOpenKeyExW, RegSetValueExW,
    };
    use windows::core::{HSTRING, PCWSTR};

    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    /// HKCU `Run\Relay` = `"<exe>" --hidden`, as Electron's `setLoginItemSettings` writes it.
    pub struct RunKey {
        pub exe: PathBuf,
    }

    fn check(code: WIN32_ERROR) -> io::Result<()> {
        if code == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(code.0 as i32))
        }
    }

    impl RunKey {
        fn command(&self, args: Option<&[&str]>) -> String {
            super::windows_run_command(&self.exe, args.unwrap_or_default())
        }

        fn value(&self) -> Option<String> {
            let key = HSTRING::from(RUN_KEY);
            let name = HSTRING::from(super::WINDOWS_RUN_VALUE);
            let mut size = 0u32;
            // SAFETY: a size query with no buffer.
            let code = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    None,
                    Some(&raw mut size),
                )
            };
            if code != ERROR_SUCCESS || size == 0 {
                return None;
            }
            let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
            // SAFETY: `buffer` holds `size` bytes.
            let code = unsafe {
                RegGetValueW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(name.as_ptr()),
                    RRF_RT_REG_SZ,
                    None,
                    Some(buffer.as_mut_ptr().cast()),
                    Some(&raw mut size),
                )
            };
            if code != ERROR_SUCCESS {
                return None;
            }
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..len]))
        }
    }

    impl super::LoginItemSettings for RunKey {
        fn get_login_item_settings(&self, args: Option<&[&str]>) -> bool {
            // Electron compares the saved command with this exe and these arguments.
            self.value()
                .is_some_and(|value| value.eq_ignore_ascii_case(&self.command(args)))
        }

        fn set_login_item_settings(&self, open: bool, args: Option<&[&str]>) -> io::Result<()> {
            let key = HSTRING::from(RUN_KEY);
            let name = HSTRING::from(super::WINDOWS_RUN_VALUE);
            if !open {
                // SAFETY: plain strings; a missing value is already off.
                let code = unsafe {
                    RegDeleteKeyValueW(
                        HKEY_CURRENT_USER,
                        PCWSTR(key.as_ptr()),
                        PCWSTR(name.as_ptr()),
                    )
                };
                return if code == ERROR_FILE_NOT_FOUND {
                    Ok(())
                } else {
                    check(code)
                };
            }
            let mut handle = HKEY::default();
            // SAFETY: the Run key always exists under HKCU; the handle is closed below.
            check(unsafe {
                RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(key.as_ptr()),
                    None,
                    KEY_SET_VALUE | KEY_QUERY_VALUE,
                    &mut handle,
                )
            })?;
            let data: Vec<u16> = self
                .command(args)
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: `data` is a NUL-terminated UTF-16 string, passed as bytes.
            let code = unsafe {
                let bytes = std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2);
                RegSetValueExW(handle, PCWSTR(name.as_ptr()), None, REG_SZ, Some(bytes))
            };
            // SAFETY: the handle opened above.
            let _ = unsafe { RegCloseKey(handle) };
            check(code)
        }
    }
}
