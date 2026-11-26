//! Port of tests/desktop-instances.test.ts.

use relay_core::desktop_host_node::{AppAction, app_script, open_args};
#[cfg(not(windows))]
use relay_core::desktop_instances::{ClaudeWindowProcess, user_data_dir};
use relay_core::desktop_instances::{ProcessRow, mac_instances, process_rows};

const EXE: &str = "/Applications/Claude.app/Contents/MacOS/Claude";
#[cfg(not(windows))]
const HELPER: &str =
    "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper";
#[cfg(not(windows))]
const RENDERER: &str = "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)";
#[cfg(not(windows))]
const DISCLAIMER: &str = "/Applications/Claude.app/Contents/Helpers/disclaimer";
#[cfg(not(windows))]
const BROWSER_HOST: &str = "/Applications/Claude.app/Contents/Helpers/chrome-native-host";
#[cfg(not(windows))]
const DEFAULT_DIR: &str = "/Users/me/Library/Application Support/Claude";
const WINDOW_DIR: &str = "/Users/me/Library/Application Support/Relay/claude-windows/3c9e1f20-4b7a-4d1e-9f2a-6d5b8c0e7a14/data";

/// One `ps` census, as the two listings the host reads.
fn census(rows: &[(i64, i64, &str, String)]) -> Vec<ProcessRow> {
    let mut commands = vec!["     1      0 /sbin/launchd".to_string()];
    let mut args = vec!["     1 /sbin/launchd".to_string()];
    for (pid, ppid, exe, line) in rows {
        commands.push(format!("{pid:>6} {ppid:>6} {exe}"));
        args.push(format!("{pid:>6} {line}"));
    }
    process_rows(&commands.join("\n"), &args.join("\n"))
}

#[cfg(not(windows))]
fn window(dir: &str, pid: i64, pids: &[i64]) -> ClaudeWindowProcess {
    ClaudeWindowProcess {
        dir: dir.into(),
        pid,
        pids: pids.to_vec(),
    }
}

// macOS only: separate Claude windows.
#[cfg(not(windows))]
#[test]
fn the_data_folder_comes_from_the_switch_up_to_the_next_one_with_spaces_kept() {
    assert_eq!(user_data_dir(&format!("{EXE} --disable-quic")), None);
    assert_eq!(user_data_dir(EXE), None);
    assert_eq!(
        user_data_dir(&format!("{EXE} --user-data-dir={WINDOW_DIR}")).as_deref(),
        Some(WINDOW_DIR)
    );
    assert_eq!(
        user_data_dir(&format!(
            "{EXE} --user-data-dir={WINDOW_DIR} --disable-quic"
        ))
        .as_deref(),
        Some(WINDOW_DIR)
    );
    assert_eq!(
        user_data_dir(&format!(
            "{HELPER} --type=gpu-process --user-data-dir={DEFAULT_DIR} --gpu-preferences=x"
        ))
        .as_deref(),
        Some(DEFAULT_DIR)
    );
    assert_eq!(user_data_dir(&format!("{EXE} --user-data-dir=")), None);
}

#[cfg(not(windows))]
#[test]
fn a_window_and_its_helpers_are_apart_from_the_main_claude_whose_helpers_name_the_default_folder() {
    let rows = census(&[
        (100, 1, EXE, format!("{EXE} --disable-quic")),
        (
            101,
            100,
            HELPER,
            format!("{HELPER} --type=gpu-process --user-data-dir={DEFAULT_DIR}"),
        ),
        (
            102,
            100,
            RENDERER,
            format!("{RENDERER} --type=renderer --user-data-dir={DEFAULT_DIR}"),
        ),
        (
            103,
            100,
            DISCLAIMER,
            format!("{DISCLAIMER} --pgroup -- claude"),
        ),
        (200, 1, EXE, format!("{EXE} --user-data-dir={WINDOW_DIR}")),
        (
            201,
            200,
            HELPER,
            format!("{HELPER} --type=gpu-process --user-data-dir={WINDOW_DIR}"),
        ),
        (
            202,
            200,
            RENDERER,
            format!("{RENDERER} --type=renderer --user-data-dir={WINDOW_DIR}"),
        ),
        (300, 1, BROWSER_HOST, BROWSER_HOST.into()),
        (400, 1, "/usr/bin/grep", format!("/usr/bin/grep {EXE}")),
    ]);
    let claude = mac_instances(&rows, EXE);
    let mut main = claude.main.clone();
    main.sort();
    assert_eq!(main, vec![100, 101, 102, 103]);
    assert_eq!(claude.main_pid, Some(100));
    assert_eq!(
        claude.windows,
        vec![window(WINDOW_DIR, 200, &[200, 201, 202])]
    );
}

#[cfg(not(windows))]
#[test]
fn a_helper_left_without_its_app_goes_by_its_own_switch_else_to_the_main_claude() {
    let rows = census(&[
        (200, 1, EXE, format!("{EXE} --user-data-dir={WINDOW_DIR}")),
        (
            205,
            1,
            HELPER,
            format!("{HELPER} --type=utility --user-data-dir={WINDOW_DIR}"),
        ),
        (
            206,
            1,
            DISCLAIMER,
            format!("{DISCLAIMER} --pgroup -- claude"),
        ),
    ]);
    let claude = mac_instances(&rows, EXE);
    assert_eq!(claude.main, vec![206]);
    assert_eq!(claude.main_pid, None);
    assert_eq!(claude.windows, vec![window(WINDOW_DIR, 200, &[200, 205])]);
}

#[test]
fn only_the_window_running_nothing_is_the_main_claude() {
    let claude = mac_instances(
        &census(&[(200, 1, EXE, format!("{EXE} --user-data-dir={WINDOW_DIR}"))]),
        EXE,
    );
    assert_eq!(claude.main, Vec::<i64>::new());
    assert_eq!(claude.main_pid, None);
    assert_eq!(claude.windows.len(), 1);
}

#[test]
fn two_main_claudes_both_counted_neither_is_the_main_pid() {
    let claude = mac_instances(
        &census(&[
            (100, 1, EXE, EXE.into()),
            (110, 1, EXE, format!("{EXE} --disable-quic")),
        ]),
        EXE,
    );
    assert_eq!(claude.main, vec![100, 110]);
    assert_eq!(claude.main_pid, None);
    // A quit with a window open asks each of them by pid.
    assert_eq!(claude.main_apps, vec![100, 110]);
}

#[test]
fn an_app_is_asked_by_pid_which_must_be_a_real_one() {
    let terminate = app_script(AppAction::Terminate, 4242).unwrap();
    assert!(terminate.contains("runningApplicationWithProcessIdentifier(4242)"));
    assert!(terminate.contains("app.terminate"));
    assert!(
        app_script(AppAction::Activate, 4242)
            .unwrap()
            .contains("activateWithOptions")
    );
    // 1.5 and NaN are not representable as a pid here: the type refuses them.
    for pid in [0, 1, -5] {
        assert!(app_script(AppAction::Terminate, pid).is_err());
    }
}

#[test]
fn a_window_starts_as_a_new_app_on_its_folder_the_main_claude_as_before() {
    assert_eq!(
        open_args("/Applications/Claude.app", &[], false),
        vec!["-a", "/Applications/Claude.app"]
    );
    assert_eq!(
        open_args("/Applications/Claude.app", &["--disable-quic".into()], true),
        vec![
            "-n",
            "-a",
            "/Applications/Claude.app",
            "--args",
            "--disable-quic"
        ]
    );
    let switch = format!("--user-data-dir={WINDOW_DIR}");
    assert_eq!(
        open_args(
            "/Applications/Claude.app",
            std::slice::from_ref(&switch),
            true
        )
        .last()
        .unwrap(),
        &switch
    );
}
