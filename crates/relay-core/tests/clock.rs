//! The pinned parity clock: `RELAY_PARITY_NOW` starts the clock at that instant in debug builds.

use std::process::Command;

use relay_core::clock::now_ms;
use relay_core::fs_util::parse_iso_ms;

#[test]
#[ignore = "prints the clock for the pinned-clock test, in its own process"]
fn clock_child() {
    if std::env::var_os("RELAY_PARITY_NOW").is_some() {
        let first = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(30));
        println!("clock {first} {}", now_ms());
    }
}

#[cfg(debug_assertions)]
#[test]
fn relay_parity_now_pins_the_clock_and_lets_it_advance() {
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["clock_child", "--exact", "--ignored", "--nocapture"])
        .env("RELAY_PARITY_NOW", "2026-01-01T00:00:00.000Z")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find_map(|l| l.split("clock ").nth(1)).unwrap();
    let times: Vec<i64> = line.split(' ').map(|t| t.parse().unwrap()).collect();
    let base = parse_iso_ms("2026-01-01T00:00:00.000Z").unwrap();
    assert!((base..base + 5_000).contains(&times[0]), "{times:?}");
    assert!(times[1] >= times[0] + 30, "{times:?}");
}

#[test]
fn without_the_variable_the_clock_is_the_system_clock() {
    let system = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    if std::env::var_os("RELAY_PARITY_NOW").is_none() {
        assert!((now_ms() - system).abs() < 5_000);
    }
}
