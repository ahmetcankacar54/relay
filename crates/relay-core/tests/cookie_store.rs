//! Port of `tests/cookie-store.test.ts`.

use std::fs;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use relay_core::cookie_store::{
    CookieSnapshot, CookieStorage, CookieStoreReason, CookieValue, LOGIN_ROWS, SqliteCookieStorage,
    backup_cookie_files, decode_snapshot, encode_snapshot, has_web_login, restore_cookie_files,
    same_login, same_organization, session_created_ms,
};
use relay_core::shared::browser_extension::CLAUDE_EXTENSION_ID;
use rusqlite::Connection;
use tempfile::TempDir;

const COLUMNS: [&str; 20] = [
    "creation_utc",
    "host_key",
    "top_frame_site_key",
    "name",
    "value",
    "encrypted_value",
    "path",
    "expires_utc",
    "is_secure",
    "is_httponly",
    "last_access_utc",
    "has_expires",
    "is_persistent",
    "priority",
    "samesite",
    "source_scheme",
    "source_port",
    "last_update_utc",
    "source_type",
    "has_cross_site_ancestor",
];
const SCHEMA: &str = "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);";
/// Chromium's microseconds since 1601: far past 2^53.
const CREATED: i64 = 13_433_947_693_265_311;

struct Cookie<'a> {
    host: &'a str,
    name: &'a str,
    partition: &'a str,
    httponly: i64,
    secure: i64,
}

fn cookie<'a>(host: &'a str, name: &'a str) -> Cookie<'a> {
    Cookie {
        host,
        name,
        partition: "",
        httponly: 1,
        secure: 1,
    }
}

fn add(db: &Connection, c: &Cookie, tag: &str) {
    let sql = format!(
        "insert into cookies ({}) values ({})",
        COLUMNS.join(","),
        vec!["?"; COLUMNS.len()].join(",")
    );
    let blob = format!("v10{}-{tag}", c.name).into_bytes();
    db.execute(
        &sql,
        rusqlite::params![
            CREATED,
            c.host,
            c.partition,
            c.name,
            "",
            blob,
            "/",
            13_500_000_000_000_000_i64,
            c.secure,
            c.httponly,
            CREATED,
            1,
            1,
            1,
            1,
            2,
            443,
            CREATED,
            0,
            1
        ],
    )
    .unwrap();
}

const LOGIN: [(&str, &str); 8] = [
    ("sessionKey", ".claude.ai"),
    ("sessionKeyLC", ".claude.ai"),
    ("sessionKeyV3", ".claude.ai"),
    ("routingHint", ".claude.ai"),
    ("lastActiveOrg", ".claude.ai"),
    ("__Host-sessionBinding", "claude.ai"),
    ("__Host-ant_trusted_device", "claude.ai"),
    ("activitySessionId", "claude.ai"),
];

fn others() -> Vec<Cookie<'static>> {
    vec![
        Cookie {
            httponly: 0,
            ..cookie("claude.ai", "anthropic-device-id")
        },
        cookie(".claude.ai", "cf_clearance"),
        Cookie {
            partition: "https://claude.ai",
            ..cookie(".claude.ai", "cf_clearance")
        },
        cookie(".claude.ai", "__cf_bm"),
        cookie(".platform.claude.com", "sessionKey"),
        cookie(".bank.example", "session"),
        cookie(".news.example", "uid"),
    ]
}

struct Profile {
    _temp: TempDir,
    dir: PathBuf,
    folder: PathBuf,
}

/// A profile folder with a Chromium-shaped cookie database (version 24) and a
/// device-bound-session database.
fn profile(tag: &str, network: bool, version: &str) -> Profile {
    let temp = tempfile::Builder::new()
        .prefix("relay-cookies-")
        .tempdir()
        .unwrap();
    let dir = temp.path().to_path_buf();
    let folder = if network {
        dir.join("Network")
    } else {
        dir.clone()
    };
    fs::create_dir_all(&folder).unwrap();
    let db = Connection::open(folder.join("Cookies")).unwrap();
    db.execute_batch(SCHEMA).unwrap();
    db.execute(
        "insert into meta (key, value) values ('version', ?)",
        [version],
    )
    .unwrap();
    for (name, host) in LOGIN {
        add(&db, &cookie(host, name), tag);
    }
    let partition = format!("chrome-extension://{CLAUDE_EXTENSION_ID}");
    add(
        &db,
        &Cookie {
            partition: &partition,
            ..cookie("claude.ai", "lastActiveOrg")
        },
        tag,
    );
    for other in others() {
        add(&db, &other, "other");
    }
    drop(db);
    let dbsc = Connection::open(folder.join("Device Bound Sessions")).unwrap();
    dbsc.execute_batch("CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR); CREATE TABLE dbsc_session_tbl ( key TEXT, proto BLOB, PRIMARY KEY(key));").unwrap();
    dbsc.execute(
        "insert into dbsc_session_tbl (key, proto) values (?, ?)",
        rusqlite::params!["https://claude.ai", vec![1u8, 2, 3]],
    )
    .unwrap();
    dbsc.execute(
        "insert into dbsc_session_tbl (key, proto) values (?, ?)",
        rusqlite::params!["https://other.example", vec![9u8]],
    )
    .unwrap();
    Profile {
        _temp: temp,
        dir,
        folder,
    }
}

fn plain(tag: &str) -> Profile {
    profile(tag, false, "24")
}

fn dbsc_keys(folder: &Path) -> Vec<String> {
    let db = Connection::open(folder.join("Device Bound Sessions")).unwrap();
    let mut st = db
        .prepare("select key from dbsc_session_tbl order by key")
        .unwrap();
    st.query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn every_row(folder: &Path) -> Vec<String> {
    let db = Connection::open(folder.join("Cookies")).unwrap();
    let mut st = db
        .prepare("select * from cookies order by host_key, top_frame_site_key, name")
        .unwrap();
    let names: Vec<String> = st.column_names().into_iter().map(str::to_owned).collect();
    st.query_map([], |r| {
        let mut out = Vec::new();
        for (i, name) in names.iter().enumerate() {
            let value = match r.get_ref(i)? {
                rusqlite::types::ValueRef::Integer(n) => format!("{n}n"),
                rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
                rusqlite::types::ValueRef::Blob(b) => {
                    b.iter().map(|x| format!("{x:02x}")).collect()
                }
                other => format!("{other:?}"),
            };
            out.push(format!("\"{name}\":\"{value}\""));
        }
        Ok(out.join(","))
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

fn text(value: Option<&CookieValue>) -> String {
    match value {
        Some(CookieValue::Text(t)) => t.clone(),
        _ => String::new(),
    }
}

fn blob_text(snapshot: &CookieSnapshot) -> String {
    match snapshot.rows[0].get("encrypted_value") {
        Some(CookieValue::Blob(b)) => String::from_utf8_lossy(b).into_owned(),
        other => panic!("{other:?}"),
    }
}

#[test]
fn read_finds_exactly_the_login_rows_in_their_place_and_partition_and_nothing_else() {
    let p = plain("A");
    let snap = SqliteCookieStorage.read(&p.dir).unwrap();
    assert_eq!(snap.version, "24");
    assert_eq!(snap.columns, COLUMNS);
    assert_eq!(snap.rows.len(), LOGIN.len() + 1);
    let names: Vec<String> = snap
        .rows
        .iter()
        .map(|r| {
            let ext = if text(r.get("top_frame_site_key")).is_empty() {
                ""
            } else {
                "ext"
            };
            format!("{}|{ext}|{}", text(r.get("host_key")), text(r.get("name")))
        })
        .collect();
    assert!(names.contains(&"claude.ai|ext|lastActiveOrg".to_owned()));
    assert!(!names.iter().any(|n| {
        [
            "cf_clearance",
            "__cf_bm",
            "device-id",
            "bank",
            "news",
            "platform",
        ]
        .iter()
        .any(|w| n.contains(w))
    }));
    assert!(has_web_login(&snap));
    assert!(snap.unlisted.is_empty());
    // Integers past 2^53 and blobs survive exactly.
    assert_eq!(
        snap.rows[0].get("creation_utc"),
        Some(&CookieValue::Integer(CREATED))
    );
    assert!(matches!(
        snap.rows[0].get("encrypted_value"),
        Some(CookieValue::Blob(_))
    ));
    assert!(session_created_ms(&snap).is_some());
}

#[test]
fn a_login_like_claude_ai_cookie_that_is_not_listed_is_reported_by_name_never_by_value() {
    let p = plain("A");
    let db = Connection::open(p.folder.join("Cookies")).unwrap();
    add(&db, &cookie(".claude.ai", "sessionKeyV9"), "A");
    add(
        &db,
        &Cookie {
            httponly: 0,
            ..cookie(".claude.ai", "theme")
        },
        "A",
    );
    drop(db);
    let snap = SqliteCookieStorage.read(&p.dir).unwrap();
    assert_eq!(snap.unlisted, ["sessionKeyV9"]);
}

#[test]
fn write_puts_the_saved_login_in_place_leaves_every_other_row_byte_identical_and_drops_the_sites_device_bound_session_row()
 {
    let a = plain("A");
    let b = plain("B");
    let saved = SqliteCookieStorage.read(&b.dir).unwrap();
    let other: Vec<String> = every_row(&a.folder)
        .into_iter()
        .filter(|r| {
            !LOGIN
                .iter()
                .any(|(n, _)| r.contains(&format!("\"name\":\"{n}\"")))
                && !r.contains("chrome-extension")
        })
        .collect();
    SqliteCookieStorage.write(&a.dir, &saved).unwrap();
    let after = SqliteCookieStorage.read(&a.dir).unwrap();
    assert_eq!(encode_snapshot(&after), encode_snapshot(&saved));
    assert!(blob_text(&after).ends_with("-B"));
    // Every row that was not the login is exactly as it was.
    let now = every_row(&a.folder);
    for row in &other {
        assert!(now.contains(row), "an unrelated row changed");
    }
    assert_eq!(now.len(), every_row(&b.folder).len());
    assert_eq!(dbsc_keys(&a.folder), ["https://other.example"]);
}

#[test]
fn a_profile_whose_cookies_live_in_network_is_found_there() {
    let p = profile("A", true, "24");
    assert_eq!(
        SqliteCookieStorage.read(&p.dir).unwrap().rows.len(),
        LOGIN.len() + 1
    );
    let snap = SqliteCookieStorage.read(&p.dir).unwrap();
    SqliteCookieStorage.write(&p.dir, &snap).unwrap();
}

#[test]
fn write_refuses_a_database_that_is_not_the_one_the_login_was_saved_from() {
    let a = plain("A");
    let newer = profile("B", false, "25");
    let saved = SqliteCookieStorage.read(&newer.dir).unwrap();
    let error = SqliteCookieStorage.write(&a.dir, &saved).unwrap_err();
    assert_eq!(error.reason, CookieStoreReason::SchemaChanged);
    let detail = error.detail.unwrap();
    assert_eq!(detail["why"], "version");
    assert_eq!(detail["saved"], "25");
    let odd = plain("C");
    let db = Connection::open(odd.folder.join("Cookies")).unwrap();
    // A column that must be filled and has no default: only a rebuilt table can have one.
    let sql: String = db
        .query_row(
            "select sql from sqlite_master where name = 'cookies'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    db.execute_batch("alter table cookies rename to cookies_old")
        .unwrap();
    let rebuilt = format!(
        "{}, needed integer not null)",
        sql.trim_end().strip_suffix(')').unwrap()
    );
    db.execute_batch(&rebuilt).unwrap();
    db.execute_batch("drop table cookies_old").unwrap();
    drop(db);
    let d = plain("D");
    let error = SqliteCookieStorage
        .write(&odd.dir, &SqliteCookieStorage.read(&d.dir).unwrap())
        .unwrap_err();
    assert_eq!(error.reason, CookieStoreReason::SchemaChanged);
    let detail = error.detail.unwrap();
    assert_eq!(
        (detail["why"].as_str(), detail["missing"].as_str()),
        ("columns", "needed")
    );
    // Nothing was written.
    assert!(blob_text(&SqliteCookieStorage.read(&a.dir).unwrap()).ends_with("-A"));
}

#[test]
fn a_login_saved_before_the_browser_added_a_column_with_a_default_is_still_written() {
    let a = plain("A");
    let b = plain("B");
    let saved = SqliteCookieStorage.read(&b.dir).unwrap();
    let db = Connection::open(a.folder.join("Cookies")).unwrap();
    db.execute_batch("alter table cookies add column extra integer not null default 7")
        .unwrap();
    drop(db);
    SqliteCookieStorage.write(&a.dir, &saved).unwrap();
    let after = SqliteCookieStorage.read(&a.dir).unwrap();
    assert!(blob_text(&after).ends_with("-B"));
    assert!(
        after
            .rows
            .iter()
            .all(|row| row.get("extra") == Some(&CookieValue::Integer(7)))
    );
}

#[test]
fn write_refuses_a_database_with_a_pending_journal_and_rows_that_are_not_a_login() {
    let a = plain("A");
    let b = plain("B");
    let saved = SqliteCookieStorage.read(&b.dir).unwrap();
    fs::write(a.folder.join("Cookies-journal"), "hot").unwrap();
    assert_eq!(
        SqliteCookieStorage
            .write(&a.dir, &saved)
            .unwrap_err()
            .reason,
        CookieStoreReason::JournalPending
    );
    fs::remove_file(a.folder.join("Cookies-journal")).unwrap();
    let mut row = saved.rows[0].clone();
    row.insert("host_key".into(), CookieValue::Text(".bank.example".into()));
    row.insert("name".into(), CookieValue::Text("session".into()));
    let bad = CookieSnapshot {
        rows: vec![row],
        ..saved.clone()
    };
    assert_eq!(
        SqliteCookieStorage.write(&a.dir, &bad).unwrap_err().reason,
        CookieStoreReason::Failed
    );
    assert!(
        SqliteCookieStorage
            .write(
                &a.dir,
                &CookieSnapshot {
                    rows: vec![],
                    ..saved
                }
            )
            .is_err()
    );
}

#[test]
fn a_missing_database_is_reported_as_missing_and_a_link_is_refused() {
    let empty = tempfile::Builder::new()
        .prefix("relay-cookies-none-")
        .tempdir()
        .unwrap();
    assert_eq!(
        SqliteCookieStorage.read(empty.path()).unwrap_err().reason,
        CookieStoreReason::Missing
    );
    #[cfg(unix)]
    {
        let a = plain("A");
        fs::rename(a.folder.join("Cookies"), a.folder.join("Real")).unwrap();
        std::os::unix::fs::symlink(a.folder.join("Real"), a.folder.join("Cookies")).unwrap();
        assert!(SqliteCookieStorage.read(&a.dir).is_err());
    }
}

#[test]
fn a_failed_write_is_undone_by_the_backup_of_the_cookie_files() {
    let a = plain("A");
    let scratch = tempfile::Builder::new()
        .prefix("relay-cookies-scratch-")
        .tempdir()
        .unwrap();
    let before = every_row(&a.folder);
    let backup = backup_cookie_files(&a.dir, scratch.path()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&backup).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    let b = plain("B");
    SqliteCookieStorage
        .write(&a.dir, &SqliteCookieStorage.read(&b.dir).unwrap())
        .unwrap();
    assert_ne!(every_row(&a.folder), before);
    fs::write(a.folder.join("Cookies-journal"), "left behind").unwrap();
    restore_cookie_files(&a.dir, &backup).unwrap();
    assert_eq!(every_row(&a.folder), before);
    assert_eq!(
        dbsc_keys(&a.folder),
        ["https://claude.ai", "https://other.example"]
    );
    assert!(
        !a.folder.join("Cookies-journal").exists(),
        "a journal the backup lacked is removed"
    );
}

#[test]
#[cfg(unix)]
fn a_backup_refuses_cookie_files_that_are_links() {
    let a = plain("A");
    let scratch = tempfile::Builder::new()
        .prefix("relay-cookies-scratch-")
        .tempdir()
        .unwrap();
    fs::rename(a.folder.join("Cookies"), a.folder.join("Real")).unwrap();
    std::os::unix::fs::symlink(a.folder.join("Real"), a.folder.join("Cookies")).unwrap();
    assert!(backup_cookie_files(&a.dir, scratch.path()).is_err());
}

#[test]
fn a_saved_login_encodes_to_json_text_and_decodes_to_the_same_rows_foreign_rows_never_decode() {
    let p = plain("A");
    let snap = SqliteCookieStorage.read(&p.dir).unwrap();
    let text = encode_snapshot(&snap).to_string();
    let back = decode_snapshot(&serde_json::from_str(&text).unwrap()).unwrap();
    assert_eq!(encode_snapshot(&back), encode_snapshot(&snap));
    assert_eq!(
        back.rows[0].get("creation_utc"),
        Some(&CookieValue::Integer(CREATED))
    );
    assert!(matches!(
        back.rows[0].get("encrypted_value"),
        Some(CookieValue::Blob(_))
    ));
    let mut foreign: serde_json::Value = serde_json::from_str(&text).unwrap();
    foreign["rows"][0]["host_key"] = ".bank.example".into();
    assert!(decode_snapshot(&foreign).is_err());
    let mut injected: serde_json::Value = serde_json::from_str(&text).unwrap();
    injected["columns"]
        .as_array_mut()
        .unwrap()
        .push("x; drop table cookies".into());
    assert!(decode_snapshot(&injected).is_err());
    assert!(decode_snapshot(&serde_json::json!({})).is_err());
    assert!(
        LOGIN_ROWS
            .iter()
            .all(|l| l.host == "claude.ai" || l.host == ".claude.ai")
    );
}

#[test]
fn sqlite_is_available_here() {
    assert!(SqliteCookieStorage.available());
}

#[test]
fn two_snapshots_are_the_same_login_by_the_sessions_creation_time_and_on_one_organization_by_its_bytes()
 {
    let row = |name: &str, created: i64, value: &str| -> IndexMap<String, CookieValue> {
        let host = if name == "lastActiveOrg" || name == "sessionKey" {
            ".claude.ai"
        } else {
            "claude.ai"
        };
        IndexMap::from([
            ("creation_utc".to_owned(), CookieValue::Integer(created)),
            ("host_key".to_owned(), CookieValue::Text(host.into())),
            (
                "top_frame_site_key".to_owned(),
                CookieValue::Text(String::new()),
            ),
            ("name".to_owned(), CookieValue::Text(name.into())),
            (
                "encrypted_value".to_owned(),
                CookieValue::Blob(value.as_bytes().to_vec()),
            ),
        ])
    };
    let snap = |created: i64, session: &str, org: Option<&str>| CookieSnapshot {
        version: "24".into(),
        columns: [
            "creation_utc",
            "host_key",
            "top_frame_site_key",
            "name",
            "encrypted_value",
        ]
        .map(str::to_owned)
        .to_vec(),
        rows: std::iter::once(row("sessionKey", created, session))
            .chain(org.map(|o| row("lastActiveOrg", created, o)))
            .collect(),
        unlisted: vec![],
    };
    // The server set the session again (new bytes): the browser kept its creation time.
    assert!(same_login(&snap(10, "v10a", None), &snap(10, "v10b", None)));
    assert!(!same_login(
        &snap(10, "v10a", None),
        &snap(11, "v10a", None)
    ));
    assert!(!same_login(
        &snap(10, "v10a", None),
        &CookieSnapshot {
            rows: vec![],
            ..snap(10, "v10a", None)
        }
    ));
    assert!(same_organization(
        &snap(1, "x", Some("v10ORG")),
        &snap(2, "y", Some("v10ORG"))
    ));
    assert!(!same_organization(
        &snap(1, "x", Some("v10ORG")),
        &snap(2, "y", Some("v10OTHER"))
    ));
    assert!(!same_organization(
        &snap(1, "x", None),
        &snap(2, "y", Some("v10ORG"))
    ));
}
