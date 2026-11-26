//! Port of tests/desktop-processes.test.ts.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use relay_core::desktop_processes::{
    ClaudeListing, ClaudeLiveness, LivenessDeps, ProcessError, assert_process_listing,
    mac_desktop_pids, mac_main_pid, parse_etime, pid_alive, retry_once,
};

#[test]
fn desktop_shutdown_ignores_the_independent_chrome_host_but_waits_for_app_workers() {
    let executable = "/Applications/Claude.app/Contents/MacOS/Claude";
    let browser_host = "64817 /Applications/Claude.app/Contents/Helpers/chrome-native-host";
    assert_eq!(
        mac_desktop_pids(browser_host, executable),
        Vec::<i64>::new()
    );
    let listing = [
        format!("100 {executable}"),
        browser_host.to_string(),
        "101 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper".into(),
        "102 /Applications/Claude.app/Contents/Resources/claude-code/claude".into(),
        "103 /Users/test/.local/bin/claude".into(),
        "104 /Applications/Claude.app.backup/Contents/MacOS/Claude".into(),
        "invalid line".into(),
    ]
    .join("\n");
    assert_eq!(mac_desktop_pids(&listing, executable), vec![100, 101, 102]);
    let home = "/Users/test/Applications/Claude.app/Contents/MacOS/Claude";
    assert_eq!(
        mac_desktop_pids(
            &format!(
                "105 {home}\n106 /Users/test/Applications/Claude.app/Contents/Helpers/chrome-native-host"
            ),
            home
        ),
        vec![105]
    );
}

#[test]
fn an_empty_or_unreadable_process_list_is_an_error_never_claude_is_not_running() {
    for bad in ["", "\n  \n", "garbage without pids"] {
        let error = assert_process_listing(bad).unwrap_err();
        assert!(error.to_string().contains("process list"));
    }
    assert!(assert_process_listing("    1 /sbin/launchd\n  100 /usr/libexec/logd\n").is_ok());
}

#[test]
fn a_failed_process_lookup_is_retried_once_then_reported() {
    let waits = RefCell::new(Vec::new());
    let sleep = |ms: u64| waits.borrow_mut().push(ms);
    let calls = Cell::new(0);
    let flaky = || {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            Err("Command failed: /bin/ps -axo pid=,comm=".to_string())
        } else {
            Ok(7)
        }
    };
    assert_eq!(retry_once(flaky, 250, &sleep), Ok(7));
    assert_eq!(calls.get(), 2);
    assert_eq!(*waits.borrow(), vec![250]);
    calls.set(0);
    let broken = || -> Result<i32, String> {
        calls.set(calls.get() + 1);
        Err(format!("attempt {}", calls.get()))
    };
    assert_eq!(retry_once(broken, 250, &sleep), Err("attempt 2".into()));
    assert_eq!(calls.get(), 2);
    calls.set(0);
    let ok = || -> Result<i32, String> {
        calls.set(calls.get() + 1);
        Ok(calls.get())
    };
    assert_eq!(retry_once(ok, 250, &sleep), Ok(1));
    assert_eq!(calls.get(), 1);
}

#[test]
fn claudes_main_pid_is_the_one_running_the_apps_executable_itself() {
    let executable = "/Applications/Claude.app/Contents/MacOS/Claude";
    let listing = [
        "    1 /sbin/launchd".to_string(),
        format!("  100 {executable}"),
        "  101 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper".into(),
        "  102 /Applications/Claude.app/Contents/Resources/claude-code/claude".into(),
        "  104 /Applications/Claude.app.backup/Contents/MacOS/Claude".into(),
    ]
    .join("\n");
    assert_eq!(mac_main_pid(&listing, executable), Some(100));
    let helpers_only = listing.replace(&format!("100 {executable}"), "100 /bin/zsh");
    assert_eq!(mac_main_pid(&helpers_only, executable), None);
    let two_mains = format!("{listing}\n  105 {executable}");
    assert_eq!(mac_main_pid(&two_mains, executable), None);
}

#[test]
fn ps_elapsed_time_dd_hh_mm_ss_is_read_as_milliseconds() {
    assert_eq!(parse_etime("01:02"), Some(62_000));
    assert_eq!(parse_etime("   00:15\n"), Some(15_000));
    assert_eq!(
        parse_etime("02:03:04"),
        Some((2 * 3600 + 3 * 60 + 4) * 1000)
    );
    assert_eq!(
        parse_etime("1-02:03:04"),
        Some(((24 + 2) * 3600 + 3 * 60 + 4) * 1000)
    );
    assert_eq!(parse_etime("12-00:00:00"), Some(12 * 86_400_000));
    for bad in [
        "",
        "15",
        "1:2",
        "01:60",
        "60:00",
        "24:00:00",
        "1-03:04",
        "-01:02",
        "01:02:03:04",
        "aa:bb",
    ] {
        assert_eq!(parse_etime(bad), None, "{bad}");
    }
}

#[derive(Default)]
struct State {
    clock: i64,
    listings: u32,
    pids: Vec<i64>,
    main: Option<i64>,
    alive: HashSet<i64>,
    fail: bool,
}

fn liveness() -> (Arc<Mutex<State>>, ClaudeLiveness) {
    let state = Arc::new(Mutex::new(State::default()));
    let (a, b, c) = (state.clone(), state.clone(), state.clone());
    let probe = ClaudeLiveness::new(LivenessDeps {
        list: Box::new(move || {
            let mut s = a.lock().unwrap();
            s.listings += 1;
            // An empty or cut-short listing throws, as macListing does.
            if s.fail {
                assert_process_listing("")?;
            }
            Ok::<_, ProcessError>(ClaudeListing {
                pids: s.pids.clone(),
                main: s.main,
            })
        }),
        alive: Box::new(move |pid| b.lock().unwrap().alive.contains(&pid)),
        now: Box::new(move || c.lock().unwrap().clock),
    });
    (state, probe)
}

#[test]
fn a_known_claude_pid_that_is_alive_answers_without_listing_every_process_for_a_minute() {
    let (state, probe) = liveness();
    {
        let mut s = state.lock().unwrap();
        s.pids = vec![300, 301, 302];
        s.main = Some(301);
        s.alive = [300, 301, 302].into();
    }
    assert_eq!(probe.seems_running(), Ok(true));
    assert_eq!(state.lock().unwrap().listings, 1);
    state.lock().unwrap().clock += 30_000;
    assert_eq!(probe.seems_running(), Ok(true));
    assert_eq!(state.lock().unwrap().listings, 1);
    state.lock().unwrap().clock += 30_000;
    assert_eq!(probe.seems_running(), Ok(true));
    assert_eq!(state.lock().unwrap().listings, 2);
}

#[test]
fn a_dead_pid_no_known_pid_or_a_fresh_read_lists_every_process() {
    let (state, probe) = liveness();
    {
        let mut s = state.lock().unwrap();
        s.pids = vec![300, 301];
        s.main = Some(301);
        s.alive = [300, 301].into();
    }
    assert_eq!(probe.seems_running(), Ok(true));
    {
        let mut s = state.lock().unwrap();
        s.alive.remove(&301);
        s.pids = vec![];
    }
    assert_eq!(probe.seems_running(), Ok(false));
    assert_eq!(state.lock().unwrap().listings, 2);
    assert_eq!(probe.seems_running(), Ok(false));
    assert_eq!(state.lock().unwrap().listings, 3);
    {
        let mut s = state.lock().unwrap();
        s.pids = vec![400, 401];
        s.main = None;
        s.alive = [400].into();
    }
    assert_eq!(probe.seems_running(), Ok(true));
    assert_eq!(probe.seems_running(), Ok(true));
    assert_eq!(state.lock().unwrap().listings, 4);
    assert_eq!(probe.running(), Ok(true));
    assert_eq!(probe.pids(), Ok(vec![400, 401]));
    assert_eq!(state.lock().unwrap().listings, 6);
}

#[test]
fn an_empty_listing_still_throws_through_the_pid_shortcut_never_claude_is_closed() {
    let (state, probe) = liveness();
    state.lock().unwrap().fail = true;
    assert!(
        probe
            .seems_running()
            .unwrap_err()
            .to_string()
            .contains("process list")
    );
    assert!(
        probe
            .running()
            .unwrap_err()
            .to_string()
            .contains("process list")
    );
    {
        let mut s = state.lock().unwrap();
        s.fail = false;
        s.pids = vec![300];
        s.alive = [300].into();
    }
    assert_eq!(probe.seems_running(), Ok(true));
    {
        let mut s = state.lock().unwrap();
        s.alive.clear();
        s.fail = true;
    }
    assert!(
        probe
            .seems_running()
            .unwrap_err()
            .to_string()
            .contains("process list")
    );
}

#[test]
fn a_pid_is_alive_while_its_process_exists() {
    assert!(pid_alive(i64::from(std::process::id())));
    assert!(!pid_alive(1 << 30));
}
