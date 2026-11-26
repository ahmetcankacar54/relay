//! Port of tests/diagnostics-bundle.test.ts.

use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use chrono::{Local, TimeZone};
use relay_core::diagnostics_bundle::{
    CRASH_DUMP_NAMES, DiagnosticsBundleInput, ZipEntry, build_diagnostics_bundle,
    newest_crash_dumps, redact_diagnostics, settings_summary, zip_archive,
};
use relay_core::shared::types::{Account, RelaySettings, default_settings};
use serde_json::{Value, json};

fn u16_at(zip: &[u8], at: usize) -> usize {
    usize::from(u16::from_le_bytes([zip[at], zip[at + 1]]))
}

fn u32_at(zip: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(zip[at..at + 4].try_into().unwrap())
}

/// Every file in a zip, read through its central directory as an unzip tool does.
fn unzip(zip: &[u8]) -> Vec<(String, String)> {
    let end = zip
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])
        .expect("end of central directory");
    let count = u16_at(zip, end + 10);
    let mut at = u32_at(zip, end + 16) as usize;
    let mut files = Vec::new();
    for _ in 0..count {
        assert_eq!(u32_at(zip, at), 0x02014b50);
        let method = u16_at(zip, at + 10);
        let crc = u32_at(zip, at + 16);
        let packed_size = u32_at(zip, at + 20) as usize;
        let size = u32_at(zip, at + 24) as usize;
        let name_length = u16_at(zip, at + 28);
        let skip = u16_at(zip, at + 30) + u16_at(zip, at + 32);
        let local = u32_at(zip, at + 42) as usize;
        let name = String::from_utf8(zip[at + 46..at + 46 + name_length].to_vec()).unwrap();
        assert_eq!(u32_at(zip, local), 0x04034b50);
        let start = local + 30 + u16_at(zip, local + 26) + u16_at(zip, local + 28);
        let packed = &zip[start..start + packed_size];
        let data = if method == 8 {
            let mut out = Vec::new();
            flate2::read::DeflateDecoder::new(packed)
                .read_to_end(&mut out)
                .unwrap();
            out
        } else {
            packed.to_vec()
        };
        assert_eq!(data.len(), size, "{name}");
        let mut check = flate2::Crc::new();
        check.update(&data);
        assert_eq!(check.sum(), crc, "{name}");
        files.push((name, String::from_utf8(data).unwrap()));
        at += 46 + name_length + skip;
    }
    files
}

fn has_unzip() -> bool {
    Command::new("unzip")
        .arg("-v")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn folder(prefix: &str) -> tempfile::TempDir {
    tempfile::Builder::new().prefix(prefix).tempdir().unwrap()
}

#[test]
fn the_zip_writer_round_trips_names_bytes_and_an_empty_file() {
    let entries = vec![
        ZipEntry {
            name: "a.txt".into(),
            data: "hello\n".repeat(200).into_bytes(),
        },
        ZipEntry {
            name: "notlar/ğüş.json".into(),
            data: br#"{"ok":true}"#.to_vec(),
        },
        ZipEntry {
            name: "empty.log".into(),
            data: Vec::new(),
        },
    ];
    let at = Local
        .with_ymd_and_hms(2026, 11, 23, 9, 30, 0)
        .unwrap()
        .timestamp_millis();
    let files = unzip(&zip_archive(&entries, at));
    assert_eq!(
        files
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>()
    );
    for (entry, (_, text)) in entries.iter().zip(&files) {
        assert_eq!(text.as_bytes(), entry.data.as_slice());
    }
}

#[test]
fn a_system_unzip_reads_the_archive() {
    if !has_unzip() {
        eprintln!("skipped: no unzip on this machine");
        return;
    }
    let dir = folder("relay-zip-");
    let file = dir.path().join("bundle.zip");
    fs::write(
        &file,
        zip_archive(
            &[ZipEntry {
                name: "summary.json".into(),
                data: b"{}\n".to_vec(),
            }],
            relay_core::clock::now_ms(),
        ),
    )
    .unwrap();
    let test = Command::new("unzip")
        .arg("-t")
        .arg(&file)
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(test.success());
    let out = Command::new("unzip")
        .arg("-p")
        .arg(&file)
        .arg("summary.json")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "{}\n");
}

const EMAIL: &str = "vertex.alto@example.com";
const NAME: &str = "Alto Vertex";
const ORG: &str = "Kestrel Labs";
const SK: &str = "sk-ant-oat01-Abc123Def456Ghi789Jkl012Mno345";
// Short and plain: only the field name gives it away.
const REFRESH: &str = "rt-plain-secret-42";
const BEARER: &str = "short.bearer";

#[test]
fn redaction_masks_emails_account_names_keys_token_fields_and_the_home_folder() {
    let text = [
        format!(
            "2026-11-23T09:00:00.000Z uncaughtException {NAME} ({EMAIL}) failed with {SK}"
        ),
        "  at /Users/alto/Library/Application Support/Relay/vault.ts:1:1".to_owned(),
        format!(
            r#"{{"accessToken": "at-plain", "refreshToken": "{REFRESH}", "account": "alto vertex"}}"#
        ),
        format!("Authorization: Bearer {BEARER}"),
        "https://example.com/cb?code=abc123&state=ok".to_owned(),
        format!("Altogether fine; {ORG} org."),
    ]
    .join("\n");
    let out = redact_diagnostics(&text, &[NAME, ORG, ""], Some("/Users/alto"));
    for secret in [
        EMAIL,
        "Alto Vertex",
        "alto vertex",
        SK,
        REFRESH,
        "at-plain",
        BEARER,
        "abc123",
        ORG,
        "/Users/alto",
    ] {
        assert!(!out.contains(secret), "{secret}");
    }
    assert!(
        out.contains("[account] ([email]) failed with [redacted]"),
        "{out}"
    );
    assert!(out.contains("~/Library/Application Support/Relay"), "{out}");
    // A name is masked as a word, not inside another one.
    assert!(out.contains("Altogether fine; [account] org."), "{out}");
    // Lines and indents stay.
    let lines: Vec<&str> = out.split('\n').collect();
    assert_eq!(lines.len(), 6);
    assert!(lines[1].starts_with("  at "), "{}", lines[1]);
}

fn account(value: Value) -> Account {
    serde_json::from_value(value).unwrap()
}

#[test]
fn the_bundle_holds_redacted_logs_and_a_summary_skips_missing_files_and_carries_no_secret() {
    let dir = folder("relay-diag-");
    let errors = dir.path().join("main-errors.log");
    let issues = dir.path().join("usage-issues.json");
    fs::write(
        &errors,
        format!("2026-11-23T09:00:00.000Z unhandledRejection {NAME} {EMAIL} {SK}\n"),
    )
    .unwrap();
    fs::write(
        &issues,
        json!({
            "version": 1,
            "entries": [{
                "accountId": "a",
                "detail": format!("{EMAIL} refreshToken"),
                "refreshToken": REFRESH,
            }],
        })
        .to_string(),
    )
    .unwrap();
    let accounts = vec![
        account(json!({
            "id": "a", "name": NAME, "kind": "personal", "group": "personal", "color": "#000",
            "createdAt": "",
            "desktop": { "accountUuid": "u", "orgId": "o", "savedAt": "", "email": EMAIL },
        })),
        account(json!({
            "id": "b", "name": "Alto", "kind": "personal", "group": "personal", "color": "#000",
            "createdAt": "", "provider": "codex",
        })),
    ];
    let settings = RelaySettings {
        launch_at_login: Some(true),
        ..default_settings()
    };
    let summary = json!({
        "relay": "0.28.0",
        "settings": settings_summary(&settings, &accounts),
        "crashDumps": ["completed/x.dmp"],
    });
    let missing = dir.path().join("fleet-events.json");
    let files: [&Path; 3] = [&errors, &issues, &missing];
    let names: Vec<String> = accounts.iter().map(|a| a.name.clone()).collect();
    let home = dir.path().to_string_lossy().into_owned();
    let zip = build_diagnostics_bundle(&DiagnosticsBundleInput {
        files: &files,
        summary: &summary,
        names: &names,
        home: Some(&home),
        at_ms: None,
    });
    let files = unzip(&zip);
    assert_eq!(
        files
            .iter()
            .map(|(name, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["main-errors.log", "usage-issues.json", "summary.json"]
    );
    let all = files
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    for secret in [EMAIL, NAME, "Alto", SK, REFRESH] {
        assert!(!all.contains(secret), "{secret}");
    }
    let get = |name: &str| -> Value {
        serde_json::from_str(&files.iter().find(|(n, _)| n == name).unwrap().1).unwrap()
    };
    let summary = get("summary.json");
    assert_eq!(summary["relay"], json!("0.28.0"));
    assert_eq!(
        summary["settings"]["providers"],
        json!({ "claude": 1, "codex": 1 })
    );
    assert_eq!(summary["settings"]["accounts"], json!(2));
    assert_eq!(summary["settings"]["desktopConnected"], json!(1));
    assert_eq!(summary["settings"]["launchAtLogin"], json!(true));
    assert_eq!(summary["crashDumps"], json!(["completed/x.dmp"]));
    // The issues log is still JSON after redaction.
    assert_eq!(
        get("usage-issues.json")["entries"][0]["refreshToken"],
        json!("[redacted]")
    );
}

#[test]
fn the_newest_crash_dump_names_are_listed_newest_first_without_their_contents() {
    let dir = folder("relay-dumps-");
    fs::create_dir(dir.path().join("completed")).unwrap();
    for (i, name) in ["one", "two", "three"].into_iter().enumerate() {
        let file = dir.path().join("completed").join(format!("{name}.dmp"));
        fs::write(&file, "memory").unwrap();
        let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
        relay_core::fs_util::set_times(&file, at).unwrap();
    }
    fs::write(dir.path().join("settings.dat"), "").unwrap();
    assert_eq!(
        newest_crash_dumps(dir.path(), 2),
        ["completed/three.dmp", "completed/two.dmp"]
    );
    assert!(newest_crash_dumps(&dir.path().join("missing"), CRASH_DUMP_NAMES).is_empty());
}
