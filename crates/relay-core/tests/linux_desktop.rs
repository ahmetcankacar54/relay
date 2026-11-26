//! Port of tests/linux-desktop.test.ts. "Claude Desktop is never taken for the Claude Code CLI"
//! (`isClaudeDesktopExecutable`, environment.rs) belongs to the Usage slice's tests.

use std::collections::{BTreeMap, HashMap};
#[cfg(not(windows))]
use std::path::Path;

use relay_core::desktop_host_node::{VersionFiles, linux_electron_version, linux_launch_env};
use relay_core::desktop_instances::{
    ClaudeInstances, ProcessRow, linux_claude_command, linux_instances, linux_process_rows,
};
#[cfg(not(windows))]
use relay_core::desktop_launch::claude_log;
#[cfg(not(windows))]
use relay_core::relay_paths::Platform;

const EXE: &str = "/usr/bin/claude-desktop";
const LIB: &str = "/usr/lib/claude-desktop/claude-desktop";
#[cfg(not(windows))]
const WINDOW_DIR: &str =
    "/home/me/.config/Relay/claude-windows/3c9e1f20-4b7a-4d1e-9f2a-6d5b8c0e7a14/data";

/// A `ps -eo pid=,ppid=,args=` listing as Linux prints it.
fn listing(rows: &[(i64, i64, String)]) -> String {
    let mut lines = vec!["      1       0 /sbin/init".to_string()];
    lines.extend(
        rows.iter()
            .map(|(pid, ppid, args)| format!("{pid:>7} {ppid:>7} {args}")),
    );
    lines.join("\n")
}

fn row(pid: i64, ppid: i64, args: &str) -> (i64, i64, String) {
    (pid, ppid, args.to_string())
}

#[cfg(not(windows))]
fn sorted(mut list: Vec<i64>) -> Vec<i64> {
    list.sort();
    list
}

#[test]
fn linux_ps_rows_pid_parent_the_command_as_executable_kernel_threads_kept_as_they_are() {
    let rows = linux_process_rows(&format!(
        "{}\n      2       0 [kthreadd]\n\n  garbage",
        listing(&[row(4100, 1, &format!("{EXE} --enable-features=x"))])
    ));
    assert_eq!(
        rows[1],
        ProcessRow {
            pid: 4100,
            ppid: 1,
            executable: EXE.into(),
            args: format!("{EXE} --enable-features=x"),
        }
    );
    assert_eq!(
        rows[2],
        ProcessRow {
            pid: 2,
            ppid: 0,
            executable: "[kthreadd]".into(),
            args: "[kthreadd]".into(),
        }
    );
    assert_eq!(rows.len(), 3);
}

// Linux and macOS paths: the code resolves them with the host's path rules.
#[cfg(not(windows))]
#[test]
fn the_official_package_the_main_claude_its_helpers_and_a_window_are_told_apart_by_app_and_parent()
{
    let rows = linux_process_rows(&listing(&[
        row(4100, 1, EXE),
        row(
            4105,
            4100,
            &format!("{LIB} --type=zygote --no-zygote-sandbox"),
        ),
        row(
            4106,
            4100,
            &format!("/usr/lib/claude-desktop/chrome-sandbox {LIB} --type=zygote"),
        ),
        row(4107, 4106, &format!("{LIB} --type=zygote")),
        row(
            4110,
            4107,
            &format!(
                "{LIB} --type=renderer --user-data-dir=/home/me/.config/Claude --app-path=/usr/lib/claude-desktop/resources/app.asar"
            ),
        ),
        row(
            4108,
            1,
            "/usr/lib/claude-desktop/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/home/me/.config/Claude/Crashpad",
        ),
        row(
            4120,
            4100,
            &format!(
                "{LIB} --type=gpu-process --ozone-platform=wayland --user-data-dir=/home/me/.config/Claude"
            ),
        ),
        row(
            4121,
            4100,
            &format!("{LIB} --type=utility --utility-sub-type=network.mojom.NetworkService"),
        ),
        row(
            4130,
            4100,
            &format!("{LIB} /home/me/.config/Claude/Claude Extensions/x/server/index.js"),
        ),
        row(
            4140,
            4100,
            "/home/me/.config/Claude/claude-code/2.1.321/ded331c1fbf8/claude --output-format stream-json",
        ),
        row(
            4150,
            4100,
            "/usr/lib/claude-desktop/resources/virtiofsd --socket-path=/run/user/1000/x.sock",
        ),
        row(
            4160,
            1,
            "/usr/lib/claude-desktop/resources/chrome-native-host chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/",
        ),
        row(
            5200,
            600,
            &format!("{EXE} --user-data-dir={WINDOW_DIR} --disable-quic"),
        ),
        row(
            5205,
            5200,
            &format!("{LIB} --type=zygote --no-zygote-sandbox"),
        ),
        row(
            5210,
            5205,
            &format!("{LIB} --type=renderer --user-data-dir={WINDOW_DIR}"),
        ),
        row(
            5220,
            1,
            &format!("{LIB} --type=utility --user-data-dir={WINDOW_DIR}"),
        ),
        row(600, 1, "/opt/Relay/relay"),
        row(700, 650, "/home/me/.local/bin/claude --resume"),
        row(710, 650, "grep claude-desktop"),
        row(
            720,
            650,
            "/usr/bin/vim /usr/lib/claude-desktop/resources/notes.txt",
        ),
    ]));
    let claude = linux_instances(&rows, EXE, 600);
    assert_eq!(
        sorted(claude.main.clone()),
        vec![4100, 4105, 4106, 4107, 4110, 4120, 4121, 4130, 4150]
    );
    assert_eq!(claude.main_apps, vec![4100]);
    assert_eq!(claude.main_pid, Some(4100));
    assert_eq!(claude.windows.len(), 1);
    assert_eq!(claude.windows[0].dir, WINDOW_DIR);
    assert_eq!(claude.windows[0].pid, 5200);
    assert_eq!(
        sorted(claude.windows[0].pids.clone()),
        vec![5200, 5205, 5210, 5220]
    );
}

#[test]
fn a_claude_started_from_the_desktop_entry_by_bare_name_or_through_the_library_path_is_the_main_one()
 {
    for command in ["claude-desktop", LIB] {
        let claude = linux_instances(
            &linux_process_rows(&listing(&[
                row(300, 1, &format!("{command} claude://code/new")),
                row(301, 300, &format!("{LIB} --type=zygote")),
            ])),
            EXE,
            1,
        );
        assert_eq!(
            (claude.main_pid, claude.main),
            (Some(300), vec![300, 301]),
            "{command}"
        );
    }
    assert_eq!(
        linux_instances(&linux_process_rows(&listing(&[row(300, 1, EXE)])), LIB, 1).main_pid,
        Some(300)
    );
    let leftover = linux_instances(
        &linux_process_rows(&listing(&[row(
            4160,
            1,
            "/usr/lib/claude-desktop/resources/chrome-native-host x",
        )])),
        EXE,
        1,
    );
    assert_eq!(leftover, ClaudeInstances::default());
}

#[test]
fn linux_finds_claudes_processes_through_its_launcher_install_folder_or_appimage_never_the_code_cli()
 {
    assert!(linux_claude_command(
        "/bin/bash /usr/bin/claude-desktop",
        EXE
    ));
    assert!(linux_claude_command(
        "/usr/lib/claude-desktop/node_modules/electron/dist/electron /usr/lib/claude-desktop/app.asar",
        EXE
    ));
    assert!(linux_claude_command(
        "/tmp/.mount_ClaudeAbc/claude --type=renderer",
        EXE
    ));
    assert!(!linux_claude_command(
        "/home/me/.local/bin/claude --resume",
        EXE
    ));
    assert!(!linux_claude_command(
        "node /home/me/.local/bin/claude",
        EXE
    ));
    assert!(linux_claude_command(
        "/usr/bin/Claude-Desktop --x",
        "/opt/x/Claude-Desktop"
    ));
    assert!(!linux_claude_command(
        "/usr/local/bin/claude",
        "/opt/odd/claude"
    ));
    assert!(!linux_claude_command(
        "/usr/bin/vim /usr/lib/claude-desktop/resources/notes.txt",
        EXE
    ));
    assert!(!linux_claude_command(
        "grep -r token /opt/claude-desktop/",
        EXE
    ));
    assert!(!linux_claude_command(
        "tail -f /usr/lib/claude-desktop/app.log",
        EXE
    ));
}

#[test]
fn a_launcher_script_started_claude_the_script_is_the_app_electron_under_it_is_its_helper() {
    let claude = linux_instances(
        &linux_process_rows(&listing(&[
            row(800, 1, &format!("/bin/bash {EXE}")),
            row(
                801,
                800,
                "/usr/lib/claude-desktop/node_modules/electron/dist/electron /usr/lib/claude-desktop/app.asar",
            ),
        ])),
        EXE,
        1,
    );
    assert_eq!((claude.main_apps, claude.main), (vec![800], vec![800, 801]));
}

#[test]
fn claude_starts_with_the_sessions_environment_without_relays_or_a_claude_code_sessions() {
    let source: BTreeMap<String, String> = [
        ("HOME", "/home/me"),
        ("PATH", "/usr/bin"),
        ("DISPLAY", ":0"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
        ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ("XDG_CURRENT_DESKTOP", "Unity"),
        ("ORIGINAL_XDG_CURRENT_DESKTOP", "KDE"),
        ("LANG", "tr_TR.UTF-8"),
        ("CLAUDECODE", "1"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("CLAUDE_CONFIG_DIR", "/x"),
        ("ANTHROPIC_API_KEY", "k"),
        ("ELECTRON_RUN_AS_NODE", "1"),
        ("RELAY_HOME", "/r"),
        ("NODE_OPTIONS", "--inspect"),
        ("CHROME_DESKTOP", "relay.desktop"),
        ("APPIMAGE", "/a/Relay.AppImage"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    let expected: BTreeMap<String, String> = [
        ("HOME", "/home/me"),
        ("PATH", "/usr/bin"),
        ("DISPLAY", ":0"),
        ("WAYLAND_DISPLAY", "wayland-0"),
        ("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus"),
        ("XDG_RUNTIME_DIR", "/run/user/1000"),
        ("XDG_CURRENT_DESKTOP", "KDE"),
        ("LANG", "tr_TR.UTF-8"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    assert_eq!(linux_launch_env(&source), expected);
}

struct Files {
    links: HashMap<String, String>,
    versions: HashMap<String, String>,
}

impl VersionFiles for Files {
    fn realpath(&self, path: &str) -> std::io::Result<String> {
        if path == "/gone" {
            return Err(std::io::Error::other("ENOENT"));
        }
        Ok(self
            .links
            .get(path)
            .cloned()
            .unwrap_or_else(|| path.to_string()))
    }
    fn read(&self, path: &str) -> std::io::Result<String> {
        self.versions
            .get(path)
            .cloned()
            .ok_or_else(|| std::io::Error::other("ENOENT"))
    }
}

fn files(links: &[(&str, &str)], versions: &[(&str, &str)]) -> Files {
    let map = |list: &[(&str, &str)]| {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    };
    Files {
        links: map(links),
        versions: map(versions),
    }
}

#[test]
fn the_electron_version_of_a_linux_claude_comes_from_the_version_file_beside_the_real_executable() {
    assert_eq!(
        linux_electron_version(
            EXE,
            &files(
                &[(EXE, LIB)],
                &[("/usr/lib/claude-desktop/version", "45.2.1\n")]
            )
        )
        .as_deref(),
        Some("45.2.1")
    );
    assert_eq!(
        linux_electron_version(
            "/opt/Claude/claude",
            &files(&[], &[("/opt/Claude/version", "44.0.0-beta.3")])
        )
        .as_deref(),
        Some("44.0.0-beta.3")
    );
    assert_eq!(
        linux_electron_version(
            "/gone",
            &files(&[], &[("/usr/lib/claude-desktop/version", "45.2.1")])
        )
        .as_deref(),
        Some("45.2.1")
    );
    assert_eq!(
        linux_electron_version(EXE, &files(&[], &[("/usr/bin/version", "hello")])),
        None
    );
}

#[cfg(not(windows))]
#[test]
fn claudes_log_library_logs_on_macos_the_data_folders_logs_on_linux_unknown_on_windows() {
    let none = |_: &str| None;
    let mac = claude_log(Path::new("/Users/me"), Platform::MacOs, &none).unwrap();
    assert_eq!(
        mac.current,
        Path::new("/Users/me/Library/Logs/Claude/main.log")
    );
    assert_eq!(
        mac.rotated,
        Path::new("/Users/me/Library/Logs/Claude/main1.log")
    );
    let linux = claude_log(Path::new("/home/me"), Platform::Linux, &none).unwrap();
    assert_eq!(
        linux.current,
        Path::new("/home/me/.config/Claude/logs/main.log")
    );
    assert_eq!(
        linux.rotated,
        Path::new("/home/me/.config/Claude/logs/main1.log")
    );
    let xdg = |key: &str| (key == "XDG_CONFIG_HOME").then(|| "/xdg".into());
    assert_eq!(
        claude_log(Path::new("/home/me"), Platform::Linux, &xdg)
            .unwrap()
            .current,
        Path::new("/xdg/Claude/logs/main.log")
    );
    let relative = |key: &str| (key == "XDG_CONFIG_HOME").then(|| "rel".into());
    assert_eq!(
        claude_log(Path::new("/home/me"), Platform::Linux, &relative)
            .unwrap()
            .current,
        Path::new("/home/me/.config/Claude/logs/main.log")
    );
    assert!(claude_log(Path::new("C:\\Users\\me"), Platform::Windows, &none).is_none());
}
