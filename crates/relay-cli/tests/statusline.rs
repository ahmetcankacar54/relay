//! Port of the CLI cases of `tests/statusline.test.ts` (`cli/src/statusline.ts` and
//! `relay statusline`). The renderer, snapshot and install cases are relay-core's
//! (`crates/relay-core/tests/statusline.rs`, `shared_statusline.rs`).

mod common;

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use common::{Options, cli_fixture};
use relay_cli::statusline::{StatuslineRun, read_statusline_snapshot, statusline_text};
use relay_core::claude_statusline::statusline_command;
use relay_core::relay_paths::Platform;
use relay_core::shared::statusline::STATUSLINE_FILE;
use serde_json::{Value, json};

const NOW: i64 = 1_795_435_200_000; // 2026-11-23T12:00:00Z

fn snapshot(vertex: &str, person: (&str, &str)) -> Value {
    let now = NOW as f64;
    json!({
        "version": 1,
        "generatedAt": now,
        "formatLocale": "en-GB",
        "profiles": "/data/Relay/profiles",
        "desktopAccountId": vertex,
        "terminalFollows": true,
        "accounts": [
            {
                "id": vertex,
                "name": "Vertex",
                "identities": [{ "accountUuid": person.0, "orgId": person.1 }],
                "fiveHour": { "used": 42, "resetsAt": now + 2.0 * 3_600_000.0, "resets": "renews 14:00" },
                "week": { "used": 18, "resetsAt": now + 3.0 * 86_400_000.0, "resets": "renews Thu 09:00" },
            },
            { "id": uuid(), "name": "Alto", "identities": [], "fiveHour": { "used": 7 }, "week": { "used": 61 } },
        ],
        "text": { "fiveHour": "5 h {percent}", "week": "week {percent}", "viaGateway": "via gateway", "updatedAgo": "updated {age}" },
    })
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn temp() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("relay-statusline-")
        .tempdir()
        .unwrap()
}

fn write_snapshot(dir: &Path, snap: &Value) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(STATUSLINE_FILE), snap.to_string()).unwrap();
}

fn read(home: &Path, env: &[(&str, &Path)], platform: Platform) -> bool {
    let env: Vec<(String, std::ffi::OsString)> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.as_os_str().to_owned()))
        .collect();
    read_statusline_snapshot(
        &|name| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()),
        home,
        platform,
    )
    .is_some()
}

#[test]
fn colors_only_when_asked_percentages_by_how_full_the_name_bold() {
    let dir = temp();
    let (vertex, person) = (uuid(), (uuid(), uuid()));
    let snap = snapshot(&vertex, (&person.0, &person.1));
    write_snapshot(dir.path(), &snap);
    let parsed = read_statusline_snapshot(
        &|name| (name == "RELAY_HOME").then(|| dir.path().into()),
        dir.path(),
        Platform::current(),
    )
    .unwrap();
    let run = |color| StatuslineRun {
        stdin: "",
        config_dir: Some(""),
        home: dir.path().to_path_buf(),
        now: NOW,
        color,
    };
    assert!(!statusline_text(&parsed, &run(false)).contains("\x1b["));
    assert!(statusline_text(&parsed, &run(true)).contains("\x1b[1mVertex\x1b[22m"));
}

#[test]
fn the_cli_reads_the_snapshot_and_claude_code_s_claude_json_and_answers_well_under_100_ms() {
    let dir = temp();
    let home = dir.path();
    let data = home.join("relay");
    let (vertex, person) = (uuid(), (uuid(), uuid()));
    write_snapshot(&data, &snapshot(&vertex, (&person.0, &person.1)));
    // A large .claude.json, as Claude Code's grows with its project history.
    let projects: serde_json::Map<String, Value> = (0..2000)
        .map(|i| {
            (
                format!("/work/p{i}"),
                json!({ "history": ["x".repeat(100)] }),
            )
        })
        .collect();
    let claude_json = json!({
        "projects": projects,
        "oauthAccount": { "accountUuid": person.0.to_uppercase(), "organizationUuid": person.1 },
    });
    fs::write(home.join(".claude.json"), claude_json.to_string()).unwrap();
    let stdin = json!({ "session_id": "s1", "model": { "id": "claude-x", "display_name": "X" }, "workspace": { "current_dir": home } })
        .to_string();
    let once = || {
        let snap = read(home, &[("RELAY_HOME", &data)], Platform::current());
        assert!(snap);
        let snap = read_statusline_snapshot(
            &|name| (name == "RELAY_HOME").then(|| data.as_os_str().to_owned()),
            home,
            Platform::current(),
        )
        .unwrap();
        statusline_text(
            &snap,
            &StatuslineRun {
                stdin: &stdin,
                config_dir: None,
                home: home.to_path_buf(),
                now: NOW,
                color: false,
            },
        )
    };
    assert_eq!(once(), "Vertex · 5 h 42% · week 18% · renews 14:00");
    let runs = 20;
    let started = Instant::now();
    for _ in 0..runs {
        once();
    }
    let each = started.elapsed().as_secs_f64() * 1000.0 / f64::from(runs);
    assert!(each < 100.0, "{each:.1} ms per line");
}

#[test]
fn the_snapshot_is_found_in_the_app_s_data_folder_on_each_platform() {
    let dir = temp();
    let home = dir.path();
    let (vertex, person) = (uuid(), (uuid(), uuid()));
    let snap = snapshot(&vertex, (&person.0, &person.1));
    write_snapshot(&home.join("Library/Application Support/Relay"), &snap);
    assert!(read(home, &[], Platform::MacOs));
    assert!(!read(home, &[], Platform::Linux));
    write_snapshot(&home.join(".config/Relay"), &snap);
    assert!(read(home, &[], Platform::Linux));
    // XDG_CONFIG_HOME counts only as a POSIX absolute path; a Windows host's temp folder is not one.
    if !cfg!(windows) {
        write_snapshot(&home.join("xdg/Relay"), &snap);
        assert!(read(
            home,
            &[("XDG_CONFIG_HOME", &home.join("xdg"))],
            Platform::Linux
        ));
        assert!(!read(
            home,
            &[("XDG_CONFIG_HOME", &home.join("none"))],
            Platform::Linux
        ));
    }
    write_snapshot(&home.join("Roaming/Relay"), &snap);
    assert!(read(
        home,
        &[("APPDATA", &home.join("Roaming"))],
        Platform::Windows
    ));
    // Another layout, or a file that is not one, reads as no snapshot.
    let mut other = snap.clone();
    other["version"] = json!(99);
    fs::write(
        home.join(".config/Relay").join(STATUSLINE_FILE),
        other.to_string(),
    )
    .unwrap();
    assert!(!read(home, &[], Platform::Linux));
    fs::write(home.join(".config/Relay").join(STATUSLINE_FILE), "{").unwrap();
    assert!(!read(home, &[], Platform::Linux));
}

#[test]
fn relay_statusline_install_uninstall_and_the_line_itself_on_any_platform() {
    let dir = temp();
    let base = relay_core::fs_util::real_path(dir.path()).unwrap();
    let data = base.join("Relay");
    let fixture = |env: Vec<(&'static str, String)>| {
        let mut env = env;
        env.push(("RELAY_HOME", data.to_string_lossy().into_owned()));
        let mut f = cli_fixture(Options {
            env,
            ..Options::default()
        });
        f.deps.transcript_root = base.join(".claude");
        f.deps.platform = Platform::Linux;
        f.deps.self_exe = base.join("bin").join("relay");
        f
    };
    let f = fixture(Vec::new());
    assert_eq!(f.run(&["statusline"]), 0);
    assert!(f.out().contains("Open Relay.app once"));
    let f = fixture(Vec::new());
    assert_eq!(f.run(&["statusline", "install"]), 0);
    assert!(f.out().contains("now shows Relay"));
    // The CLI writes itself by its absolute path: this very binary.
    let settings: Value =
        serde_json::from_str(&fs::read_to_string(base.join(".claude/settings.json")).unwrap())
            .unwrap();
    assert_eq!(
        settings["statusLine"]["command"],
        statusline_command(
            &[base.join("bin").join("relay").to_string_lossy()],
            Platform::current()
        )
    );
    let (vertex, person) = (uuid(), (uuid(), uuid()));
    write_snapshot(&data, &snapshot(&vertex, (&person.0, &person.1)));
    let mut f = fixture(Vec::new());
    f.io.read_input = Some(Arc::new(|| json!({ "session_id": "s1" }).to_string()));
    f.io.now = Arc::new(|| NOW);
    assert_eq!(f.run(&["statusline"]), 0);
    assert_eq!(f.out(), "Vertex · 5 h 42% · week 18% · renews 14:00");
    let f = fixture(vec![("LANG", "tr_TR.UTF-8".into())]);
    assert_eq!(f.run(&["statusline", "uninstall"]), 0);
    assert!(f.out().contains("durum satırından çıkarıldı"));
    let f = fixture(Vec::new());
    assert_eq!(f.run(&["statusline", "remove"]), 2);
    assert!(f.err().contains("relay statusline [install|uninstall]"));
    let f = fixture(Vec::new());
    assert_eq!(f.run(&["statusline", "--json"]), 2);
}

#[test]
fn off_macos_commands_that_open_the_vault_say_they_are_macos_only() {
    for argv in [
        &["switch", "Vertex"][..],
        &["add", "Vertex"],
        &["recover"],
        &["reset-vault"],
        &["history", "sync"],
    ] {
        let mut f = cli_fixture(Options::default());
        f.deps.platform = Platform::Windows;
        assert_eq!(f.run(argv), 5, "{}", argv.join(" "));
        assert!(
            f.err().contains("works on macOS only"),
            "{}",
            argv.join(" ")
        );
    }
}
